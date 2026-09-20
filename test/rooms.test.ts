import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
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

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function address() {
  const addr = await server?.ready.then((s) => s.address());
  if (!addr || typeof addr === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${addr.port}`;
}

/** Poll until `check` returns something truthy, or give up. */
async function until<T>(check: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await wait(10);
  }
  throw new Error("timed out waiting for condition");
}

async function connect(slug: string, name: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/r/${slug}/events?name=${encodeURIComponent(name)}`, {
    signal: controller.signal,
  });
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

async function closeServer() {
  for (const stream of streams.splice(0)) await closeStream(stream);
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  }
  server = undefined;
}

afterEach(async () => {
  await closeServer();
});

describe("rooms and participants", () => {
  it("redirects to a slug and isolates named SSE conversations", async () => {
    server = startServer(0, { reapMs: 1000 });
    await server.ready;
    base = await address();

    const root = await fetch(base, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toMatch(/^\/r\/[a-z0-9]{6,}$/);
    expect((await fetch(`${base}/r/Bad`)).status).toBe(404);

    const a = await connect("shared-room", "A");
    expect((await nextMessage(a)).type).toBe("state");
    expect((await nextMessage(a)).people).toEqual(["A"]);

    const b = await connect("shared-room", "B");
    expect((await nextMessage(b)).type).toBe("state");
    expect((await nextMessage(a)).people).toEqual(["A", "B"]);
    expect((await nextMessage(b)).people).toEqual(["A", "B"]);

    const other = await connect("other-room", "C");
    await nextMessage(other);
    await nextMessage(other);

    const posted = await fetch(`${base}/r/shared-room/utterance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ speaker: "A", text: "A shared thought" }),
    });
    expect(posted.ok).toBe(true);
    expect((await nextMessage(a)).utterance).toMatchObject({ speaker: "A", text: "A shared thought" });
    expect((await nextMessage(b)).utterance).toMatchObject({ speaker: "A", text: "A shared thought" });
    await expect(nextMessage(other, 60)).rejects.toThrow(/timed out/);

    await closeStream(a);
    expect((await nextMessage(b)).people).toEqual(["B"]);
  });

  it("reaps an idle room and stops it", async () => {
    server = startServer(0, { reapMs: 20 });
    await server.ready;
    base = await address();

    expect((await fetch(`${base}/r/reap-me`)).ok).toBe(true);
    const entry = server.rooms.get("reap-me");
    if (!entry) throw new Error("room was not registered");
    const stop = vi.spyOn(entry.room, "stop");

    await wait(60);
    expect(server.rooms.has("reap-me")).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(entry.reapTimer).toBeUndefined();
  });

  it("replays into only the requested room", async () => {
    server = startServer(0, { reapMs: 1000 });
    await server.ready;
    base = await address();

    const target = await connect("replay-room", "A");
    await nextMessage(target);
    await nextMessage(target);
    const other = await connect("untouched-room", "B");
    await nextMessage(other);
    await nextMessage(other);

    const response = await fetch(`${base}/r/replay-room/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixture: "incident-review", speed: 1_000_000 }),
    });
    expect(response.ok).toBe(true);
    expect((await nextMessage(target)).type).toBe("state");
    expect((await nextMessage(target)).type).toBe("utterance");
    await expect(nextMessage(other, 60)).rejects.toThrow(/timed out/);
  });
});

describe("the replay script", () => {
  it("still drives a room with `npm run replay -- incident-review 12`", async () => {
    server = startServer(0, { reapMs: 5000 });
    await server.ready;
    base = await address();

    const root = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/replay.ts", "incident-review", "12"],
      { cwd: root, env: { ...process.env, ROOMY_URL: base }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);

    // No slug given, so the script follows / to a fresh room and says which one.
    expect(out).toMatch(/replaying incident-review at 12x — watch http:\/\/127\.0\.0\.1:\d+\/r\/[a-z0-9]{6,}/);
    expect(server.rooms.size).toBe(1);

    const entry = [...server.rooms.values()][0];
    const heard: string[] = [];
    entry.room.subscribe((msg) => {
      if (msg.type === "utterance") heard.push(msg.utterance.text);
    });
    await until(() => heard.length > 0);
  }, 15_000);
});

// ponytail: the client has no build step, so the name bootstrap is lifted out of the page
// and run in a vm with stub globals. A jsdom harness is the upgrade if the client grows.
describe("the client's identity", () => {
  const html = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");

  function bootstrap(stored: Map<string, string>, answer: string | null) {
    const source = /const nameKey[\s\S]*?\n\}\n/.exec(html)?.[0];
    if (!source) throw new Error("no name bootstrap found in public/index.html");
    let asked = 0;
    const context = createContext({
      localStorage: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => void stored.set(k, v),
      },
      window: { prompt: () => { asked++; return answer; } },
    });
    return { name: runInContext(`${source}\nname`, context) as string, asked };
  }

  it("asks once when no name is stored, then remembers it across reloads", () => {
    const stored = new Map<string, string>();
    const first = bootstrap(stored, "Ada");
    expect(first).toEqual({ name: "Ada", asked: 1 });

    const reload = bootstrap(stored, "Someone else");
    expect(reload).toEqual({ name: "Ada", asked: 0 });
  });

  it("falls back to a name when the prompt is dismissed", () => {
    expect(bootstrap(new Map(), null)).toEqual({ name: "Someone", asked: 1 });
  });

  it("sends that name on the SSE connection and on every utterance", () => {
    expect(html).toContain('searchParams.set("name", name)');
    expect(html).toContain('post("utterance", { speaker: name, text })');
    expect(html).not.toContain('id="speaker"');
  });
});
