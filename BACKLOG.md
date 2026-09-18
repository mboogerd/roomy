# Roomy backlog

Written to be executed by agents with little supervision. Read CLAUDE.md first.
The live pipeline is specified in `docs/pipeline.md`; T3 implements it.

## Where this is going

Roomy is not integrated into a meeting tool and does not need to be. Each participant
opens Roomy in their own browser alongside whatever call they are on — Teams, a Slack
huddle, Meet, or laptops around a table. Each browser transcribes exactly one person, so
**speaker identity comes from the connection**. Diarization, which is the hard part of the
real product, is free as long as the architecture keeps one browser to one speaker.

That is the whole integration story. Build toward it.

## Frozen contracts

Do not change these without a human. Every ticket below assumes they hold.

1. `Block` and `Op` in `src/canvas.ts`. Blocks are `mermaid` or `markdown`. Upserts carry
   full source. Ids are kebab-case and stable across revisions.
2. The LLM emits ops and nothing else. No HTML from the model, ever.
3. The browser decides what renders. `validateOp` stays shallow; `/render-error` is the
   feedback path. Do not add a server-side mermaid renderer.
4. All prompt text lives in `src/prompt.ts`.
5. **`Room.say(utterance)` is the only way transcript enters the system.** Everything
   upstream of it is a pluggable source: fixture replay, a browser mic, and later a meeting
   bot all converge on that one call. Never let a transcript source reach into `Room`'s
   internals, and never add a second ingest path. This seam is what makes the meeting-tool
   transition cheap — protect it.
6. The three journal invariants in `docs/pipeline.md`, once T3 lands.
7. No database, no auth, no build step for the client.

## Definition of done, every ticket

- `npm test` and `npm run typecheck` pass.
- The behaviour is demonstrated against a fixture, not asserted in prose. Say which
  fixture and what you observed.
- New non-trivial logic leaves one runnable check in `test/`.
- Deliberate shortcuts carry a `ponytail:` comment naming the ceiling and the upgrade path.

---

## Wave 1 — parallel

### T1 · Offline eval harness
**Files:** new `src/eval.ts`, `package.json` (one script line)
Run a fixture end to end with no server and no browser: feed utterances through the same
`Room` logic, dump the final canvas to `evals/<fixture>-<timestamp>.md` (mermaid sources
in fenced blocks, so a human can skim it), and print a one-line summary — LLM calls made,
ops applied, ops rejected with reasons, blocks by kind, wall time, token usage.

Real timing is pointless here: drive `Room` directly rather than sleeping through a replay.
The harness must not require a running server. Keep the harness's coupling to `Room` to
`say()` and a way to wait for quiescence — T3 rewrites `Room`'s internals and will need to
keep this harness working.

**Done when:** `npm run eval -- architecture-debate` writes a readable report for all three
fixtures and prints the rejected-op reasons. Include the three reports in your summary.
**Do not:** build a scoring model, an LLM judge, or a comparison UI. Reading the output is the eval.

### T2 · Rooms, participants, and free diarization
**Files:** `src/server.ts`, `src/room.ts` (subscribe/presence only), `public/index.html`
This turns a single-tab demo into something a group can use, and it is the foundation for
every meeting-tool scenario. Read "Where this is going" above first.

- `/r/<slug>` creates or joins a room. `/` redirects to a freshly generated slug. Each room
  is its own `Room` instance with its own SSE stream, canvas and transcript.
- A participant sets their name once; it persists in `localStorage` and is sent with every
  utterance and on the SSE connection. **The speaker on an utterance is the identity of the
  connection that sent it** — that is the whole diarization story, do not do anything cleverer.
- Presence: the room knows who is connected and the client shows it. Departures included.
- Rooms with no subscribers for ten minutes are dropped, timer and all.
- Replay targets a specific room.

Stay out of the tick loop in `room.ts`; T3 replaces it next wave.

**Done when:** two browser windows on the same slug, with different names, see one shared
canvas; utterances from each are attributed correctly in the transcript and in the
resulting diagrams; two windows on different slugs do not interfere; a room is reaped
after its last participant leaves. Show a canvas built from a two-window conversation.
**Do not:** add auth, accounts, persistence, a room list page, or a lobby. Slugs are
unguessable enough for a PoC — say so in a `ponytail:` comment rather than building access control.

---

## Wave 2 — parallel, after Wave 1

### T3 · Replace the tick loop with the journal
**Files:** `src/room.ts`, `src/prompt.ts` (additive: a speculate prompt), `src/llm.ts`, `src/eval.ts`
Implement `docs/pipeline.md`. Read it twice. The three invariants are the acceptance
criteria; everything else in the doc is guidance.

Scope for this ticket: journal, segmentation policy, speculate, commit, carry-forward.
**Not amend** — leave a `ponytail:` comment where it would go, and report how often a
segment closed early enough that amend would have helped.

The timer, `MIN_NEW_CHARS`, and the raw-utterance window go away. `RESTRUCTURE_EVERY`
stays, re-expressed as "every N commits". `Room.say()` and `subscribe()` keep their
signatures; the SSE `state` message keeps its shape. Clients cannot tell the difference
except that the canvas moves sooner.

The eval harness from T1 is how you prove it. Add to its summary: segments committed,
segments carried forward, speculative calls made, speculative results discarded as stale.

**Done when:** all three fixtures replay through the journal with zero rejected ops; a
`test/journal.test.ts` exercises segmentation and carry-forward with a stubbed LLM (no
network); the eval summary shows speculative calls coalescing under fast replay rather than
queueing; and you demonstrate invariant 2 by showing that an unchanged block keeps its
exact source across three consecutive speculations.
**Do not:** implement amend, per-speaker live heads, or any delta computation between op sets.

### T4 · Client visual pass
**Files:** `public/index.html`
Depends on T2. The canvas renders as a plain vertical stack. Make it read like a shared
board several people are watching at once: diagrams sized to their content rather than all
full-width, a denser layout on wide screens, a clear but not annoying signal for what just
changed, a transcript comfortable to read for twenty minutes, and presence that is visible
without being the focus. Mic button needs a visible recording state and a clear message
when the browser has no Web Speech API.

**Done when:** replay each fixture and describe how the board looks at 1400px and 900px,
with two participants connected. No new dependencies; mermaid stays the only CDN import.
**Do not:** add a framework, a build step, drag-and-drop, or hand-editing of blocks.

---

## Wave 3 — parallel, after Wave 2

### T5 · Prompt hillclimb, and make the restructure pass earn its cost
**Files:** `src/prompt.ts`, cadence constants in `src/room.ts`
Depends on T1 and T3 — tuning the prompt before the loop was rewritten would have meant
tuning it twice.

Part one, diagram choice. The model over-reaches for markdown and under-uses sequence,
state and class diagrams. Using the eval harness, iterate until each fixture produces at
least one diagram a participant would recognise as the shape of their own conversation:
the architecture debate a deliberation structure showing the disagreement, the brainstorm a
mindmap reflecting the late regrouping, the incident review a timeline or sequence plus
causes. Utterances carry real per-person identity now; positions on the canvas should be
attributable to the people who hold them. Speculate and commit prompts may diverge.

Part two, restructure. The Sonnet pass has never been observed. Verify it fires, verify it
improves the canvas rather than churning it. Ids for surviving ideas must be preserved,
stale blocks must actually get deleted, and it must not fire when the canvas has not
meaningfully grown since the last time.

Record what you tried, including what made things worse.

**Done when:** all three fixtures hit the diagram bar with zero rejected ops; a before/after
canvas across a restructure on two fixtures; `npm test` passes.
**Do not:** add diagram types beyond `MERMAID_HEADS`, a third model tier, or a separate
restructure pipeline.

### T6 · Export the canvas
**Files:** `src/server.ts`, `public/index.html`
`GET /r/<slug>/export` returns a single self-contained HTML file: the canvas as it stands,
diagrams already rendered to inline SVG, plus the transcript and who was present. It must
open correctly with no network access. This is how a meeting's output leaves Roomy.

**Done when:** an exported file from each fixture opens offline and matches what was on screen.
**Do not:** add PDF, image export, or a sharing backend.

---

## Wave 4 — after Wave 3

### T7 · Steering Roomy from the room
**Files:** `src/room.ts`, `src/prompt.ts`, `public/index.html`
People will want to aim it: "Roomy, draw that as a sequence diagram", "drop the timeline",
"focus on the auth part". Detect direct address in the utterance stream and route those
segments as instructions on the next commit rather than as conversation to be drawn.

Keep detection dumb and deterministic — a leading "roomy" is enough. The interesting part
is the prompt path, not the parsing.

**Done when:** during a replay you can inject a steering utterance and show the canvas
responding on the next commit.
**Do not:** build a chat UI, a command grammar, or model-based intent classification.

### T8 · Harden the ingest path for an external transcript source
**Files:** `src/server.ts`, and a short section in `CLAUDE.md`
Depends on T2. A meeting bot (Recall.ai, a Teams app, a Slack huddle listener) would post
transcript into a room exactly the way a browser does. Make that endpoint fit to be called
by something that is not our own page: a shared-secret header, a sane body limit, a
documented payload, and a speaker field that the poster supplies rather than inherits from
a connection. Prove it with a script that posts a fixture from outside the process.

This ticket builds no integration. It makes the seam ready so that building one later is a
day's work rather than a refactor.

**Done when:** an external script posts a fixture into a live room over HTTP with a secret,
the canvas builds from it, and an unauthenticated post is refused.
**Do not:** implement any specific vendor's API, add OAuth, or build a bot.

---

## Deferred, needs a human decision

- **Amend** (`docs/pipeline.md`). Reopen the last committed segment when its speaker resumes
  within ~2 s. Decide after T3 reports how often it would have mattered.
- **Acoustic crosstalk in co-located rooms.** One browser per speaker works when everyone
  is remote with headsets. Laptops around a table each hear the whole room, so the same
  sentence arrives three times under three names. Likely fix is a "one mic in this room"
  mode. Not a blocker for the PoC; it is a blocker for a demo held in person.
- **Web Speech sends audio to Google.** Chrome's implementation is a cloud service; recent
  Chrome has an on-device option worth checking. An argument for streaming ASR otherwise.
- **Per-room glossary.** Proper nouns end up as node labels, and Web Speech mangles them.
  A short list of project, service and people names fed into the prompt would fix the one
  ASR failure that is visible on the canvas. Ten lines; slot next to T5 if wanted.
- **Streaming ASR** (Deepgram / AssemblyAI). Better transcripts, and a vendor relationship.
  With T2 in place, diarization is no longer the reason to want it. Needs a key.
- **Freestyle HTML blocks.** The `Block.kind` seam allows it. Deliberately not opened:
  HTML cannot fail a parser, so bad output renders as plausible garbage.
- **Persistence.** Everything is in memory. Restart loses every room.
