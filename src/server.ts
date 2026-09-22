import { createServer as createHttpServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Room } from "./room.ts";
import type { Llm } from "./llm.ts";
import type { Fixture, Utterance } from "./transcript.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_REAP_MS = 10 * 60 * 1000;
const MAX_JSON_BYTES = 16 * 1024;
// A posted speaker is a display name; the body limit alone would allow a 16 KB one.
const MAX_SPEAKER_CHARS = 80;
const SLUG = /^[a-z0-9-]{3,40}$/;
const here = new URL(".", import.meta.url);
const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]);
}

// Keep this small conversion in step with the one in public/index.html. The export is
// deliberately standalone, so the two files do not share browser/server code.
function markdownToHtml(source: string) {
  return source
    .replace(/[&<>"']/g, (character) => htmlEscapes[character])
    .replace(/^#{2,3} (.*)$/gm, "<h3>$1</h3>")
    .replace(/^[-*] (.*)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/gs, "<ul>$&</ul>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\n{2,}/g, "<br><br>");
}

const exportStyle = `
  :root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1d1d1f; --mut: #6b6b70; --line: #dededb; --panel: #f2f2ef; --accent: #3b6fe0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151517; --fg: #e9e9ea; --mut: #9a9aa0; --line: #36363a; --panel: #202024; --accent: #9ab6ff; }
  }
  * { box-sizing: border-box; }
  body { max-width: 68rem; margin: 0 auto; padding: 2.5rem clamp(1rem, 5vw, 4rem); background: var(--bg); color: var(--fg); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1, h2, h3, p { margin-top: 0; }
  h1 { margin-bottom: .35rem; font-size: clamp(1.7rem, 4vw, 2.4rem); }
  h2 { margin: 2.6rem 0 1rem; font-size: 1.1rem; letter-spacing: .04em; text-transform: uppercase; }
  .meta, .empty, .kind, time { color: var(--mut); }
  .meta { margin-bottom: 2rem; }
  .blocks { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: 1rem; }
  .block { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: .7rem; background: var(--panel); }
  .block-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: .7rem 1rem; border-bottom: 1px solid var(--line); }
  .block-head h3 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: .95rem; }
  .kind { flex: 0 0 auto; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; }
  .block-body { min-width: 0; padding: 1rem; overflow-x: auto; }
  .block-body svg { display: block; max-width: 100%; height: auto; }
  .markdown h3 { margin-bottom: .5rem; font-size: 1rem; }
  .markdown ul { margin: 0 0 .7rem; padding-left: 1.2rem; }
  .mermaid { min-height: 1rem; white-space: pre-wrap; }
  .transcript { display: grid; gap: .7rem; margin: 0; padding: 0; list-style: none; }
  .turn { padding: .7rem .9rem; border: 1px solid var(--line); border-radius: .6rem; background: var(--panel); }
  .turn-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  .speaker { color: var(--accent); font-weight: 650; }
  .turn p { margin: .25rem 0 0; overflow-wrap: anywhere; }
  .participants { display: flex; flex-wrap: wrap; gap: .45rem; padding: 0; list-style: none; }
  .participants li { padding: .25rem .7rem; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
`;

// Live utterances carry a wall-clock `t_ms` and fixture utterances carry an offset from
// zero, so the transcript is anchored on its first turn exactly as the live page is.
function elapsedTime(tMs: number, startMs: number) {
  if (!Number.isFinite(tMs) || !Number.isFinite(startMs)) return "";
  const seconds = Math.max(0, Math.round((tMs - startMs) / 1000));
  return `+${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function exportBlock(block: { kind: string; title: string; source: string }) {
  const kind = block.kind === "mermaid" ? "diagram" : "note";
  const body = block.kind === "mermaid"
    ? `<pre class="mermaid">${escapeHtml(block.source)}</pre>`
    : `<div class="markdown">${markdownToHtml(block.source)}</div>`;
  return `<article class="block"><header class="block-head"><h3>${escapeHtml(block.title)}</h3><span class="kind">${kind}</span></header><div class="block-body">${body}</div></article>`;
}

function exportPage(
  slug: string,
  state: Room["state"],
  utterances: Utterance[],
  participants: string[],
  mermaidScript: string,
) {
  const exportedAt = new Date().toISOString();
  const blocks = state.blocks.map(exportBlock).join("\n");
  const startMs = utterances[0]?.t_ms ?? 0;
  const transcript = utterances.map((utterance) => `<li class="turn"><div class="turn-head"><span class="speaker">${escapeHtml(utterance.speaker)}</span><time>${escapeHtml(elapsedTime(utterance.t_ms, startMs))}</time></div><p>${escapeHtml(utterance.text)}</p></li>`).join("\n");
  const people = participants.map((participant) => `<li>${escapeHtml(participant)}</li>`).join("\n");
  const inlineMermaid = mermaidScript.replace(/<\/script/gi, "<\\/script");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roomy export — ${escapeHtml(slug)}</title>
<style>${exportStyle}</style>
</head>
<body>
<header>
  <h1>Roomy canvas</h1>
  <p class="meta">Room <strong>${escapeHtml(slug)}</strong> · exported <time datetime="${escapeHtml(exportedAt)}">${escapeHtml(exportedAt)}</time></p>
</header>
<main>
  <section aria-labelledby="canvas-heading">
    <h2 id="canvas-heading">Canvas</h2>
    ${blocks ? `<div class="blocks">${blocks}</div>` : `<p class="empty">This room is empty: no canvas blocks have been recorded yet.</p>`}
  </section>
  <section aria-labelledby="transcript-heading">
    <h2 id="transcript-heading">Transcript</h2>
    ${transcript ? `<ol class="transcript">${transcript}</ol>` : `<p class="empty">No utterances were recorded.</p>`}
  </section>
  <section aria-labelledby="participants-heading">
    <h2 id="participants-heading">Participants</h2>
    ${people ? `<ul class="participants">${people}</ul>` : `<p class="empty">No participants were recorded.</p>`}
  </section>
</main>
<script data-roomy-mermaid="inline">${inlineMermaid}</script>
<script>
  // The page has a dark palette; the diagrams follow it, as the live canvas does.
  // securityLevel stays "strict" — unlike the live page, this file is opened by third parties.
  var dark = matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
  mermaid.run().catch(function () {});
</script>
</body>
</html>`;
}

export interface ServerOptions {
  /** How long a room with no subscribers survives. Injectable so a test can use milliseconds. */
  reapMs?: number;
  /** The model behind every room this server creates. Tests pass a stub so no test can bill a real one. */
  llm?: Llm;
}

/** A room plus the bookkeeping the reaper needs. */
export interface RoomEntry {
  room: Room;
  subscribers: number;
  reapTimer?: NodeJS.Timeout;
}

export interface RunningServer extends Server {
  rooms: Map<string, RoomEntry>;
  ready: Promise<RunningServer>;
}

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

const json = (req: import("node:http").IncomingMessage) =>
  new Promise<any>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      size += bytes;
      if (size > MAX_JSON_BYTES) {
        fail(new RequestError(413, "request body too large"));
        req.resume();
        return;
      }
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", (error) => fail(error));
  });

function matchesSecret(header: string | string[] | undefined, expected: string) {
  if (typeof header !== "string") return false;
  const actualBytes = Buffer.from(header);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

type IngestPayload = { speaker: string; text: string; t_ms?: number };

function isIngestPayload(value: unknown): value is IngestPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return typeof body.speaker === "string" && body.speaker.trim().length > 0 && body.speaker.length <= MAX_SPEAKER_CHARS
    && typeof body.text === "string" && body.text.trim().length > 0
    && (body.t_ms === undefined || (typeof body.t_ms === "number" && Number.isFinite(body.t_ms)));
}

async function replay(room: Room, name: string, speed: number) {
  const path = fileURLToPath(new URL(`fixtures/${name}.json`, here));
  const fixture: Fixture = JSON.parse(await readFile(path, "utf8"));
  room.reset();
  const t0 = Date.now();
  for (const u of fixture.utterances) {
    const due = t0 + u.t_ms / speed;
    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
    room.say(u);
  }
}

function slugFromPath(pathname: string) {
  const match = /^\/r\/([^/]+)(?:\/(events|utterance|ingest|render-error|replay|reset|export|glossary))?$/.exec(pathname);
  if (!match) return;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return;
  }
  if (!SLUG.test(slug)) return;
  return { slug, action: match[2] ?? "page" } as const;
}

function freshSlug() {
  // ponytail: random slugs are PoC-level obscurity; signed session cookies are the access-control upgrade.
  return randomBytes(8).toString("hex");
}

export function startServer(port = PORT, options: ServerOptions = {}): RunningServer {
  const reapMs = options.reapMs ?? DEFAULT_REAP_MS;
  const rooms = new Map<string, RoomEntry>();

  const clearReap = (entry: RoomEntry) => {
    clearTimeout(entry.reapTimer);
    entry.reapTimer = undefined;
  };

  const scheduleReap = (slug: string, entry: RoomEntry) => {
    clearReap(entry);
    entry.reapTimer = setTimeout(() => {
      entry.reapTimer = undefined;
      if (rooms.get(slug) !== entry || entry.subscribers !== 0) return;
      entry.room.stop();
      rooms.delete(slug);
    }, reapMs);
  };

  const getRoom = (slug: string) => {
    let entry = rooms.get(slug);
    if (!entry) {
      const room = new Room(options.llm);
      room.start();
      entry = { room, subscribers: 0 };
      rooms.set(slug, entry);
      scheduleReap(slug, entry);
    }
    return entry;
  };

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(302, { location: `/r/${freshSlug()}` });
        return res.end();
      }

      const route = slugFromPath(url.pathname);
      if (!route) return send(404, { error: "not found" });

      if (route.action === "ingest") {
        // ponytail: one shared secret covers every room and every poster, re-read from the
        // environment per request. Per-source keys and rotation are the upgrade once more
        // than one bot posts into the same deployment.
        const ingestSecret = process.env.ROOMY_INGEST_SECRET;
        if (!ingestSecret) return send(404, { error: "not found" });
        // Checked before getRoom() so an unauthenticated caller cannot even create a room.
        if (!matchesSecret(req.headers["x-roomy-secret"], ingestSecret)) {
          return send(401, { error: "invalid ingest secret" });
        }
      }

      if (req.method === "GET" && route.action === "export") {
        const entry = rooms.get(route.slug);
        if (!entry) return send(404, { error: "not found" });
        // ponytail: the 3.5 MB runtime is re-read and re-inlined on every export; caching it
        // in memory, or writing the export to disk, is the upgrade path if exports get frequent.
        const data = entry.room.exportData;
        // A live session as a replayable fixture: drop it in src/fixtures/ and `npm run eval` it.
        if (url.searchParams.get("format") === "fixture") {
          const t0 = data.utterances[0]?.t_ms ?? 0;
          return send(200, {
            name: route.slug,
            description: `Recorded from room ${route.slug}`,
            utterances: data.utterances.map((u) => ({ ...u, t_ms: u.t_ms - t0 })),
          });
        }
        const mermaidScript = await readFile(fileURLToPath(new URL("../node_modules/mermaid/dist/mermaid.min.js", here)), "utf8");
        const html = exportPage(route.slug, entry.room.state, data.utterances, data.participants, mermaidScript);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      const entry = getRoom(route.slug);

      if (req.method === "GET" && route.action === "page") {
        const html = await readFile(fileURLToPath(new URL("../public/index.html", here)));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      if (req.method === "GET" && route.action === "events") {
        const name = url.searchParams.get("name")?.trim() || "Someone";
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const off = entry.room.subscribe((msg) => {
          if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(msg)}\n\n`);
        }, name);
        entry.subscribers++;
        clearReap(entry);
        let connected = true;
        const disconnect = () => {
          if (!connected) return;
          connected = false;
          off();
          entry.subscribers--;
          if (entry.subscribers === 0) scheduleReap(route.slug, entry);
          clearInterval(ping);
        };
        const ping = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n");
        }, 20000);
        req.on("close", disconnect);
        res.on("close", disconnect);
        return;
      }

      if (req.method === "POST" && route.action === "utterance") {
        const body = await json(req);
        if (typeof body.text !== "string" || !body.text.trim()) return send(400, { error: "text required" });
        // ponytail: the browser supplies the connection name. A signed session cookie is the upgrade path.
        const speaker = typeof body.speaker === "string" && body.speaker.trim() ? body.speaker : "Someone";
        const u: Utterance = { t_ms: Date.now(), speaker, text: body.text };
        entry.room.say(u);
        return send(200, { ok: true });
      }

      if (req.method === "POST" && route.action === "ingest") {
        let body: any;
        try {
          body = await json(req);
        } catch (error) {
          if (error instanceof SyntaxError) return send(400, { error: "invalid JSON" });
          throw error;
        }
        if (!isIngestPayload(body)) {
          return send(400, { error: `speaker (1-${MAX_SPEAKER_CHARS} chars), text, and optional numeric t_ms required` });
        }
        const u: Utterance = {
          t_ms: body.t_ms === undefined ? Date.now() : body.t_ms,
          speaker: body.speaker,
          text: body.text,
        };
        entry.room.say(u);
        return send(200, { ok: true });
      }

      if (req.method === "POST" && route.action === "render-error") {
        const body = await json(req);
        void entry.room.renderFailed(String(body.id), String(body.error ?? "render failed"));
        return send(200, { ok: true });
      }

      if (req.method === "POST" && route.action === "replay") {
        const body = await json(req);
        void replay(entry.room, String(body.fixture ?? "architecture-debate"), Number(body.speed ?? 10));
        return send(200, { ok: true });
      }

      if (req.method === "POST" && route.action === "glossary") {
        const body = await json(req);
        entry.room.setGlossary(body.names);
        return send(200, { names: entry.room.glossary });
      }

      if (req.method === "POST" && route.action === "reset") {
        entry.room.reset();
        return send(200, { ok: true });
      }

      send(404, { error: "not found" });
    } catch (err) {
      if (err instanceof RequestError) return send(err.status, { error: err.message });
      send(500, { error: String(err) });
    }
  });

  const server = http as RunningServer;
  server.rooms = rooms;
  server.ready = new Promise<RunningServer>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, () => {
      server.off("error", onError);
      resolve(server);
      const address = server.address();
      const actualPort = address && typeof address !== "string" ? address.port : port;
      console.log(`roomy on http://localhost:${actualPort}`);
    });
  });
  server.on("close", () => {
    for (const entry of rooms.values()) {
      clearReap(entry);
      entry.room.stop();
    }
    rooms.clear();
  });
  return server;
}

if (process.argv[1]?.endsWith("server.ts")) {
  const server = startServer();
  server.ready.catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
