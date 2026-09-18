# Roomy backlog

Written to be executed by agents with little supervision. Read CLAUDE.md first.

## Frozen contracts

Do not change these without a human. Every ticket below is written assuming they hold.

1. `Block` and `Op` in `src/canvas.ts`. Blocks are `mermaid` or `markdown`. Upserts carry
   full source. Ids are kebab-case and stable across revisions.
2. The LLM emits ops and nothing else. No HTML from the model, ever.
3. The browser decides what renders. `validateOp` stays shallow; `/render-error` is the
   feedback path. Do not add a server-side mermaid renderer.
4. All prompt text lives in `src/prompt.ts`.
5. One in-memory room, no database, no auth, no build step for the client.

## Definition of done, every ticket

- `npm test` and `npm run typecheck` pass.
- The behaviour is demonstrated against a fixture, not asserted in prose. Say which
  fixture and what you observed.
- New non-trivial logic leaves one runnable check in `test/`.
- Deliberate shortcuts carry a `ponytail:` comment naming the ceiling and the upgrade path.

---

## Wave 1 — parallel, no file overlap

### T1 · Offline eval harness
**Files:** new `src/eval.ts`, `package.json` (one script line)
Run a fixture end to end with no server and no browser: feed utterances through the same
`Room` tick logic, dump the final canvas to `evals/<fixture>-<timestamp>.md` (mermaid
sources in fenced blocks, so a human can skim it), and print a one-line summary —
tick count, ops applied, ops rejected with reasons, blocks by kind, wall time, token usage.

Real timing is pointless here: drive `Room` directly rather than sleeping through a replay.
The harness must not require a running server.

**Done when:** `npm run eval -- architecture-debate` writes a readable report for all three
fixtures and prints the rejected-op reasons. Include the three reports in your summary.
**Do not:** build a scoring model, an LLM judge, or a comparison UI. Reading the output is the eval.

### T2 · Client visual pass
**Files:** `public/index.html` only
The canvas currently renders as a plain vertical stack. Make it read like a shared board:
diagrams sized to their content rather than all full-width, a denser layout on wide screens,
a clear but not annoying signal for what just changed, and a transcript pane that is
comfortable to read for twenty minutes. Speaker name should be editable and remembered
across reloads (`localStorage`). Mic button needs a visible recording state and a clear
message when the browser has no Web Speech API.

**Done when:** replay each of the three fixtures and describe how the board looks at
1400px and at 900px. No new dependencies; mermaid stays the only CDN import.
**Do not:** add a framework, a build step, drag-and-drop, or editing of blocks by hand.

### T3 · Make the restructure pass earn its cost
**Files:** `src/room.ts`, `src/prompt.ts`
The Sonnet restructure pass (`RESTRUCTURE_EVERY`) has never actually been observed — the
fixtures are too short to reach 15 ticks at replay speed. Verify it fires, verify it
improves the canvas rather than churning it, and tune the cadence and the prompt.

Specifically: after a restructure, ids for surviving ideas must be preserved (the canvas
should not visibly rebuild itself), stale blocks should actually get deleted, and the pass
must not fire when the canvas has not meaningfully grown since the last one.

**Done when:** you show a before/after canvas across a restructure on at least two fixtures,
and state what you changed about the cadence and why.
**Do not:** add a third model tier or a separate restructure pipeline.

---

## Wave 2 — after Wave 1 lands

### T4 · Prompt hillclimb on diagram choice
**Files:** `src/prompt.ts` (and `src/eval.ts` only if the harness needs a knob)
Depends on T1. The tick model over-reaches for markdown and under-uses sequence, state and
class diagrams. Using the eval harness, iterate on `src/prompt.ts` until each fixture
produces at least one diagram that a participant would recognise as the shape of their own
conversation: the architecture debate should yield a deliberation structure showing the
disagreement, the brainstorm a mindmap that reflects the late regrouping, the incident
review a timeline or sequence plus causes.

Record what you tried in the ticket summary, including what made things worse.

**Done when:** all three fixtures hit that bar, zero rejected ops across all three,
and `npm test` still passes.
**Do not:** add diagram types beyond the mermaid set already in `MERMAID_HEADS`.

### T5 · Rooms and shareable URLs
**Files:** `src/server.ts`, `src/room.ts`, `public/index.html`
Right now there is one hardcoded room. Make `/r/<slug>` create or join a room, with each
room its own `Room` instance, its own SSE stream and its own canvas. `/` redirects to a
generated slug. Rooms with no subscribers for ten minutes are dropped.

**Done when:** two browser windows on the same slug see the same live canvas, two windows
on different slugs do not interfere, and replay targets a specific room.
**Do not:** add auth, accounts, persistence, or a room list page.

---

## Wave 3 — after Wave 2

### T6 · Export the canvas
**Files:** `src/server.ts`, `public/index.html`
`GET /r/<slug>/export` returns a single self-contained HTML file: the canvas as it stands,
diagrams already rendered to inline SVG, plus the transcript. It must open correctly with
no network access. This is how a meeting's output leaves Roomy.

**Done when:** an exported file from each fixture opens offline in a browser and matches
what was on screen.
**Do not:** add PDF, image export, or a sharing backend.

### T7 · Steering Roomy from the room
**Files:** `src/room.ts`, `src/prompt.ts`, `public/index.html`
People will want to aim it: "Roomy, draw that as a sequence diagram", "drop the timeline",
"focus on the auth part". Detect direct address in the utterance stream, and route those
utterances as instructions on the next tick rather than as conversation to be summarised.

Keep the detection dumb and deterministic — a leading "roomy" is enough. The interesting
part is the prompt path, not the parsing.

**Done when:** during a replay you can inject a steering utterance and show the canvas
responding to it on the next tick.
**Do not:** build a chat UI, a command grammar, or intent classification with a model.

---

## Deferred, needs a human decision

- **Streaming ASR with diarization** (Deepgram / AssemblyAI). Web Speech has no speaker
  separation, so in a real meeting every utterance is attributed to one tab. This is the
  single biggest gap between the PoC and the actual product idea. Needs a vendor and a key.
- **Freestyle HTML blocks.** The `Block.kind` seam already allows it. Deliberately not
  opened: HTML cannot fail a parser, so bad output would render as plausible garbage.
- **Real meeting integration** (Teams / Zoom / Meet). No live-transcript API is available
  on the terms this PoC assumes; the realistic path is a participant running Roomy in a
  tab next to the call.
- **Persistence.** Everything is in memory. Restart loses the room.
