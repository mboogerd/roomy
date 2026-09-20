import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval } from "../src/eval.ts";
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

const longUtterance = (text = "A deterministic scenario utterance with enough detail to form a complete segment. It intentionally contains more than forty characters so it commits cleanly in the journal tests."): Utterance => ({
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
  it("has all three fixtures", () => {
    expect(fixtureFiles).toEqual([
      "architecture-debate.json",
      "incident-review.json",
      "product-brainstorm.json",
    ]);
  });

  it.each(fixtureFiles)("replays %s without timers or network", async (file) => {
    const fixture = readFixture(file);
    const stub = new StubLlm();
    const room = new Room(stub);
    const messages: ServerMsg[] = [];
    room.subscribe((message) => messages.push(message));

    // Flush after each utterance to keep the deterministic scenario surface simple.
    // The journal itself still segments server speech by pause and speaker change.
    for (const utterance of fixture.utterances) {
      room.say(utterance);
      await room.maybeTick();
    }
    await room.maybeTick();

    expect(messages.filter((message) => message.type === "utterance").map((message) => message.utterance))
      .toEqual(fixture.utterances);

    const ticks = stub.calls.filter((call) => call.method === "tick" || call.method === "restructure");
    expect(ticks.length).toBeGreaterThan(1);
    expect(stub.calls.some((call) => call.method === "summarize")).toBe(true);

    expect(room.state.blocks.length).toBeGreaterThan(0);
    for (const block of room.state.blocks) {
      expect(validateOp({ op: "upsert", ...block }).ok).toBe(true);
    }

    const revisions = messages
      .filter((message): message is Extract<ServerMsg, { type: "state" }> => message.type === "state")
      .map((message) => message.state.rev);
    expect(revisions.length).toBe(ticks.length + 1); // the subscribe snapshot, then one per applied batch
    for (let i = 1; i < revisions.length; i++) expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
  });

  it("constructs with no argument and keeps the real LLM out until speech arrives", async () => {
    const room = new Room();
    const messages: ServerMsg[] = [];
    room.subscribe((message) => messages.push(message));
    room.start();
    room.stop();
    expect(room.state).toEqual({ blocks: [], rev: 0 });
    expect(messages.filter((message) => message.type === "utterance")).toHaveLength(0);
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
      speculate: async () => [],
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

describe("eval harness", () => {
  const outDir = () => mkdtempSync(join(tmpdir(), "roomy-eval-"));

  it("writes a fenced report and prints the summary line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stub = new StubLlm();
    stub.queueTick([flow("outage-timeline", "flowchart TD\n  Alert --> Pager")]);

    const { reportPath, summaryLine } = await runEval("incident-review", { llm: stub, outDir: outDir() });

    expect(log).toHaveBeenCalledWith(summaryLine);
    log.mockRestore();

    for (const field of [
      "fixture=", "calls=", "ops applied=", "ops rejected=", "blocks by kind=",
      "segments committed=", "segments carried forward=", "speculative calls made=",
      "speculative results discarded as stale=", "amend would have mattered=",
      "wall time=", "tokens input=",
    ])
      expect(summaryLine).toContain(field);
    expect(summaryLine).toContain(`calls=${stub.stats.calls}`);
    expect(summaryLine).toContain(`tokens input=${stub.stats.usage.input}`);

    const report = readFileSync(reportPath, "utf8");
    expect(report.startsWith("# Eval: incident-review")).toBe(true);
    expect(report).toContain("## outage-timeline\n\n```mermaid\nflowchart TD\n  Alert --> Pager\n```");
    expect(report).toContain("```markdown"); // the stub's default blocks
    expect(report.trimEnd().endsWith(summaryLine)).toBe(true);
  });

  it("fails fast with a clear message when the LLM errors", async () => {
    const stub = new StubLlm().queueTick(new Error("transport exploded"));
    await expect(runEval("incident-review", { llm: stub, outDir: outDir() }))
      .rejects.toThrow(/LLM transport error:.*transport exploded/);
  });

  it("rejects an unknown fixture rather than reaching for the network", async () => {
    await expect(runEval("no-such-fixture", { llm: new StubLlm(), outDir: outDir() }))
      .rejects.toThrow(/could not read fixture "no-such-fixture"/);
  });
});
