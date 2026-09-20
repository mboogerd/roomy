import { afterEach, describe, expect, it, vi } from "vitest";
import { Room, RESTRUCTURE_EVERY, SEGMENT_MAX_CHARS, SEGMENT_PAUSE_MS, SUMMARY_EVERY, type ServerMsg } from "../src/room.ts";
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
      .queueSpeculate([flow("discarded")], [flow("live")])
      .queueTick([flow("committed")], [flow("committed-2")]);
    const room = new Room(stub);

    room.say(utterance("Ada", "A first thought that is long enough to commit on its own."));
    await room.maybeTick();
    const stored = JSON.parse(JSON.stringify(room.entries[0]?.snapshot));
    expect(stored.blocks.map((block: { id: string }) => block.id)).toEqual(["committed"]);

    room.say(utterance("Ada", "A second thought, still being spoken.", 100));
    await flush();

    // The overlay is on screen; the journal has not moved.
    expect(room.state.blocks.map((block) => block.id)).toEqual(["committed", "live"]);
    expect(room.stable.blocks.map((block) => block.id)).toEqual(["committed"]);
    expect(room.entries).toHaveLength(1);
    expect(room.entries[0].snapshot).toEqual(stored);

    await room.maybeTick();
    expect(room.stable.blocks.map((block) => block.id)).toEqual(["committed", "committed-2"]);
    expect(room.entries[0].snapshot).toEqual(stored);
    expect(room.entries[1].snapshot.blocks.map((block) => block.id)).toEqual(["committed", "committed-2"]);
    room.stop();
  });

  it("replaces the overlay instead of accumulating speculative blocks", async () => {
    const calls = [deferred<unknown[]>(), deferred<unknown[]>(), deferred<unknown[]>(), deferred<unknown[]>()];
    const source = "flowchart TD\n  A --> B";
    const changed = "flowchart TD\n  A --> C";
    // Three identical speculations, then one that changes the block and drops the aside.
    const unchangedOps = () => [flow("same", source), flow("aside", "flowchart TD\n  X --> Y")];
    const stub = new StubLlm().queueSpeculate(...calls.map((call) => call.promise));
    const room = new Room(stub);
    const shown: Array<{ ids: string[]; source: string }> = [];
    room.subscribe((message) => {
      if (message.type === "state" && message.speculative?.length) {
        shown.push({
          ids: message.state.blocks.map((block) => block.id),
          source: message.state.blocks.find((block) => block.id === "same")?.source ?? "",
        });
      }
    });

    room.say(utterance("Ada", "first"));
    await flush();
    room.say(utterance("Ada", "second"));
    expect(stub.calls.filter((call) => call.method === "speculate")).toHaveLength(1);
    calls[0].resolve(unchangedOps());
    await flush();

    room.say(utterance("Ada", "third"));
    calls[1].resolve(unchangedOps());
    await flush();

    room.say(utterance("Ada", "fourth"));
    calls[2].resolve(unchangedOps());
    await flush();

    calls[3].resolve([flow("same", changed)]);
    await flush();

    expect(stub.calls.filter((call) => call.method === "speculate")).toHaveLength(4);
    expect(shown).toHaveLength(4);
    // Three consecutive speculations, byte-identical source for the unchanged block.
    expect(shown.slice(0, 3).map((state) => state.source)).toEqual([source, source, source]);
    expect(shown.slice(0, 3).every((state) => state.ids.join() === "same,aside")).toBe(true);
    // The fourth replaces the overlay wholesale: changed source, and the block the new
    // speculation no longer emits is gone rather than left behind.
    expect(shown[3]).toEqual({ ids: ["same"], source: changed });
    expect(room.state.blocks.map((block) => block.id)).toEqual(["same"]);
    room.stop();
  });

  it("gives both speculative and commit calls the stable canvas, never the overlay", async () => {
    const stub = new StubLlm()
      .queueSpeculate([flow("dropped-on-commit")], [flow("provisional")], [flow("provisional-2")])
      .queueTick([flow("settled")], [flow("settled-2")]);
    const room = new Room(stub);

    // One committed segment first, so "stable" is something other than the empty canvas.
    room.say(utterance("Ada", "A first thought long enough to commit on its own."));
    await room.maybeTick();
    expect(room.stable.blocks.map((block) => block.id)).toEqual(["settled"]);

    room.say(utterance("Ada", "The first part of a second thought.", 10));
    await flush();
    room.say(utterance("Ada", "and the second part.", 20));
    await flush();
    // The overlay is live and visible right up to the commit.
    expect(room.state.blocks.map((block) => block.id)).toEqual(["settled", "provisional-2"]);
    await room.maybeTick();

    const specCalls = stub.calls.filter((call) => call.method === "speculate");
    const commitCalls = stub.calls.filter((call) => call.method === "tick");
    const ids = (call: { state?: { blocks: Array<{ id: string }> } }) => call.state?.blocks.map((b) => b.id) ?? [];
    expect(specCalls).toHaveLength(3);
    expect(commitCalls).toHaveLength(2);
    // Every call after the first commit sees exactly the stable head.
    expect(ids(specCalls[1])).toEqual(["settled"]);
    expect(ids(specCalls[2])).toEqual(["settled"]);
    expect(ids(commitCalls[1])).toEqual(["settled"]);
    expect(ids(commitCalls[0])).toEqual([]);
    expect([...specCalls, ...commitCalls].every((call) => !ids(call).some((id) => id.startsWith("provisional")))).toBe(true);
    room.stop();
  });

  it("clears the overlay before the commit that closes the segment goes out", async () => {
    const pending = deferred<unknown[]>();
    const stub = new StubLlm().queueSpeculate([flow("provisional")]).queueTick(pending.promise);
    const room = new Room(stub);
    const states: Array<Extract<ServerMsg, { type: "state" }>> = [];
    room.subscribe((message) => { if (message.type === "state") states.push(message); });

    room.say(utterance("Ada", "A thought long enough to commit on its own."));
    await flush();
    expect(room.state.blocks.map((block) => block.id)).toEqual(["provisional"]);

    const done = room.maybeTick();
    await flush();
    // The tick is in flight; the canvas is back to stable, so no commit can ever be
    // computed against an overlay in the first place.
    expect(stub.calls.filter((call) => call.method === "tick")).toHaveLength(1);
    expect(room.state.blocks).toEqual([]);
    expect(states.at(-1)?.speculative).toBeUndefined();

    pending.resolve([flow("settled")]);
    await done;
    expect(room.state.blocks.map((block) => block.id)).toEqual(["settled"]);
    room.stop();
  });
});

describe("what clients see", () => {
  it("names committed block ids in `changed`, and overlay ids in `speculative`", async () => {
    const stub = new StubLlm()
      .queueSpeculate([flow("provisional")])
      .queueTick([flow("timeline")]);
    const room = new Room(stub);
    const states: Array<{ changed: string[]; speculative?: string[] }> = [];
    room.subscribe((message) => {
      if (message.type === "state") states.push({ changed: message.changed, speculative: message.speculative });
    });

    room.say(utterance("Ada", "A thought long enough to commit on its own."));
    await flush();
    expect(states.at(-1)).toEqual({ changed: ["provisional"], speculative: ["provisional"] });

    await room.maybeTick();
    // A commit still tells the client what moved; nothing on screen is provisional now.
    expect(states.at(-1)).toEqual({ changed: ["timeline"], speculative: undefined });
    room.stop();
  });

  it("drops a speculative block that fails to render rather than repairing it into the journal", async () => {
    const stub = new StubLlm()
      .queueSpeculate([flow("discarded")], [flow("provisional", "flowchart TD\n  A --> B")])
      .queueTick([flow("settled")]);
    const room = new Room(stub);
    room.say(utterance("Ada", "A first thought long enough to commit on its own."));
    await room.maybeTick();
    room.say(utterance("Ada", "A second thought, still being spoken.", 100));
    await flush();
    expect(room.state.blocks.map((block) => block.id)).toEqual(["settled", "provisional"]);

    await room.renderFailed("provisional", "parse error");

    expect(stub.calls.some((call) => call.method === "repair")).toBe(false);
    expect(room.stable.blocks.map((block) => block.id)).toEqual(["settled"]);
    expect(room.state.blocks.map((block) => block.id)).toEqual(["settled"]);
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
    room.say(utterance("Ada", "x".repeat(SEGMENT_MAX_CHARS - 1)));
    expect(room.live?.text.length).toBe(SEGMENT_MAX_CHARS - 1); // under the cap, still live

    room.say(utterance("Ada", "xx", 10));
    // The cap closed it on the way in, with no pause and no maybeTick to help.
    expect(room.live).toBeUndefined();
    expect(stub.calls.filter((call) => call.method === "speculate")).toHaveLength(1);

    await room.maybeTick();
    expect(room.metrics.segmentsCommitted).toBe(1);
    expect(room.entries[0]?.segment.text.length).toBe(SEGMENT_MAX_CHARS + 2);
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

describe("commit cadence", () => {
  it("counts restructure and summary cadence in commits, not ticks", async () => {
    const stub = new StubLlm();
    const room = new Room(stub);
    // Alternating speakers, so every utterance is its own segment and every segment commits.
    for (let i = 0; i < RESTRUCTURE_EVERY; i++) {
      room.say(utterance(i % 2 ? "Ada" : "Lin", `Thought number ${i}, long enough to commit on its own.`, i * 10));
    }
    await room.maybeTick();

    expect(room.metrics.segmentsCommitted).toBe(RESTRUCTURE_EVERY);
    const commitPath = stub.calls.filter((call) => call.method === "tick" || call.method === "restructure");
    expect(commitPath.filter((call) => call.method === "restructure")).toHaveLength(1);
    // The rethink is the RESTRUCTURE_EVERY-th commit, not the Nth model call.
    expect(commitPath.findIndex((call) => call.method === "restructure")).toBe(RESTRUCTURE_EVERY - 1);
    expect(stub.calls.filter((call) => call.method === "tick")).toHaveLength(RESTRUCTURE_EVERY - 1);
    expect(stub.calls.filter((call) => call.method === "summarize")).toHaveLength(Math.floor(RESTRUCTURE_EVERY / SUMMARY_EVERY));
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
