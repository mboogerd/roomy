# Roomy

A shared canvas that an LLM keeps in sync with a live conversation. People talk; Roomy
silently draws what they are working out — as mermaid diagrams and short markdown notes.

## Run it

```
npm install
export ROOMY_LLM=cli   # or: api (+ ANTHROPIC_API_KEY) or bedrock (+ AWS creds, ROOMY_AWS_REGION)
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
- `src/room.ts` — the live pipeline. Currently a timer-driven tick loop; `docs/pipeline.md`
  specifies the journal that replaces it (backlog T3).
- `src/llm.ts` — two-tier models: Haiku 4.5 on every tick, Sonnet 5 on the periodic rethink.
- `src/transport.ts` — how a prompt reaches the model: `api`, `bedrock`, or the `claude` CLI.
  `cli` bills a Claude subscription and adds 2–5 s per call; `api`/`bedrock` are the fast paths.
  If `claude auth status` says `authMethod: api_key`, `cli` is billing an API key, not a
  subscription — `/login` with the subscription account first.
- `src/prompt.ts` — all prompt text. Nothing else in the repo contains prompt strings.
- `src/server.ts` — node:http + SSE. No framework, no websockets, no database.
- `public/index.html` — the whole client. One file, no build step, mermaid from CDN.

## Rules

- `Room.say(utterance)` is the only way transcript enters the system. Fixture replay, the
  browser mic, and any future meeting bot all converge there. Do not add a second ingest path.
- The LLM only ever emits ops. It never emits HTML, and it never renders anything.
- The browser is the authority on whether a diagram renders. Server-side validation is
  deliberately shallow (`validateOp`); the client reports failures to `/render-error`.
- Full block source on every upsert, never a diff.
- Model calls go through `src/transport.ts`. Nothing else imports an SDK or spawns `claude`.
- No new dependency without a reason that a few lines of code cannot cover.
- Every non-trivial change leaves one runnable check in `test/`.
- Mark deliberate simplifications with a `ponytail:` comment naming the ceiling.

## Where this is going

Roomy does not integrate with a meeting tool's audio. Each participant opens Roomy beside
whatever call they are on, so one browser transcribes one person and speaker identity comes
from the connection. That makes diarization free, and it is why contract 5 above matters.

## Posting transcript from outside

Set `ROOMY_INGEST_SECRET` before starting the server to enable the authenticated
`POST /r/<slug>/ingest` endpoint. Send `x-roomy-secret` and a JSON payload of
`{ "speaker": string, "text": string, "t_ms"?: number }`; `t_ms` defaults to the
server's current time and the request body may be at most 16 KB. For example:

```
curl -X POST http://localhost:3000/r/demo-room/ingest \
  -H 'content-type: application/json' \
  -H "x-roomy-secret: $ROOMY_INGEST_SECRET" \
  -d '{"speaker":"Recall","text":"The decision is to ship Friday."}'
```

The fixture client uses the same endpoint: `ROOMY_INGEST_SECRET=... npm run ingest --
<slug> <fixture> <speed>` (optionally set `ROOMY_URL` for another server).

## Not in scope for the PoC

Auth, persistence, PlantUML, freestyle HTML blocks, and any vendor-specific meeting
integration. Each is deliberately deferred — see BACKLOG.md.
