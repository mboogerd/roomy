import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { validateOp } from "../src/canvas.ts";
import { Room, type ServerMsg } from "../src/room.ts";
import type { Llm } from "../src/llm.ts";
import type { Fixture, Utterance } from "../src/transcript.ts";
import { StubLlm } from "./stub-llm.ts";

const fixtureFiles = readdirSync("src/fixtures")
  .filter((file) => file.endsWith(".json"))
  .sort();

const readFixture = (file: string): Fixture =>
  JSON.parse(readFileSync(`src/fixtures/${file}`, "utf8")) as Fixture;

const longUtterance = (text = "A deterministic scenario utterance with enough detail to cross the room tick threshold. It intentionally contains more than one hundred and twenty characters so the normal Room threshold starts a tick."): Utterance => ({
  t_ms: 0,
  speaker: "Test",
  text,
});

const flow = (id: string, source = "flowchart TD\n  A --> B") => ({
  op: "upsert",
  id,
  kind: "mermaid",
  title: id,
  source,
});

describe("Room scenarios", () => {
  it.each(fixtureFiles)("replays %s without timers or network", async (file) => {
    const fixture = readFixture(file);
    const room = new Room(new StubLlm());
    const messages: ServerMsg[] = [];
    room.subscribe((message) => messages.push(message));

    for (const utterance of fixture.utterances) room.say(utterance);
    await room.maybeTick();

    expect(messages.filter((message) => message.type === "utterance").map((message) => message.utterance))
      .toEqual(fixture.utterances);
    expect(room.state.blocks.length).toBeGreaterThan(0);
    for (const block of room.state.blocks) {
      expect(validateOp({ op: "upsert", ...block }).ok).toBe(true);
    }

    const revisions = messages
      .filter((message): message is Extract<ServerMsg, { type: "state" }> => message.type === "state")
      .map((message) => message.state.rev);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
  });

  it("applies good ops and counts malformed ops from the same batch", async () => {
    const stub = new StubLlm();
    const room = new Room(stub);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stub.queueTick([
      { op: "upsert", id: "bad", kind: "mermaid", title: "Bad", source: "not mermaid" },
      flow("good"),
    ]);

    room.say(longUtterance());
    await room.maybeTick();

    expect(room.state.blocks.map((block) => block.id)).toEqual(["good"]);
    expect(room.metrics.opsApplied).toBe(1);
    expect(room.metrics.rejectedReasons).toEqual(["unknown mermaid diagram type: not mermaid"]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("repairs a render failure when queued and deletes it when repair is empty", async () => {
    const repaired = flow("diagram", "flowchart TD\n  A --> C");
    const stub = new StubLlm().queueTick([flow("diagram")]).queueRepair([repaired]);
    const room = new Room(stub);
    room.say(longUtterance());
    await room.maybeTick();
    await room.renderFailed("diagram", "parse error");
    expect(room.state.blocks[0].source).toBe(repaired.source);

    const deleteStub = new StubLlm().queueTick([flow("diagram")]);
    const deleteRoom = new Room(deleteStub);
    deleteRoom.say(longUtterance());
    await deleteRoom.maybeTick();
    await deleteRoom.renderFailed("diagram", "parse error");
    expect(deleteRoom.state.blocks).toEqual([]);
  });

  it("retries a failed LLM call with its utterances still pending", async () => {
    const good = flow("retried");
    const stub = new StubLlm().queueTick(new Error("temporary transport failure"), [good]);
    const room = new Room(stub);
    room.say(longUtterance());

    await room.maybeTick();
    expect(room.state.blocks).toEqual([]);
    await room.maybeTick();

    expect(room.state.blocks.map((block) => block.id)).toEqual(["retried"]);
    const tickCalls = stub.calls.filter((call) => call.method === "tick");
    expect(tickCalls).toHaveLength(2);
    expect(tickCalls[1].window?.some((utterance) => utterance.text === longUtterance().text)).toBe(true);
  });

  it("waits for an in-flight tick when called again", async () => {
    let resolveTick!: (ops: unknown[]) => void;
    const tick = new Promise<unknown[]>((resolve) => { resolveTick = resolve; });
    const llm: Llm = {
      tick: async () => tick,
      restructure: async () => [],
      summarize: async () => "",
      repair: async () => [],
    };
    const room = new Room(llm);
    room.say(longUtterance());

    const first = room.maybeTick();
    let secondFinished = false;
    const second = room.maybeTick().then(() => { secondFinished = true; });
    await Promise.resolve();
    expect(secondFinished).toBe(false);

    resolveTick([flow("done")]);
    await Promise.all([first, second]);
    expect(room.state.blocks.map((block) => block.id)).toEqual(["done"]);
  });
});
