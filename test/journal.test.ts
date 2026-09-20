import { afterEach, describe, expect, it, vi } from "vitest";
import { Room, SEGMENT_MAX_CHARS, SEGMENT_PAUSE_MS } from "../src/room.ts";
import { StubLlm } from "./stub-llm.ts";

const flow = (id: string, source = "flowchart TD\n  A --> B") => ({
  op: "upsert",
  id,
  kind: "mermaid",
  title: id,
  source,
});

const utterance = (speaker: string, text: string, t_ms = 0) => ({ t_ms, speaker, text });

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("journal snapshots and speculation", () => {
  it("never stores a speculative result in the stable snapshot", async () => {
    const stub = new StubLlm()
      .queueSpeculate([flow("live")])
      .queueTick([flow("committed")]);
    const room = new Room(stub);

    room.say(utterance("Ada", "The live thought is long enough to draw provisionally."));
    await flush();

    expect(room.stable.blocks).toEqual([]);
    expect(room.entries).toHaveLength(0);
    expect(room.state.blocks.map((block) => block.id)).toEqual(["live"]);

    await room.maybeTick();
    expect(room.stable.blocks.map((block) => block.id)).toEqual(["committed"]);
    room.stop();
  });

  it("replaces the overlay instead of accumulating speculative blocks", async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    const third = deferred<unknown[]>();
    const source = "flowchart TD\n  A --> B";
    const changed = "flowchart TD\n  A --> C";
    const stub = new StubLlm().queueSpeculate(first.promise, second.promise, third.promise);
    const room = new Room(stub);
    const states: string[] = [];
    room.subscribe((message) => {
      if (message.type === "state" && message.speculative?.length) {
        states.push(message.state.blocks.find((block) => block.id === "same")?.source ?? "");
      }
    });

    room.say(utterance("Ada", "first"));
    await flush();
    room.say(utterance("Ada", "second"));
    expect(stub.calls.filter((call) => call.method === "speculate")).toHaveLength(1);
    first.resolve([flow("same", source)]);
    await flush();

    room.say(utterance("Ada", "third"));
    second.resolve([flow("same", source)]);
    await flush();
    third.resolve([flow("same", changed)]);
    await flush();

    expect(states.filter(Boolean)).toEqual([source, source, changed]);
    expect(room.state.blocks.filter((block) => block.id === "same")).toHaveLength(1);
    expect(room.state.blocks.find((block) => block.id === "same")?.source).toBe(changed);
    room.stop();
  });

  it("gives both speculative and commit calls the stable canvas, never the overlay", async () => {
    const stub = new StubLlm()
      .queueSpeculate([flow("provisional")], [flow("provisional-2")])
      .queueTick([flow("settled")]);
    const room = new Room(stub);

    room.say(utterance("Ada", "The first part of a thought."));
    await flush();
    room.say(utterance("Ada", "and the second part."));
    await flush();
    await room.maybeTick();

    const specCalls = stub.calls.filter((call) => call.method === "speculate");
    const commitCalls = stub.calls.filter((call) => call.method === "tick");
    expect(specCalls.length).toBeGreaterThanOrEqual(2);
    expect(specCalls.every((call) => !!call.state?.blocks)).toBe(true);
    expect(specCalls.every((call) => !call.state?.blocks.some((block) => block.id.startsWith("provisional")))).toBe(true);
    expect(commitCalls[0]?.state?.blocks).toEqual([]);
    room.stop();
  });
});

describe("segmentation policy", () => {
  it("closes a segment after a pause", async () => {
    vi.useFakeTimers();
    const stub = new StubLlm();
    const room = new Room(stub);
    room.say(utterance("Ada", "A complete thought that should commit after a pause."));
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS + 1);
    await flush();

    expect(room.metrics.segmentsCommitted).toBe(1);
    expect(stub.calls.filter((call) => call.method === "tick")).toHaveLength(1);
    room.stop();
  });

  it("closes the old segment when the speaker changes", async () => {
    const stub = new StubLlm();
    const room = new Room(stub);
    room.say(utterance("Ada", "A complete thought from Ada."));
    room.say(utterance("Lin", "A complete thought from Lin.", 100));
    await room.maybeTick();

    expect(room.metrics.segmentsCommitted).toBe(2);
    expect(room.entries.map((entry) => entry.segment.speaker)).toEqual(["Ada", "Lin"]);
    room.stop();
  });

  it("closes a segment that exceeds the length cap", async () => {
    const stub = new StubLlm();
    const room = new Room(stub);
    room.say(utterance("Ada", "x".repeat(SEGMENT_MAX_CHARS + 1)));
    await room.maybeTick();

    expect(room.metrics.segmentsCommitted).toBe(1);
    expect(room.entries[0]?.segment.text.length).toBe(SEGMENT_MAX_CHARS + 1);
    room.stop();
  });

  it("carries a short paused segment into the next segment from that speaker", async () => {
    vi.useFakeTimers();
    const stub = new StubLlm();
    const room = new Room(stub);
    room.say(utterance("Ada", "yes"));
    await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS + 1);
    await flush();
    expect(room.metrics.segmentsCarriedForward).toBe(1);
    expect(room.metrics.segmentsCommitted).toBe(0);

    room.say(utterance("Ada", "and here is the rest of the thought."));
    await room.maybeTick();
    const tick = stub.calls.find((call) => call.method === "tick");
    expect(tick?.window?.map((part) => part.text)).toEqual(["yes", "and here is the rest of the thought."]);
    room.stop();
  });
});

describe("speculation concurrency and stale results", () => {
  it("allows one in-flight call and follows it with only the latest text", async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    const stub = new StubLlm().queueSpeculate(first.promise, second.promise);
    const room = new Room(stub);
    room.say(utterance("Ada", "start"));
    await flush();

    for (let i = 0; i < 5; i++) room.say(utterance("Ada", `word-${i}`));
    expect(stub.calls.filter((call) => call.method === "speculate")).toHaveLength(1);

    first.resolve([flow("preview")]);
    await flush();
    const calls = stub.calls.filter((call) => call.method === "speculate");
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain("word-4");
    second.resolve([]);
    await flush();
    room.stop();
  });

  it("discards a speculative result that arrives after commit", async () => {
    const pending = deferred<unknown[]>();
    const stub = new StubLlm()
      .queueSpeculate(pending.promise)
      .queueTick([flow("settled")]);
    const room = new Room(stub);
    room.say(utterance("Ada", "This thought will be committed before speculation returns."));
    await flush();
    await room.maybeTick();

    pending.resolve([flow("stale")]);
    await flush();
    expect(room.metrics.speculativeResultsDiscarded).toBe(1);
    expect(room.state.blocks.map((block) => block.id)).toEqual(["settled"]);
    room.stop();
  });

  it("counts a same-speaker resumption within two seconds of a commit", async () => {
    const room = new Room(new StubLlm());
    room.say(utterance("Ada", "A thought that is committed now.", 0));
    await room.maybeTick();
    room.say(utterance("Ada", "I have one more detail.", 1500));
    expect(room.metrics.amendWouldHaveMattered).toBe(1);
    room.stop();
  });
});
