import { applyOps, emptyCanvas, type CanvasState } from "./canvas.ts";
import type { Utterance } from "./transcript.ts";
import { realLlm, type Llm } from "./llm.ts";

export const TICK_MS = 8000;         // how often we consider updating the canvas
export const MIN_NEW_CHARS = 120;    // below this, a tick is almost certainly not worth a call
export const SUMMARY_EVERY = 4;      // ticks between rolling-summary refreshes
export const RESTRUCTURE_EVERY = 15; // ticks between full-canvas rethinks (~2 min)

type Listener = (msg: ServerMsg) => void;

// What eval.ts reports on; the server ignores it.
// ponytail: rejectedReasons grows for the life of the room. Fine for a fixture run and
// for a meeting-length session; cap it or aggregate into counts if rooms become long-lived.
export interface RoomMetrics {
  opsApplied: number;
  rejectedReasons: string[];
}

export type ServerMsg =
  // Full state on every change, plus which ids moved, so the client needs no op applier.
  | { type: "state"; state: CanvasState; changed: string[] }
  | { type: "utterance"; utterance: Utterance }
  | { type: "status"; busy: boolean; note?: string };

/** One conversation. In-memory, single instance. Persistence is not a PoC concern. */
export class Room {
  state: CanvasState = emptyCanvas();
  summary = "";
  readonly metrics: RoomMetrics = { opsApplied: 0, rejectedReasons: [] };
  private pending: Utterance[] = [];      // said since the last tick
  private sinceSummary: Utterance[] = []; // said since the last summary refresh
  private recent: Utterance[] = [];       // trailing context for the tick window
  private inFlight?: Promise<void>;
  private ticks = 0;
  private listeners = new Set<Listener>();
  private timer?: NodeJS.Timeout;
  private readonly llm: Llm;

  constructor(llm: Llm = realLlm) {
    this.llm = llm;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn({ type: "state", state: this.state, changed: [] });
    return () => this.listeners.delete(fn);
  }

  private emit(msg: ServerMsg) {
    for (const fn of this.listeners) fn(msg);
  }

  say(u: Utterance) {
    this.pending.push(u);
    this.sinceSummary.push(u);
    this.emit({ type: "utterance", utterance: u });
  }

  start() {
    this.timer ??= setInterval(() => void this.maybeTick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  reset() {
    this.state = emptyCanvas();
    this.summary = "";
    this.metrics.opsApplied = 0;
    this.metrics.rejectedReasons = [];
    this.pending = [];
    this.sinceSummary = [];
    this.recent = [];
    this.ticks = 0;
    this.emit({ type: "state", state: this.state, changed: [] });
  }

  /**
   * Runs one tick and resolves once the LLM work it waited on is done. Never starts a
   * second tick concurrently — a backlog of stale windows helps nobody — so a call made
   * while one is in flight just awaits that one.
   */
  async maybeTick() {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    const newChars = this.pending.reduce((n, u) => n + u.text.length, 0);
    if (newChars < MIN_NEW_CHARS) return;

    const window = [...this.recent.slice(-4), ...this.pending];
    this.recent = [...this.recent, ...this.pending].slice(-12);
    const consumed = this.pending;
    this.pending = [];
    this.ticks++;

    const work = this.runTick(window, consumed);
    this.inFlight = work;
    try {
      await work;
    } finally {
      if (this.inFlight === work) this.inFlight = undefined;
    }
  }

  private async runTick(window: Utterance[], consumed: Utterance[]) {
    this.emit({ type: "status", busy: true });
    try {
      const restructuring = this.ticks % RESTRUCTURE_EVERY === 0;
      const ops = restructuring
        ? await this.llm.restructure(this.state, this.summary)
        : await this.llm.tick(this.state, window, this.summary);
      this.commit(ops);

      if (this.ticks % SUMMARY_EVERY === 0 && this.sinceSummary.length) {
        this.summary = await this.llm.summarize(this.summary, this.sinceSummary);
        this.sinceSummary = [];
      }
    } catch (err) {
      // Put the window back so a transient API failure does not lose the conversation.
      this.pending = [...consumed, ...this.pending];
      this.emit({ type: "status", busy: false, note: String(err) });
      return;
    }
    this.emit({ type: "status", busy: false });
  }

  commit(ops: unknown[]) {
    const result = applyOps(this.state, ops);
    this.state = result.state;
    this.metrics.opsApplied += result.applied.length;
    this.metrics.rejectedReasons.push(...result.rejected);
    if (result.rejected.length) console.warn("rejected ops:", result.rejected);
    if (result.applied.length) {
      const changed = result.applied.flatMap((o) => (o.op === "reorder" ? o.ids : [o.id]));
      this.emit({ type: "state", state: this.state, changed });
    }
  }

  /** The browser is the authority on whether mermaid actually renders. One retry, then drop. */
  async renderFailed(id: string, error: string) {
    const block = this.state.blocks.find((b) => b.id === id);
    if (!block) return;
    try {
      const ops = await this.llm.repair(id, block.source, error);
      if (ops.length) this.commit(ops);
      else this.commit([{ op: "delete", id }]);
    } catch {
      this.commit([{ op: "delete", id }]);
    }
  }
}
