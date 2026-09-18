# Roomy

A shared canvas that an LLM keeps in sync with a live conversation. People talk; Roomy
silently draws what they are working out — as mermaid diagrams and short markdown notes.

## Run it

```
npm install
export ANTHROPIC_API_KEY=...
npm run dev            # http://localhost:3000
npm run replay -- incident-review 12
npm test
```

You do not need a microphone to work on this. Replay a fixture — that is the primary
dev loop. `npm run replay -- <fixture> <speed>`; fixtures are in `src/fixtures/`.

## Shape

```
transcript --> Room (windows, debounces) --> LLM --> Op[] --> validateOp --> applyOps --> SSE --> browser --> mermaid
                                                                                                    |
                                                                             render failure --------+--> repair, one retry, then drop
```

- `src/canvas.ts` — **the contract.** Block/Op types, validation, `applyOps`. Everything
  depends on this. Changing it means changing the prompt, the server and the client together.
- `src/room.ts` — the tick loop. Cadence, windowing, rolling summary, restructure schedule.
- `src/llm.ts` — two-tier models: Haiku 4.5 on every tick, Sonnet 5 on the periodic rethink.
- `src/prompt.ts` — all prompt text. Nothing else in the repo contains prompt strings.
- `src/server.ts` — node:http + SSE. No framework, no websockets, no database.
- `public/index.html` — the whole client. One file, no build step, mermaid from CDN.

## Rules

- The LLM only ever emits ops. It never emits HTML, and it never renders anything.
- The browser is the authority on whether a diagram renders. Server-side validation is
  deliberately shallow (`validateOp`); the client reports failures to `/render-error`.
- Full block source on every upsert, never a diff.
- No new dependency without a reason that a few lines of code cannot cover.
- Every non-trivial change leaves one runnable check in `test/`.
- Mark deliberate simplifications with a `ponytail:` comment naming the ceiling.

## Not in scope for the PoC

Auth, persistence, multi-tenancy, real Teams/Zoom integration, PlantUML, freestyle HTML
blocks, speaker diarization. Each is deliberately deferred — see BACKLOG.md.
