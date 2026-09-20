import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.ts";

type Stream = {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffered: string;
};

const decoder = new TextDecoder();
const streams: Stream[] = [];
let server: RunningServer | undefined;
let base = "";
const originalSecret = process.env.ROOMY_INGEST_SECRET;

async function address() {
  const addr = await server?.ready.then((running) => running.address());
  if (!addr || typeof addr === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${addr.port}`;
}

async function connect(slug: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/r/${slug}/events?name=Observer`, { signal: controller.signal });
  expect(response.ok).toBe(true);
  if (!response.body) throw new Error("SSE response has no body");
  const stream: Stream = { controller, reader: response.body.getReader(), buffered: "" };
  streams.push(stream);
  return stream;
}

async function nextMessage(stream: Stream, timeoutMs = 1000) {
  const read = async () => {
    while (true) {
      const end = stream.buffered.indexOf("\n\n");
      if (end !== -1) {
        const event = stream.buffered.slice(0, end);
        stream.buffered = stream.buffered.slice(end + 2);
        const line = event.split("\n").find((part) => part.startsWith("data: "));
        if (line) return JSON.parse(line.slice("data: ".length));
        continue;
      }
      const chunk = await stream.reader.read();
      if (chunk.done) throw new Error("SSE stream ended");
      stream.buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for SSE message")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeStream(stream: Stream) {
  stream.controller.abort();
  await stream.reader.cancel().catch(() => undefined);
}

async function post(path: string, body: unknown, secret?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-roomy-secret"] = secret;
  return fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function start() {
  server = startServer(0, { reapMs: 5000 });
  await server.ready;
  base = await address();
}

async function closeServer() {
  for (const stream of streams.splice(0)) await closeStream(stream);
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  }
  server = undefined;
  if (originalSecret === undefined) delete process.env.ROOMY_INGEST_SECRET;
  else process.env.ROOMY_INGEST_SECRET = originalSecret;
}

afterEach(async () => {
  await closeServer();
});

describe("authenticated transcript ingest", () => {
  it("authenticates and forwards the posted utterance to SSE subscribers", async () => {
    process.env.ROOMY_INGEST_SECRET = "roomy-test-secret";
    await start();
    const stream = await connect("ingest-room");
    expect((await nextMessage(stream)).type).toBe("state");
    expect((await nextMessage(stream)).type).toBe("presence");

    const response = await post("/r/ingest-room/ingest", {
      speaker: "Meeting bot",
      text: "The decision is to ship Friday.",
      t_ms: 1234,
    }, "roomy-test-secret");
    expect(response.status).toBe(200);
    expect((await nextMessage(stream)).utterance).toEqual({
      speaker: "Meeting bot",
      text: "The decision is to ship Friday.",
      t_ms: 1234,
    });
  });

  it("rejects a wrong or missing secret without saying anything", async () => {
    process.env.ROOMY_INGEST_SECRET = "roomy-test-secret";
    await start();
    const stream = await connect("protected-room");
    expect((await nextMessage(stream)).type).toBe("state");
    expect((await nextMessage(stream)).type).toBe("presence");

    expect((await post("/r/protected-room/ingest", { speaker: "Bot", text: "wrong" }, "nope")).status).toBe(401);
    expect((await post("/r/protected-room/ingest", { speaker: "Bot", text: "missing" })).status).toBe(401);
    await expect(nextMessage(stream, 60)).rejects.toThrow(/timed out/);
    expect(server?.rooms.get("protected-room")?.room.exportData.utterances).toEqual([]);
  });

  it("disables the route when no ingest secret is configured", async () => {
    delete process.env.ROOMY_INGEST_SECRET;
    await start();

    expect((await post("/r/disabled-room/ingest", { speaker: "Bot", text: "ignored" }, "anything")).status).toBe(404);
    expect(server?.rooms.has("disabled-room")).toBe(false);
  });

  it("rejects malformed payloads and oversized bodies on both routes", async () => {
    process.env.ROOMY_INGEST_SECRET = "roomy-test-secret";
    await start();

    expect((await post("/r/bad-room/ingest", "{", "roomy-test-secret")).status).toBe(400);
    expect((await post("/r/bad-room/ingest", { speaker: "Bot", text: "bad", t_ms: "later" }, "roomy-test-secret")).status).toBe(400);

    const oversized = { speaker: "Bot", text: "x".repeat(20 * 1024) };
    expect((await post("/r/big-ingest/ingest", oversized, "roomy-test-secret")).status).toBe(413);
    expect((await post("/r/big-browser/utterance", oversized)).status).toBe(413);
  });
});
