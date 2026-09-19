/**
 * Deterministic LLM test double for the Room pipeline.
 *
 * Each operation has a queue: call `queueTick([op, ...])`, `queueRestructure([...])`,
 * `queueSummarize("summary")`, or `queueRepair([op, ...])` before driving the room.
 * Queue an `Error` to make that call reject. Unqueued tick calls return one markdown
 * upsert derived from the utterances they received; unqueued repairs return no ops.
 * `calls` records inputs for scenario assertions. T3 can extend these queues and
 * T7 can use the recorded inputs when it extends the prompt seam.
 */

import type { CanvasState } from "../src/canvas.ts";
import type { Llm } from "../src/llm.ts";
import type { Utterance } from "../src/transcript.ts";

type Scripted<T> = T | Error;

export interface StubCall {
  method: "tick" | "restructure" | "summarize" | "repair";
  state?: CanvasState;
  window?: Utterance[];
  summary?: string;
  previous?: string;
  id?: string;
  source?: string;
  error?: string;
}

const copyState = (state: CanvasState): CanvasState => ({
  rev: state.rev,
  blocks: state.blocks.map((block) => ({ ...block })),
});

export class StubLlm implements Llm {
  readonly calls: StubCall[] = [];
  private readonly tickQueue: Array<Scripted<unknown[]>> = [];
  private readonly restructureQueue: Array<Scripted<unknown[]>> = [];
  private readonly summaryQueue: Array<Scripted<string>> = [];
  private readonly repairQueue: Array<Scripted<unknown[]>> = [];
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

  async tick(state: CanvasState, window: Utterance[], summary: string): Promise<unknown[]> {
    this.calls.push({ method: "tick", state: copyState(state), window: window.slice(), summary });
    const scripted = this.tickQueue.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;

    const id = `tick-${this.nextDefaultId++}`;
    const text = window.map((u) => `${u.speaker}: ${u.text}`).join("\n").trim() || "No new utterances";
    return [{
      op: "upsert",
      id,
      kind: "markdown",
      title: `Tick ${id.slice("tick-".length)}`,
      source: `### Conversation\n\n${text}`,
    }];
  }

  async restructure(state: CanvasState, summary: string): Promise<unknown[]> {
    this.calls.push({ method: "restructure", state: copyState(state), summary });
    const scripted = this.restructureQueue.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    const id = `restructure-${this.nextDefaultId++}`;
    return [{ op: "upsert", id, kind: "markdown", title: "Restructure", source: `### Canvas\n\n${summary || "Updated canvas"}` }];
  }

  async summarize(previous: string, window: Utterance[]): Promise<string> {
    this.calls.push({ method: "summarize", previous, window: window.slice() });
    const scripted = this.summaryQueue.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined) return scripted;
    return [previous, ...window.map((u) => u.text)].filter(Boolean).join(" ");
  }

  async repair(id: string, source: string, error: string): Promise<unknown[]> {
    this.calls.push({ method: "repair", id, source, error });
    const scripted = this.repairQueue.shift();
    if (scripted instanceof Error) throw scripted;
    return scripted ?? [];
  }
}
