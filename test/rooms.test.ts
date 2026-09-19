import { afterEach, describe, expect, it, vi } from "vitest";
import { Room } from "../src/room.ts";
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
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server has no TCP address");
    base = `http://127.0.0.1:${address.port}`;

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
    const made: Room[] = [];
    server = startServer(0, {
      reapMs: 20,
      roomFactory: () => {
        const room = new Room();
        vi.spyOn(room, "stop");
        made.push(room);
        return room;
      },
    });
    await server.ready;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server has no TCP address");
    base = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${base}/r/reap-me`)).ok).toBe(true);
    expect(server.rooms.has("reap-me")).toBe(true);
    await wait(60);
    expect(server.rooms.has("reap-me")).toBe(false);
    expect(made[0].stop).toHaveBeenCalledTimes(1);
  });

  it("replays into only the requested room", async () => {
    server = startServer(0, { reapMs: 1000 });
    await server.ready;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server has no TCP address");
    base = `http://127.0.0.1:${address.port}`;

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
