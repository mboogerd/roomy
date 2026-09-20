import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Room } from "../src/room.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { StubLlm } from "./stub-llm.ts";

type Stream = {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffered: string;
};

const SECRET = "roomy-test-secret";
const decoder = new TextDecoder();
const streams: Stream[] = [];
const seeded: Room[] = [];
let server: RunningServer | undefined;
let base = "";
const originalSecret = process.env.ROOMY_INGEST_SECRET;

async function address() {
  const addr = await server?.ready.then((running) => running.address());
  if (!addr || typeof addr === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${addr.port}`;
}

/** A room driven by the stub model, so nothing in this file can reach a transport. */
function seed(slug: string) {
  const room = new Room(new StubLlm());
  room.start();
  seeded.push(room);
  server?.rooms.set(slug, { room, subscribers: 0 });
  return room;
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
  for (const room of seeded.splice(0)) room.stop();
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
  vi.restoreAllMocks();
  await closeServer();
});

describe("authenticated transcript ingest", () => {
  it("authenticates and forwards the posted utterance to SSE subscribers", async () => {
    process.env.ROOMY_INGEST_SECRET = SECRET;
    await start();
    seed("ingest-room");
    const stream = await connect("ingest-room");
    expect((await nextMessage(stream)).type).toBe("state");
    expect((await nextMessage(stream)).type).toBe("presence");

    const response = await post("/r/ingest-room/ingest", {
      speaker: "Meeting bot",
      text: "The decision is to ship Friday.",
      t_ms: 1234,
    }, SECRET);
    expect(response.status).toBe(200);
    expect((await nextMessage(stream)).utterance).toEqual({
      speaker: "Meeting bot",
      text: "The decision is to ship Friday.",
      t_ms: 1234,
    });
  });

  it("defaults t_ms to the server's clock when the poster omits it", async () => {
    process.env.ROOMY_INGEST_SECRET = SECRET;
    await start();
    const room = seed("clock-room");

    const before = Date.now();
    expect((await post("/r/clock-room/ingest", { speaker: "Bot", text: "no timestamp" }, SECRET)).status).toBe(200);
    const after = Date.now();

    const [utterance] = room.exportData.utterances;
    expect(utterance.speaker).toBe("Bot");
    expect(utterance.t_ms).toBeGreaterThanOrEqual(before);
    expect(utterance.t_ms).toBeLessThanOrEqual(after);
  });

  it("rejects a wrong or missing secret without saying anything or creating a room", async () => {
    process.env.ROOMY_INGEST_SECRET = SECRET;
    await start();
    const room = seed("protected-room");
    const stream = await connect("protected-room");
    expect((await nextMessage(stream)).type).toBe("state");
    expect((await nextMessage(stream)).type).toBe("presence");

    const body = { speaker: "Bot", text: "should not land" };
    // Same length as the real secret, so the comparison runs to the end rather than
    // short-circuiting on length; last byte differs.
    expect(SECRET.length).toBe("roomy-test-secreT".length);
    expect((await post("/r/protected-room/ingest", body, "roomy-test-secreT")).status).toBe(401);
    // Different lengths: timingSafeEqual throws unless the length guard runs first, so a
    // missing guard would surface here as a 500.
    expect((await post("/r/protected-room/ingest", body, "nope")).status).toBe(401);
    expect((await post("/r/protected-room/ingest", body, `${SECRET}-extra`)).status).toBe(401);
    expect((await post("/r/protected-room/ingest", body, "")).status).toBe(401);
    expect((await post("/r/protected-room/ingest", body)).status).toBe(401);

    await expect(nextMessage(stream, 60)).rejects.toThrow(/timed out/);
    expect(room.exportData.utterances).toEqual([]);

    // An unauthenticated caller cannot even bring a room into existence.
    expect((await post("/r/unknown-room/ingest", body, "nope")).status).toBe(401);
    expect(server?.rooms.has("unknown-room")).toBe(false);
  });

  // A timing measurement would be flaky, so the property is pinned at the source: the
  // comparison must go through timingSafeEqual and must not fall back to a string compare.
  it("compares the secret in constant time", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
    const fn = /function matchesSecret[\s\S]*?\n\}/.exec(source)?.[0];
    expect(fn).toBeDefined();
    expect(fn).toContain("timingSafeEqual(");
    // Only lengths and the header's type may be compared directly; the bytes never are.
    const comparisons = fn!.split("\n")
      .filter((line) => /[=!]==/.test(line))
      .filter((line) => !/\.length\s*!==\s*\w+\.length/.test(line) && !/typeof header !== "string"/.test(line));
    expect(comparisons).toEqual([]);
  });

  it("disables the route when no ingest secret is configured", async () => {
    delete process.env.ROOMY_INGEST_SECRET;
    await start();

    expect((await post("/r/disabled-room/ingest", { speaker: "Bot", text: "ignored" }, "anything")).status).toBe(404);
    expect((await post("/r/disabled-room/ingest", { speaker: "Bot", text: "ignored" })).status).toBe(404);
    expect((await fetch(`${base}/r/disabled-room/ingest`)).status).toBe(404);
    expect(server?.rooms.has("disabled-room")).toBe(false);
  });

  it("rejects malformed payloads", async () => {
    process.env.ROOMY_INGEST_SECRET = SECRET;
    await start();
    const room = seed("bad-room");

    const rejected: unknown[] = [
      "{",
      { text: "no speaker" },
      { speaker: "Bot" },
      { speaker: "   ", text: "blank speaker" },
      { speaker: "Bot", text: "   " },
      { speaker: 7, text: "speaker is not a string" },
      { speaker: "Bot", text: "bad clock", t_ms: "later" },
      { speaker: "Bot", text: "bad clock", t_ms: Number.NaN },
      // A display name, not free text: the 16 KB body limit alone would allow a huge one.
      { speaker: "x".repeat(81), text: "speaker too long" },
      [{ speaker: "Bot", text: "array body" }],
    ];
    for (const body of rejected) {
      expect((await post("/r/bad-room/ingest", body, SECRET)).status).toBe(400);
    }
    expect(room.exportData.utterances).toEqual([]);

    // The boundary itself is accepted.
    expect((await post("/r/bad-room/ingest", { speaker: "x".repeat(80), text: "ok" }, SECRET)).status).toBe(200);
    expect(room.exportData.utterances).toHaveLength(1);
  });

  it("caps the body at 16 KB on both the ingest and browser routes", async () => {
    process.env.ROOMY_INGEST_SECRET = SECRET;
    await start();
    const ingestRoom = seed("big-ingest");
    const browserRoom = seed("big-browser");

    const oversized = { speaker: "Bot", text: "x".repeat(20 * 1024) };
    expect((await post("/r/big-ingest/ingest", oversized, SECRET)).status).toBe(413);
    expect((await post("/r/big-browser/utterance", oversized)).status).toBe(413);
    expect(ingestRoom.exportData.utterances).toEqual([]);
    expect(browserRoom.exportData.utterances).toEqual([]);
  });

  it("leaves the browser utterance route unchanged while the secret is set", async () => {
    process.env.ROOMY_INGEST_SECRET = SECRET;
    await start();
    const room = seed("browser-room");

    // No secret header, and the route still behaves exactly as it did before T8.
    expect((await post("/r/browser-room/utterance", { speaker: "Ada", text: "still works" })).status).toBe(200);
    expect((await post("/r/browser-room/utterance", { text: "no speaker" })).status).toBe(200);
    expect((await post("/r/browser-room/utterance", { speaker: "Ada" })).status).toBe(400);
    // A stray secret header is neither required nor honoured as identity.
    expect((await post("/r/browser-room/utterance", { speaker: "Lin", text: "third" }, "nope")).status).toBe(200);

    expect(room.exportData.utterances.map((u) => [u.speaker, u.text])).toEqual([
      ["Ada", "still works"],
      ["Someone", "no speaker"],
      ["Lin", "third"],
    ]);
  });

  it("never logs or echoes the secret", async () => {
    process.env.ROOMY_INGEST_SECRET = SECRET;
    await start();
    seed("quiet-room");
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }

    const responses = [
      await post("/r/quiet-room/ingest", { speaker: "Bot", text: "accepted" }, SECRET),
      await post("/r/quiet-room/ingest", { speaker: "Bot", text: "refused" }, "nope"),
      await post("/r/quiet-room/ingest", "{", SECRET),
      await fetch(`${base}/r/quiet-room/ingest`),
    ];
    for (const response of responses) {
      const seen = [await response.text()];
      response.headers.forEach((value, key) => seen.push(key, value));
      expect(seen.join(" ")).not.toContain(SECRET);
    }
    expect(logged.join("\n")).not.toContain(SECRET);
  });
});

describe("the ingest demo script", () => {
  it("posts a fixture into a running room from outside the process, without printing the secret", async () => {
    process.env.ROOMY_INGEST_SECRET = SECRET;
    await start();
    const room = seed("demo-room");

    const root = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/ingest-demo.ts", "demo-room", "incident-review", "2000"],
      {
        cwd: root,
        env: { ...process.env, ROOMY_URL: base, ROOMY_INGEST_SECRET: SECRET },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    const code = await new Promise((resolve) => child.on("exit", resolve));

    expect(code).toBe(0);
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/ingested incident-review at 2000x/);

    const heard = room.exportData.utterances;
    expect(heard.length).toBeGreaterThan(5);
    // The speaker is what the poster supplied, not an identity inherited from a connection.
    expect(new Set(heard.map((u) => u.speaker)).size).toBeGreaterThan(1);
  }, 15_000);

  it("refuses to run without a secret rather than posting unauthenticated", async () => {
    await start();
    const root = fileURLToPath(new URL("..", import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, ROOMY_URL: base };
    delete env.ROOMY_INGEST_SECRET;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/ingest-demo.ts", "demo-room", "incident-review", "2000"],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (err += chunk));
    const code = await new Promise((resolve) => child.on("exit", resolve));

    expect(code).not.toBe(0);
    expect(err).toContain("ROOMY_INGEST_SECRET");
    expect(server?.rooms.has("demo-room")).toBe(false);
  }, 15_000);
});
