import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Room } from "./room.ts";
import type { Fixture, Utterance } from "./transcript.ts";

const PORT = Number(process.env.PORT ?? 3000);
const here = new URL(".", import.meta.url);

// ponytail: one hardcoded room. Multi-room is a Map keyed by path segment when it matters.
const room = new Room();
room.start();

const json = (req: import("node:http").IncomingMessage) =>
  new Promise<any>((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
  });

async function replay(name: string, speed: number) {
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

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(fileURLToPath(new URL("../public/index.html", here)));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const off = room.subscribe((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => { off(); clearInterval(ping); });
      return;
    }

    if (req.method === "POST" && url.pathname === "/utterance") {
      const body = await json(req);
      if (typeof body.text !== "string" || !body.text.trim()) return send(400, { error: "text required" });
      const u: Utterance = { t_ms: Date.now(), speaker: String(body.speaker ?? "Someone"), text: body.text };
      room.say(u);
      return send(200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/render-error") {
      const body = await json(req);
      void room.renderFailed(String(body.id), String(body.error ?? "render failed"));
      return send(200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/replay") {
      const body = await json(req);
      void replay(String(body.fixture ?? "architecture-debate"), Number(body.speed ?? 10));
      return send(200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/reset") {
      room.reset();
      return send(200, { ok: true });
    }

    send(404, { error: "not found" });
  } catch (err) {
    send(500, { error: String(err) });
  }
}).listen(PORT, () => console.log(`roomy on http://localhost:${PORT}`));
