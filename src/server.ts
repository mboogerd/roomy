import { createServer as createHttpServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Room } from "./room.ts";
import type { Fixture, Utterance } from "./transcript.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_REAP_MS = 10 * 60 * 1000;
const SLUG = /^[a-z0-9-]{3,40}$/;
const here = new URL(".", import.meta.url);

export interface ServerOptions {
  reapMs?: number;
  reapIntervalMs?: number;
  roomFactory?: () => Room;
}

export interface RunningServer extends Server {
  rooms: Map<string, Room>;
  ready: Promise<RunningServer>;
}

const json = (req: import("node:http").IncomingMessage) =>
  new Promise<any>((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
  });

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

interface RoomEntry {
  room: Room;
  subscribers: number;
  reapTimer?: NodeJS.Timeout;
}

type ServerOptionsInput = ServerOptions | number;

function slugFromPath(pathname: string) {
  const match = /^\/r\/([^/]+)(?:\/(events|utterance|render-error|replay|reset))?$/.exec(pathname);
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

export function startServer(port = PORT, input: ServerOptionsInput = {}): RunningServer {
  const options = typeof input === "number" ? { reapMs: input } : input;
  const reapMs = options.reapMs ?? options.reapIntervalMs ?? DEFAULT_REAP_MS;
  const rooms = new Map<string, RoomEntry>();
  const publicRooms = new Map<string, Room>();
  const roomFactory = options.roomFactory ?? (() => new Room());

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
      publicRooms.delete(slug);
    }, reapMs);
  };

  const getRoom = (slug: string) => {
    let entry = rooms.get(slug);
    if (!entry) {
      const room = roomFactory();
      room.start();
      entry = { room, subscribers: 0 };
      rooms.set(slug, entry);
      publicRooms.set(slug, room);
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

      if (req.method === "POST" && route.action === "reset") {
        entry.room.reset();
        return send(200, { ok: true });
      }

      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: String(err) });
    }
  });

  const server = http as RunningServer;
  server.rooms = publicRooms;
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
    publicRooms.clear();
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
