# Orchestration plan — Roomy PoC

Runbook for a Sonnet 5 orchestrator session running in the Claude Code desktop app
(you need its Browser pane for one wave gate). Tickets live in `docs/tickets/`. Read a
ticket only when dispatching it. Design context you may need: `CLAUDE.md`,
`BACKLOG.md`, `docs/pipeline.md`.

Your job is process: dispatch, watch, evaluate, merge, recover. You do not implement.

## Goal

Take Roomy from a single-tab demo to a multi-participant PoC with a responsive
journal pipeline, tuned prompts, export, steering, and a hardened ingest path — eight
tickets in four waves, each merged to `main` only after an Opus 5 evaluator has
confirmed faithfulness to the ticket, test coverage of its acceptance criteria, and
architectural cleanliness, repairing where it can.

## Two worker kinds

| Role | Runtime | Model | Image |
|---|---|---|---|
| Implementer | `codex exec` in Docker | `gpt-5.6-luna`, `model_reasoning_effort=max` | `roomy-worker-codex` |
| Implementer, escalation | `codex exec` in Docker | `gpt-5.6-sol`, `model_reasoning_effort=xhigh` | `roomy-worker-codex` |
| Evaluator | `claude -p` in Docker | `claude-opus-5` | `roomy-worker-claude` |
| Orchestrator escalation | your own `Agent` tool, fresh session | `claude-opus-5` | none (read-only decisions) |

Session strategy is **fresh** for every ticket. There is no cross-container session
forking between Codex and Claude, and the repo is under a thousand lines — tickets carry
everything a fresh session needs. No shared-read fork groups.

## Sandbox

Every worker is a headless process inside `docker run` — NOT an in-process Agent-tool
subagent. Mechanics below are the load-bearing details; deviations are failure modes.

**Images** — `docs/orchestration/Dockerfile.codex`, `docs/orchestration/Dockerfile.claude`.
Both run as the non-root `node` user with `git safe.directory '*'`. Build once:

```bash
docker build -q -f docs/orchestration/Dockerfile.codex  -t roomy-worker-codex  .
docker build -q -f docs/orchestration/Dockerfile.claude -t roomy-worker-claude .
```

**Preflight** — a human runs `docs/orchestration/preflight.sh` once before you start.
It builds the images, proves both worker kinds can authenticate and act, and checks the
app's LLM backend (`ROOMY_LLM`) so a bad setup fails here, not in Wave 1. If the human
has not reported `PREFLIGHT OK`, STOP and ask; do not improvise auth.

**Auth.**
- Codex: `~/.codex/auth.json` on the host (ChatGPT login). Copy it into a per-worker
  directory mounted read-write at `/home/node/.codex` so token refresh can write.
  Re-copy from the host for every dispatch; the host copy is the source of truth.
- Claude: `CLAUDE_CODE_OAUTH_TOKEN` forwarded with `-e` to **both** worker kinds — the
  evaluator uses it directly, and the app under test uses it through the `claude` CLI
  when `ROOMY_LLM=cli` (the default for this run; `src/transport.ts`). **Never forward
  `ANTHROPIC_API_KEY`** — it outranks the OAuth token inside `claude` and silently moves
  everything to metered billing. Forward `ROOMY_LLM` to both kinds. Only if the human
  chose `ROOMY_LLM=api` forward `ROOMY_ANTHROPIC_API_KEY` as well.
- The token must come from a Pro/Max login. If the human's own Claude Code uses an
  `apiKeyHelper` (`claude auth status` → `authMethod: api_key`), `claude setup-token`
  still mints a subscription token after `/login`; the helper only affects their shell.
- Network: never `--network none`; both CLIs hang forever with empty logs.

**Run directory.** `RUN=$HOME/.roomy-run`; clones in `$RUN/clones/<id>`, Codex homes in
`$RUN/codex-home-<id>`. Mount every clone at the canonical `/work`.

**Dispatch an implementer** — a local clone, NEVER a worktree (a worktree's `.git` file
points at the host repo by absolute path and is not a repository inside the container):

```bash
git clone -q <repo> $RUN/clones/<id> && cd $RUN/clones/<id> \
  && git checkout -q -b ticket/<id> <wave-base-commit> \
  && git config user.email <id>@run && git config user.name "Worker <id>"
mkdir -p $RUN/codex-home-<id> && cp ~/.codex/auth.json $RUN/codex-home-<id>/
docker run -d --name <id> \
  -v $RUN/clones/<id>:/work -v <repo>/docs/tickets:/tickets:ro \
  -v $RUN/codex-home-<id>:/home/node/.codex \
  -e CLAUDE_CODE_OAUTH_TOKEN -e ROOMY_LLM -w /work \
  roomy-worker-codex codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral \
  -m gpt-5.6-luna -c model_reasoning_effort=max \
  -o /home/node/.codex/last-message.md \
  "Read /tickets/<id>.md and execute it. Work only on the current branch. Run the ticket's Verify commands. Commit your work with a clear message. Your final message must be the completion report the ticket asks for."
```

Escalation dispatch is identical with `-m gpt-5.6-sol -c model_reasoning_effort=xhigh`
and the evaluator's diagnosis appended to the prompt.

**Dispatch an evaluator** — same clone, same mount, the Claude image:

```bash
docker run -d --name eval-<id> \
  -v $RUN/clones/<id>:/work -v <repo>/docs/tickets:/tickets:ro \
  -e CLAUDE_CODE_OAUTH_TOKEN -e ROOMY_LLM -w /work \
  roomy-worker-claude claude -p "You are the evaluator for ticket /tickets/<id>.md. The branch in /work contains an implementer's attempt; the base is <wave-base-commit>. Judge it against the ticket and nothing else, on three axes: (1) faithfulness — every acceptance criterion met as written; (2) testing — each criterion is covered by an automated test that would fail if the work were wrong, and no test touches the network; (3) architectural cleanliness — CLAUDE.md rules and the frozen contracts in BACKLOG.md hold, no unrequested abstraction, no scope creep. Repair is the default: fix anything within the ticket's scope yourself, including missing tests, and commit your repairs on this branch. Reject only with a written repair-versus-redo estimate concluding redo is cheaper. Run the ticket's Verify commands last. Your final message is a report: verdict PASS or REJECT, what you repaired, files touched beyond the ticket's claim, and the estimate if rejecting." \
  --model claude-opus-5 --dangerously-skip-permissions
```

**Watchdog** — no GNU `timeout` on macOS; deadline loop. Budget 1800 s for implementers
at max effort, 1200 s for evaluators, 2700 s for T3:

```bash
deadline=$((SECONDS+1800))
until [ "$(docker inspect <id> --format '{{.State.Status}}')" = "exited" ] \
  || [ $SECONDS -gt $deadline ]; do sleep 10; done
```

**Acceptance probe** — exit code 0 is NOT success. A worker is done only when all hold:

```bash
docker inspect <id> --format 'exit={{.State.ExitCode}}'                     # context only
test -z "$(git -C $RUN/clones/<id> status --porcelain)"                     # clean tree
test "$(git -C $RUN/clones/<id> rev-list --count <wave-base-commit>..ticket/<id>)" -ge 1
cat $RUN/codex-home-<id>/last-message.md                                    # implementer report
docker logs eval-<id> 2>&1 | tail -40                                       # evaluator report
```

**Harvest and merge** (then, and only then, remove containers):

```bash
git -C <repo> fetch $RUN/clones/<id> ticket/<id>:ticket/<id>
git -C <repo> merge --no-ff ticket/<id> -m "merge <id>"
docker rm <id> eval-<id>; rm -rf $RUN/clones/<id> $RUN/codex-home-<id>
```

**Failure taxonomy**

| Signature | Meaning | Response |
|---|---|---|
| codex: log mentions login / 401 / `not authenticated` | auth.json copy stale or refresh token rotated by another worker | on host run `codex login status`; if healthy re-copy auth.json and re-dispatch; if not, human re-logs in. If this recurs across workers, ask the human to switch Codex auth to `OPENAI_API_KEY` (metered) and record the decision here |
| codex: exit 0, zero commits, log shows it asked a question | it wanted approval despite the bypass flag, or the ticket was underspecified | read the question; if ticket gap, fix the ticket and re-dispatch; else re-dispatch with the answer appended |
| codex: log `unknown model` | model id wrong for this account | verify with `codex exec -m gpt-5.6-luna "ok"` on host; fix id |
| claude: exit 1, `Not logged in` | token unset in container or expired | fix `-e`; if expired, human re-mints via `claude setup-token` |
| claude: exit 1, root/sudo error | image runs as root | fix image `USER`, rebuild |
| either: past deadline, logs empty, `docker exec <id> ps aux` shows ~0% CPU | no route to the API | `docker kill`, check egress, re-dispatch |
| either: past deadline, logs active | slow, not hung | read logs; extend once, or kill and re-split |
| either: exit 0, zero commits ahead | failed without failing | read full logs; fix dispatch or ticket; re-dispatch |
| exit 137 unrequested | OOM or external kill | `docker inspect --format '{{.State.OOMKilled}}'`; raise memory |
| implementer or evaluator report: `npm run eval` failed with `credit balance` / 402 / `billing` (only when `ROOMY_LLM=api`) | the app's API account ran out of prepaid credit | the human's problem, not a ticket failure: STOP dispatching anything that runs evals, mark the ticket `blocked (billing)`, ask the human, re-dispatch. Tests-only tickets may continue |
| any claude process: 429, `rate limit`, or `usage limit reached … resets at` | the subscription's 5-hour window is exhausted — evaluators and `ROOMY_LLM=cli` evals share it | not a failure: note the reset time, let running Codex implementers finish (they do not use it), dispatch no evaluator or eval-running ticket until the reset, then continue. Log the pause here |
| `claude cli failed … apiKeyHelper` in an eval report | the worker inherited a settings file with an `apiKeyHelper` | workers must not mount `~/.claude`; check the dispatch mounts |
| evaluator PASS but `npm test` fails on merged `main` | wave-gate collision or environment drift | serialize; rebase the later branch; re-run its evaluator |

**Recovery invariant.** Before any re-dispatch:
`git -C $RUN/clones/<id> reset --hard ticket/<id> && git clean -fd`, or delete and
re-clone. Containers are removed only after their reports are harvested into the ticket's
status note.

Workers do not ask for confirmation. The container is disposable; the branch is the unit
of review. Running a worker outside a container is permitted only as an explicit fallback
decision logged under Status below — never a silent downgrade.

## Standing rules

- One local clone per ticket on `ticket/<id>`. Never a worktree.
- Ticket status is authoritative in the ticket file (`**Status:**` line); mirror it in
  the wave tables here. Update both at every transition.
- Merge target is `main`. Merge each ticket as soon as its evaluator passes.
- Before a wave's merges land, and again after the last merge of the wave, run the
  repo-wide gate on a clean clone of `main`:
  `npm ci && npm run typecheck && npm test`
  Tests never touch the network; if the gate needs a key, something is wrong — stop.
- Eval reports (`npm run eval`) are evidence attached to reports, never a merge gate.
  The one exception is T5, whose whole purpose is those reports; its evaluator reads them.
- Unpredicted file collision between concurrent tickets: serialize. Let the first merge,
  rebase the second onto `main`, re-run its evaluator, record the miss here.

## Failure policy

1. Evaluator finds problems → it repairs in place within the ticket's scope and
   re-verifies. Repair is the default; rejecting forfeits both spends.
2. Evaluator rejects with a redo estimate, or the implementer produced nothing usable
   twice → re-dispatch at the escalation tier (`gpt-5.6-sol @ xhigh`) in a fresh clone,
   with the evaluator's diagnosis appended to the prompt — not the failed diff.
3. Fails at the escalation tier → stop that ticket. Mark it `blocked`, record why, and
   raise it at the next checkpoint. No third retry. Other tickets continue.

**Orchestrator escalation.** Process problems — an untangleable merge, tickets that
contradict each other at a seam, a wave that no longer matches the repo — spawn a fresh
`claude-opus-5` session via your Agent tool, hand it: the plan, the tickets involved, the
diff or conflict, and the specific decision needed. Take its decision, log it, continue.
Do not improvise a design decision you were not given. Do not stall waiting for a human
unless auth or preflight is the blocker.

## Wave 1 — the proof surface · branches from `main` at the commit that added this plan

Parallel: T1, T2 — file claims disjoint except `src/room.ts`, where the tickets are
scoped to different regions (T1: constructor, LLM seam, tick method; T2: subscribe,
presence). Expect a clean merge; if not, T1 merges first.

| Ticket | Nature | Model | Session | Branch | Evaluator | Status |
|---|---|---|---|---|---|---|
| T1 | Stub-LLM acceptance suite + offline eval reports | gpt-5.6-luna@max | fresh | ticket/T1 | claude-opus-5 | merged |
| T2 | Rooms, participant identity, presence, reaping | gpt-5.6-luna@max | fresh | ticket/T2 | claude-opus-5 | merged |

**Checkpoint C1 — verification.** Evaluator per ticket, dispatched per Sandbox. Merge on
PASS. Then the repo-wide gate. T1's evaluator also runs `npm run eval -- incident-review`
once (through the configured `ROOMY_LLM` backend) and attaches the summary line — that is the
harness's own smoke test.

## Wave 2 — the journal · branches from `main` after C1

Parallel: T3, T4 — T3 owns `src/`, T4 owns `public/index.html`. Disjoint.

| Ticket | Nature | Model | Session | Branch | Evaluator | Status |
|---|---|---|---|---|---|---|
| T3 | Replace the tick loop with the journal pipeline | gpt-5.6-luna@max | fresh | ticket/T3 | claude-opus-5 | merged |
| T4 | Client visual pass | gpt-5.6-luna@max | fresh | ticket/T4 | claude-opus-5 | merged |

**Checkpoint C2 — verification.** As C1. T3's evaluator must additionally confirm the
three invariants from `docs/pipeline.md` are each pinned by a test that would fail if the
invariant broke — read the tests, not just their names.

**Checkpoint C2b — the look.** After both merge: on the host, `npm run dev`, open the
Browser pane at `http://localhost:3000`, let it redirect to a room, set a name, replay
`incident-review` at 12×. Take screenshots at 1400 px and 900 px widths after the canvas
has settled, then open a second tab on the same room with a different name and confirm
presence shows both. Judge T4's own 1400/900 description against what you see. If it
does not hold, write `docs/tickets/T4b.md` (fresh ticket, same shape as T4, listing the
specific gaps with your screenshots described) and run it through the normal dispatch
and evaluation before Wave 3. Record the outcome here.

## Wave 3 — quality and output · branches from `main` after C2/C2b

Parallel: T5, T6 — T5 owns `src/prompt.ts` and cadence constants; T6 owns
`src/server.ts`, `public/index.html`. Both may touch `src/room.ts` in named, tiny,
disjoint ways. Expect a clean merge; if not, T5 merges first.

| Ticket | Nature | Model | Session | Branch | Evaluator | Status |
|---|---|---|---|---|---|---|
| T5 | Prompt hillclimb on diagram choice; restructure earns its cost | gpt-5.6-luna@max | fresh | ticket/T5 | claude-opus-5 | merged |
| T6 | Self-contained HTML export | gpt-5.6-luna@max | fresh | ticket/T6 | claude-opus-5 | merged |

**Checkpoint C3 — verification.** As C1. T5 is judged on its attached eval reports
(two per fixture) against the bar in the ticket; the evaluator may run one more eval per
fixture itself if the attached ones are borderline, and must not fail T5 for a single
non-deterministic miss if the second run passes.

**Checkpoint C3b — replan.** Trigger: Wave 3 merged. Spawn a fresh `claude-opus-5`
session via your Agent tool; it re-enters the `create-implementation-plan` skill with:
`docs/pipeline.md`, T3's completion report (specifically the amend-would-have-mattered
counts), T5's report, and the merged `main`. Decision: whether **amend** (the deferred
item in `BACKLOG.md`) is worth a ticket now — if the count is more than a handful per
fixture, it appends `T9 — amend` to Wave 4 with T7/T8 file-claim checks; if not, it
records the decision in `BACKLOG.md`'s deferred list with the numbers. Either way Wave 4
proceeds.

## Wave 4 — extension · branches from `main` after C3/C3b

Parallel: T7, T8 (and T9 if C3b added it — the replanner states its claims). T7 owns
`src/room.ts`, `src/prompt.ts`, `public/index.html`; T8 owns `src/server.ts`, `CLAUDE.md`.

| Ticket | Nature | Model | Session | Branch | Evaluator | Status |
|---|---|---|---|---|---|---|
| T7 | Steering Roomy by direct address | gpt-5.6-luna@max | fresh | ticket/T7 | claude-opus-5 | not-started |
| T8 | Authenticated external ingest route + demo script | gpt-5.6-luna@max | fresh | ticket/T8 | claude-opus-5 | not-started |

**Checkpoint C4 — verification.** As C1. T8's evaluator is raised to "hard to undo"
scrutiny: it touched an authentication path; it must confirm constant-time comparison,
the 404-when-unset behaviour, and that the browser route is unchanged.

**Checkpoint C-final — close the ledger.** Trigger: Wave 4 merged. Spawn a fresh
`claude-opus-5` session to: run the repo-wide gate on a clean clone; run all three evals
once and attach the summary lines; update `BACKLOG.md` so every ticket is marked done or
blocked with a one-line outcome and the deferred list reflects C3b; confirm `CLAUDE.md`
"Shape" and "Rules" still describe the code; commit as "Close out orchestration run".
Then the run is over. Report to the human: what merged, what blocked, the eval lines,
and the C2b screenshots' verdict.

## Status

Preflight: PREFLIGHT OK. Dispatch goes through `docs/orchestration/dispatch.sh` (whitelisted); the
safety classifier blocks raw `docker run` with the bypass flags. Fallback decisions: none.

- Wave 1: T1, T2 merged (evaluators PASS after repair); gate green on main (31 tests).
- Finding: Codex and Claude Code both scrub credentials from subprocess env, so `npm run eval`
  with `ROOMY_LLM=cli` cannot authenticate inside any worker. Real evals run on the HOST by the
  orchestrator (from a clean clone of the branch or main) and are attached as evidence.
- zsh gotcha: write `${id}` not `$id` before a colon (`$id:refs` is a zsh modifier).
- Wave 2: T3, T4 merged (evaluators PASS after repair); gate green (55 tests). C1 host eval smoke:
  incident-review 15 calls, 13 ops applied, 0 rejected, 377 s wall (cli backend).
- C2b (real browser): FAILED first look — mermaid error nodes leaked into document.body (27 after one
  replay) and failed blocks re-rendered every update. Wrote `docs/tickets/T4b.md`, dispatched, PASS,
  merged (59 tests). Re-look: 0 leaks; 1400px = three-column dense grid of content-sized cards, 900px =
  single column with rail below; presence shows "2 here" with a second participant. Remaining defect
  is content, not client: the LLM's `timeline` uses quoted `"14:02"` periods, which mermaid rejects;
  recorded in T5 as the first thing to fix.
- Amend evidence (T3 report): amend-would-have-mattered = 0 on all three fixtures.
- Fallback decision (Wave 3): T5 needs a live LLM to hill-climb and no container can reach one
  (credentials are scrubbed). T5 runs as an in-process opus agent on the host in its own clone
  (never a worktree); its evaluator still runs in Docker and reads the attached eval reports.
- Wave 3: T6 merged first (evaluator repaired epoch-anchored export timestamps and dark-mode diagrams),
  then T5 (host agent per the fallback above; evaluator in Docker read six attached eval reports, PASS
  after repair). Gate green, 71 tests, clean merge in src/room.ts. T5 evals: 2/2 per fixture, 0 rejected
  ops in all six; timeline colon failure gone. Restructure deleted a stale block in 1 of 6 final runs.
- C3b decision (applied by the orchestrator, the rule being numeric): amend-would-have-mattered = 0 on
  all three fixtures (min same-speaker gap 7 s, 13 s, 14 s) -> no T9; recorded in BACKLOG deferred list.
