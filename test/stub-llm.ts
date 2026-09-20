/**
 * Deterministic LLM test double for the Room pipeline.
 *
 * Each operation has a queue: call `queueTick([op, ...])`, `queueRestructure([...])`,
 * `queueSummarize("summary")`, `queueRepair([op, ...])`, or
 * `queueSpeculate([op, ...])` before driving the room. A Promise can be queued when a
 * test needs to resolve a call on demand.
 * Queue an `Error` to make that call reject. Unqueued tick calls return one markdown
 * upsert derived from the utterances they received; unqueued repairs return no ops.
 * `calls` records inputs for scenario assertions and `stats` mirrors the real
 * implementation's call and token counters so the eval harness can run offline.
 * T3 can extend these queues and T7 can use the recorded inputs when it extends
 * the prompt seam.
 */

import type { CanvasState } from "../src/canvas.ts";
import type { Llm, LlmStats } from "../src/llm.ts";
import type { Utterance } from "../src/transcript.ts";

type Scripted<T> = T | Error | Promise<T>;

export interface StubCall {
  method: "tick" | "restructure" | "summarize" | "repair" | "speculate";
  state?: CanvasState;
  window?: Utterance[];
  summary?: string;
  previous?: string;
  id?: string;
  source?: string;
  error?: string;
  text?: string;
  instruction?: string;
}

const copyState = (state: CanvasState): CanvasState => ({
  rev: state.rev,
  blocks: state.blocks.map((block) => ({ ...block })),
});

export class StubLlm implements Llm {
  readonly calls: StubCall[] = [];
  readonly stats: LlmStats = { calls: 0, usage: { input: 0, output: 0, cacheRead: 0 } };
  private readonly tickQueue: Array<Scripted<unknown[]>> = [];
  private readonly restructureQueue: Array<Scripted<unknown[]>> = [];
  private readonly summaryQueue: Array<Scripted<string>> = [];
  private readonly repairQueue: Array<Scripted<unknown[]>> = [];
  private readonly speculateQueue: Array<Scripted<unknown[]>> = [];
  private nextDefaultId = 1;

  queueTick(...responses: Array<Scripted<unknown[]>>): this {
    this.tickQueue.push(...responses);
    return this;
  }

  queueRestructure(...responses: Array<Scripted<unknown[]>>): this {
    this.restructureQueue.push(...responses);
    return this;
  }

  queueSummarize(...responses: Array<Scripted<string>>): this {
    this.summaryQueue.push(...responses);
    return this;
  }

  queueRepair(...responses: Array<Scripted<unknown[]>>): this {
    this.repairQueue.push(...responses);
    return this;
  }

  queueSpeculate(...responses: Array<Scripted<unknown[]>>): this {
    this.speculateQueue.push(...responses);
    return this;
  }

  /** Every scripted call is counted, the way complete() counts real transport calls. */
  private record(call: StubCall) {
    this.calls.push(call);
    this.stats.calls++;
    this.stats.usage.input += 10;
    this.stats.usage.output += 5;
  }

  async tick(state: CanvasState, window: Utterance[], summary: string): Promise<unknown[]> {
    const instructions = window
      .filter((utterance) => (utterance as Utterance & { instruction?: true }).instruction === true)
      .map((utterance) => utterance.text)
      .join("\n");
    this.record({
      method: "tick",
      state: copyState(state),
      window: window.slice(),
      summary,
      ...(instructions ? { instruction: instructions } : {}),
    });
    const scripted = this.tickQueue.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) return await scripted;

    const id = `tick-${this.nextDefaultId++}`;
    const text = window
      .filter((utterance) => (utterance as Utterance & { instruction?: true }).instruction !== true)
      .map((u) => `${u.speaker}: ${u.text}`)
      .join("\n")
      .trim() || "No new utterances";
    return [{
      op: "upsert",
      id,
      kind: "markdown",
      title: `Tick ${id.slice("tick-".length)}`,
      source: `### Conversation\n\n${text}`,
    }];
  }

  async restructure(state: CanvasState, summary: string): Promise<unknown[]> {
    this.record({ method: "restructure", state: copyState(state), summary });
    const scripted = this.restructureQueue.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) return await scripted;
    const id = `restructure-${this.nextDefaultId++}`;
    return [{ op: "upsert", id, kind: "markdown", title: "Restructure", source: `### Canvas\n\n${summary || "Updated canvas"}` }];
  }

  async summarize(previous: string, window: Utterance[]): Promise<string> {
    this.record({ method: "summarize", previous, window: window.slice() });
    const scripted = this.summaryQueue.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) return await scripted;
    return [previous, ...window.map((u) => u.text)].filter(Boolean).join(" ");
  }

  async repair(id: string, source: string, error: string): Promise<unknown[]> {
    this.record({ method: "repair", id, source, error });
    const scripted = this.repairQueue.shift();
    if (scripted instanceof Error) throw scripted;
    return scripted === undefined ? [] : await scripted;
  }

  async speculate(state: CanvasState, text: string): Promise<unknown[]> {
    this.record({ method: "speculate", state: copyState(state), text });
    const scripted = this.speculateQueue.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) return await scripted;
    const id = `speculate-${this.nextDefaultId++}`;
    return [{
      op: "upsert",
      id,
      kind: "markdown",
      title: `Speculation ${id.slice("speculate-".length)}`,
      source: `### Live thought\n\n${text || "No live text"}`,
    }];
  }
}
