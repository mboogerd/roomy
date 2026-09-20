import { applyOps, emptyCanvas, type CanvasState, type Op } from "./canvas.ts";
import type { Utterance } from "./transcript.ts";
import { realLlm, type Llm } from "./llm.ts";

export const SEGMENT_PAUSE_MS = 1500;
export const SEGMENT_MIN_CHARS = 40;
export const SEGMENT_MAX_CHARS = 400;
export const SUMMARY_EVERY = 4;      // commits between rolling-summary refreshes
// Commits that actually *changed the canvas* between full-canvas rethinks. Counting only
// changing commits is the growth check: a stretch of "nothing new to draw" commits must
// not buy a restructure pass. 16 fires about once per fixture-length conversation, late
// enough that the canvas has something to consolidate (at 12 it fired on a two-block
// canvas and had nothing to merge) and early enough that commits still follow it, so a
// churning restructure would be visible in the report.
export const RESTRUCTURE_EVERY = 16;

type Listener = (msg: ServerMsg) => void;

export interface Segment {
  id: number;
  speaker: string;
  text: string;
  utterances: Utterance[];
  openedAt: number;
  closedAt?: number;
  version: number;
}

export interface Entry {
  segment: Segment;
  ops: unknown[];
  snapshot: CanvasState;
  /** The canvas as it was before this entry's ops. Lets a reader diff a restructure. */
  before: CanvasState;
  /** True when this entry's ops came from the restructure pass rather than a tick. */
  restructure?: boolean;
}

/**
 * Did these ops change what a reader sees? An upsert that rewrites a block to the same
 * source, or a reorder on its own, is movement without growth and must not count toward
 * the next restructure pass.
 *
 * ponytail: "changed" is byte equality on title/kind/source. A block reworded without
 * saying anything new still counts as growth. Measuring meaning needs the model, which is
 * the cost this check exists to avoid; the upgrade is to weight by blocks added rather
 * than blocks touched, if churny ticks start buying restructures.
 */
export function canvasGrew(before: CanvasState, after: CanvasState): boolean {
  if (before.blocks.length !== after.blocks.length) return true;
  const previous = new Map(before.blocks.map((block) => [block.id, block]));
  return after.blocks.some((block) => {
    const was = previous.get(block.id);
    return !was || was.source !== block.source || was.title !== block.title || was.kind !== block.kind;
  });
}

// What eval.ts reports on; the server ignores it.
// ponytail: rejectedReasons grows for the life of the room. Fine for a fixture run and
// for a meeting-length session; cap it or aggregate into counts if rooms become long-lived.
export interface RoomMetrics {
  opsApplied: number;
  rejectedReasons: string[];
  segmentsCommitted: number;
  segmentsCarriedForward: number;
  speculativeCallsMade: number;
  speculativeResultsDiscarded: number;
  amendWouldHaveMattered: number;
  /** Full-canvas rethinks that actually ran. */
  restructurePasses: number;
  /** Commits that changed nothing, so they did not count toward the next rethink. */
  commitsWithoutGrowth: number;
}

export type ServerMsg =
  // Full state on every change, plus which ids moved, so the client needs no op applier.
  | { type: "state"; state: CanvasState; changed: string[]; speculative?: string[] }
  | { type: "utterance"; utterance: Utterance }
  | { type: "status"; busy: boolean; note?: string }
  | { type: "presence"; people: string[] };

interface SpeculationResult {
  retry: boolean;
}

interface SpeculationRequest {
  epoch: number;
  stableEpoch: number;
  segmentId: number;
  version: number;
  text: string;
}

interface LastCommit {
  speaker: string;
  closedAt: number;
  counted: boolean;
}

const copyState = (state: CanvasState): CanvasState => ({
  rev: state.rev,
  blocks: state.blocks.map((block) => ({ ...block })),
});

const copyUtterance = (utterance: Utterance): Utterance => ({ ...utterance });

const utteranceText = (utterances: Utterance[]) => utterances.map((u) => u.text).join(" ").trim();

const changedIds = (ops: Op[]) => ops.flatMap((op) => {
  if (op.op === "reorder") return op.ids;
  return [op.id];
});

const speculativeIds = (ops: Op[]) => [...new Set(changedIds(ops))];

/** Raw ops are unvalidated here, so read the id defensively. */
const targets = (op: unknown, id: string) =>
  !!op && typeof op === "object" && (op as { id?: unknown }).id === id;

/** One conversation. In-memory, single instance. Persistence is not a PoC concern. */
export class Room {
  /** The canvas clients see: stable plus the current speculative overlay. */
  state: CanvasState = emptyCanvas();
  /** The journal head. It is never changed by a speculative result. */
  stable: CanvasState = emptyCanvas();
  /** Committed journal entries, oldest first. */
  entries: Entry[] = [];
  /** Full ops for the current live segment, replaced on every result. */
  liveOps: unknown[] = [];
  summary = "";
  readonly metrics: RoomMetrics = {
    opsApplied: 0,
    rejectedReasons: [],
    segmentsCommitted: 0,
    segmentsCarriedForward: 0,
    speculativeCallsMade: 0,
    speculativeResultsDiscarded: 0,
    amendWouldHaveMattered: 0,
    restructurePasses: 0,
    commitsWithoutGrowth: 0,
  };

  /** The one live segment, if speech is currently being accumulated. */
  live?: Segment;

  private carry?: Segment;
  private readonly pendingSegments: Segment[] = [];
  private commitLoop?: Promise<void>;
  private speculation?: SpeculationRequest & { promise: Promise<SpeculationResult> };
  private readonly commitMemo = new Map<number, { ops: unknown[]; restructure: boolean }>();
  /** Commits that changed the canvas since the last restructure pass. The growth check. */
  private growthSinceRestructure = 0;
  private summaryWindow: Utterance[] = [];
  private transcript: Utterance[] = [];
  private lastCommit?: LastCommit;
  private pauseTimer?: ReturnType<typeof setTimeout>;
  private nextSegmentId = 1;
  private stableEpoch = 0;
  private roomEpoch = 0;
  private busy = 0;
  private listeners = new Set<Listener>();
  private names = new Map<Listener, string>();
  private readonly llm: Llm;

  constructor(llm: Llm = realLlm) {
    this.llm = llm;
  }

  subscribe(fn: Listener, name = "Someone"): () => void {
    const before = this.people();
    this.listeners.add(fn);
    this.names.set(fn, name);
    const speculative = this.liveOps.length ? speculativeIds(this.validOverlayOps()) : undefined;
    fn({ type: "state", state: this.state, changed: [], ...(speculative?.length ? { speculative } : {}) });
    if (!samePeople(before, this.people())) this.emit({ type: "presence", people: this.people() });
    return () => {
      if (!this.listeners.has(fn)) return;
      const previous = this.people();
      this.listeners.delete(fn);
      this.names.delete(fn);
      if (!samePeople(previous, this.people())) this.emit({ type: "presence", people: this.people() });
    };
  }

  private people() {
    return [...new Set(this.names.values())].sort();
  }

  private emit(msg: ServerMsg) {
    for (const fn of this.listeners) fn(msg);
  }

  say(u: Utterance) {
    const utterance = copyUtterance(u);
    this.transcript.push(utterance);
    this.considerAmend(utterance);
    this.emit({ type: "utterance", utterance });

    if (!this.live) {
      if (this.carry && this.carry.speaker === utterance.speaker) {
        const carried = this.carry;
        this.carry = undefined;
        this.live = this.makeSegment(utterance, carried);
      } else {
        if (this.carry) {
          const carried = this.carry;
          this.carry = undefined;
          this.enqueueSegment(carried);
        }
        this.live = this.makeSegment(utterance);
      }
    } else if (this.live.speaker !== utterance.speaker) {
      // ponytail: one live segment per room is intentional; per-speaker heads are the
      // upgrade if overlapping remote speech becomes common.
      this.closeLive(true);
      this.live = this.makeSegment(utterance);
    } else {
      this.appendToLive(utterance);
    }

    this.resetPauseTimer();
    if (this.live && this.live.text.length > SEGMENT_MAX_CHARS) this.closeLive(true);
    else this.startSpeculation();
  }

  /** Timers are owned by say(); start remains for the server lifecycle contract. */
  start() {
    // Segmentation is event-driven. There is no polling loop to start.
  }

  stop() {
    this.clearPauseTimer();
  }

  reset() {
    this.clearPauseTimer();
    this.roomEpoch++;
    this.live = undefined;
    this.carry = undefined;
    this.pendingSegments.length = 0;
    this.liveOps = [];
    this.stable = emptyCanvas();
    this.state = this.stable;
    this.entries = [];
    this.summary = "";
    this.summaryWindow = [];
    this.transcript = [];
    this.lastCommit = undefined;
    this.commitMemo.clear();
    this.nextSegmentId = 1;
    this.stableEpoch = 0;
    this.metrics.opsApplied = 0;
    this.metrics.rejectedReasons = [];
    this.metrics.segmentsCommitted = 0;
    this.metrics.segmentsCarriedForward = 0;
    this.metrics.speculativeCallsMade = 0;
    this.metrics.speculativeResultsDiscarded = 0;
    this.metrics.amendWouldHaveMattered = 0;
    this.metrics.restructurePasses = 0;
    this.metrics.commitsWithoutGrowth = 0;
    this.growthSinceRestructure = 0;
    this.emit({ type: "state", state: this.state, changed: [] });
  }

  /**
   * Closes the live segment now and waits for queued commit work. The method remains
   * awaitable for replay and the eval harness; speculation is deliberately independent
   * and may finish later, where a result for a closed segment is discarded.
   */
  async maybeTick() {
    this.closeLive(true);
    if (this.carry) {
      const carried = this.carry;
      this.carry = undefined;
      this.enqueueSegment(carried);
    }
    await this.drainCommits();
  }

  private makeSegment(first: Utterance, carried?: Segment): Segment {
    const utterances = carried
      ? [...carried.utterances.map(copyUtterance), copyUtterance(first)]
      : [copyUtterance(first)];
    return {
      id: this.nextSegmentId++,
      speaker: first.speaker,
      text: utteranceText(utterances),
      utterances,
      openedAt: carried?.openedAt ?? first.t_ms,
      version: 1,
    };
  }

  private appendToLive(utterance: Utterance) {
    if (!this.live) return;
    this.live.utterances.push(copyUtterance(utterance));
    this.live.text = utteranceText(this.live.utterances);
    this.live.version++;
  }

  private resetPauseTimer() {
    this.clearPauseTimer();
    if (!this.live) return;
    const segmentId = this.live.id;
    this.pauseTimer = setTimeout(() => {
      if (this.live?.id !== segmentId) return;
      this.closeLive(false);
    }, SEGMENT_PAUSE_MS);
  }

  private clearPauseTimer() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
  }

  private closeLive(forceCommit: boolean) {
    this.clearPauseTimer();
    const segment = this.live;
    if (!segment) return;
    this.live = undefined;
    segment.closedAt = segment.utterances.at(-1)?.t_ms ?? segment.openedAt;
    const hadOverlay = this.liveOps.length > 0;
    this.liveOps = [];
    if (hadOverlay) this.publishShown();

    if (!forceCommit && segment.text.length < SEGMENT_MIN_CHARS) {
      this.carry = segment;
      this.metrics.segmentsCarriedForward++;
      return;
    }
    this.enqueueSegment(segment);
  }

  private enqueueSegment(segment: Segment) {
    this.pendingSegments.push(segment);
    void this.drainCommits();
  }

  private drainCommits(): Promise<void> {
    if (this.commitLoop) return this.commitLoop;
    const epoch = this.roomEpoch;
    const work = (async () => {
      while (epoch === this.roomEpoch && this.pendingSegments.length) {
        const segment = this.pendingSegments.shift();
        if (!segment) break;
        const committed = await this.commitSegment(segment, epoch);
        if (!committed) {
          this.pendingSegments.unshift(segment);
          break;
        }
      }
    })();
    this.commitLoop = work;
    void work.then(() => {
      if (this.commitLoop !== work) return;
      this.commitLoop = undefined;
      if (epoch === this.roomEpoch) this.startSpeculation();
    }, () => {
      if (this.commitLoop === work) this.commitLoop = undefined;
    });
    return work;
  }

  private async commitSegment(segment: Segment, epoch: number): Promise<boolean> {
    if (epoch !== this.roomEpoch) return true;
    let memo = this.commitMemo.get(segment.id);
    try {
      if (!memo) {
        const base = copyState(this.stable);
        const previous = this.entries.slice(-2).flatMap((entry) => entry.segment.utterances);
        const window = [...previous, ...segment.utterances].map(copyUtterance);
        // The growth check: only commits that changed the canvas earn the next rethink.
        const restructure = this.growthSinceRestructure >= RESTRUCTURE_EVERY;
        this.beginWork();
        let ops: unknown[];
        try {
          ops = restructure
            ? await this.llm.restructure(base, this.summary)
            : await this.llm.tick(base, window, this.summary);
        } finally {
          this.endWork();
        }
        memo = { ops, restructure };
        this.commitMemo.set(segment.id, { ops: ops.slice(), restructure });
      }

      if (epoch !== this.roomEpoch) return true;
      this.applyCommitted(segment, memo.ops, memo.restructure);
      this.metrics.segmentsCommitted++;
      this.summaryWindow.push(...segment.utterances.map(copyUtterance));
      this.recordLastCommit(segment);

      if (this.metrics.segmentsCommitted % SUMMARY_EVERY === 0 && this.summaryWindow.length) {
        await this.refreshSummary(epoch);
      }
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  private applyCommitted(segment: Segment, ops: unknown[], restructure = false) {
    const before = copyState(this.stable);
    const result = applyOps(this.stable, ops);
    this.stable = result.state;
    this.stableEpoch++;
    this.entries.push({
      segment: { ...segment, utterances: segment.utterances.map(copyUtterance) },
      ops: ops.slice(),
      snapshot: copyState(this.stable),
      before,
      ...(restructure ? { restructure: true } : {}),
    });

    const grew = canvasGrew(before, this.stable);
    if (restructure) {
      this.metrics.restructurePasses++;
      this.growthSinceRestructure = 0;
    } else if (grew) {
      this.growthSinceRestructure++;
    }
    if (!grew) this.metrics.commitsWithoutGrowth++;

    this.metrics.opsApplied += result.applied.length;
    this.metrics.rejectedReasons.push(...result.rejected);
    if (result.rejected.length) console.warn("rejected ops:", result.rejected);

    // A stable-head change invalidates any overlay based on the old head. A live
    // segment, if there is one, will be speculated again after the commit queue drains.
    this.liveOps = [];
    this.publishShown(changedIds(result.applied));
  }

  private async refreshSummary(epoch: number) {
    const window = this.summaryWindow.map(copyUtterance);
    this.beginWork();
    try {
      const next = await this.llm.summarize(this.summary, window);
      if (epoch === this.roomEpoch) {
        this.summary = next;
        this.summaryWindow = [];
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      this.endWork();
    }
  }

  private startSpeculation() {
    const segment = this.live;
    if (!segment || this.pendingSegments.length || this.commitLoop || this.speculation) return;

    const request: SpeculationRequest = {
      epoch: this.roomEpoch,
      stableEpoch: this.stableEpoch,
      segmentId: segment.id,
      version: segment.version,
      text: segment.text,
    };
    this.metrics.speculativeCallsMade++;
    const promise = this.runSpeculation(request);
    this.speculation = { ...request, promise };
    void promise.then((result) => {
      if (this.speculation?.promise !== promise) return;
      this.speculation = undefined;
      if (result.retry) this.startSpeculation();
    }, () => {
      if (this.speculation?.promise === promise) this.speculation = undefined;
    });
  }

  private async runSpeculation(request: SpeculationRequest): Promise<SpeculationResult> {
    try {
      const ops = await this.llm.speculate(copyState(this.stable), request.text);
      const current = this.isCurrent(request);
      if (!current) {
        this.metrics.speculativeResultsDiscarded++;
        return { retry: request.epoch === this.roomEpoch && !!this.live };
      }

      // Replace the overlay wholesale. Never derive a delta from its previous value.
      this.liveOps = Array.isArray(ops) ? ops.slice() : [];
      this.publishShown();
      const grew = !!this.live && (this.live.id !== request.segmentId || this.live.version !== request.version);
      return { retry: grew };
    } catch (error) {
      this.reportError(error);
      return { retry: this.isCurrent(request) && !!this.live && this.live.version > request.version };
    }
  }

  private isCurrent(request: SpeculationRequest) {
    return request.epoch === this.roomEpoch
      && request.stableEpoch === this.stableEpoch
      && this.live?.id === request.segmentId;
  }

  private validOverlayOps(): Op[] {
    return applyOps(this.stable, this.liveOps).applied;
  }

  /** `committed` carries the ids a commit just moved; the overlay contributes the rest. */
  private publishShown(committed: string[] = []) {
    const result = applyOps(this.stable, this.liveOps);
    const shown = result.state;
    // Overlay recomputation is not a journal commit. Keep the client-facing revision
    // monotonic even when a provisional overlay is cleared before its commit returns.
    this.state = shown.rev >= this.state.rev ? shown : { ...shown, rev: this.state.rev };
    const speculative = this.liveOps.length ? speculativeIds(result.applied) : [];
    const message: Extract<ServerMsg, { type: "state" }> = {
      type: "state",
      state: this.state,
      changed: [...new Set([...committed, ...changedIds(result.applied)])],
      ...(speculative.length ? { speculative } : {}),
    };
    this.emit(message);
  }

  private beginWork() {
    if (this.busy++ === 0) this.emit({ type: "status", busy: true });
  }

  private endWork() {
    this.busy = Math.max(0, this.busy - 1);
    if (this.busy === 0) this.emit({ type: "status", busy: false });
  }

  private reportError(error: unknown) {
    this.emit({ type: "status", busy: this.busy > 0, note: String(error) });
  }

  private recordLastCommit(segment: Segment) {
    const closedAt = segment.closedAt ?? segment.utterances.at(-1)?.t_ms ?? segment.openedAt;
    this.lastCommit = { speaker: segment.speaker, closedAt, counted: false };
    for (const utterance of this.transcript) {
      this.considerAmend(utterance);
      if (this.lastCommit.counted) break;
    }
  }

  // ponytail: amend goes here. When this fires, the upgrade is to reopen the last
  // committed entry — drop stable[head] back one snapshot and make its segment live
  // again with the new text. Deliberately not built; this counter is what decides it.
  private considerAmend(utterance: Utterance) {
    const last = this.lastCommit;
    if (!last || last.counted || utterance.speaker !== last.speaker) return;
    const delta = utterance.t_ms - last.closedAt;
    if (delta > 0 && delta <= 2000) {
      last.counted = true;
      this.metrics.amendWouldHaveMattered++;
    }
  }

  /** The browser is the authority on whether mermaid actually renders. One retry, then drop. */
  async renderFailed(id: string, error: string) {
    const block = this.state.blocks.find((b) => b.id === id);
    if (!block) return;
    if (!this.stable.blocks.some((b) => b.id === id)) {
      // The block exists only in the overlay. Repairing it would write a speculative
      // block into the journal, so drop it instead; the next speculation supersedes it.
      this.liveOps = this.liveOps.filter((op) => !targets(op, id));
      this.publishShown();
      return;
    }
    try {
      const ops = await this.llm.repair(id, block.source, error);
      if (ops.length) this.commit(ops);
      else this.commit([{ op: "delete", id }]);
    } catch {
      this.commit([{ op: "delete", id }]);
    }
  }

  /** Applies a repair or other out-of-band correction to the stable head. */
  commit(ops: unknown[]) {
    const result = applyOps(this.stable, ops);
    this.stable = result.state;
    this.stableEpoch++;
    this.liveOps = [];
    this.metrics.opsApplied += result.applied.length;
    this.metrics.rejectedReasons.push(...result.rejected);
    if (result.rejected.length) console.warn("rejected ops:", result.rejected);
    this.publishShown();
  }
}

function samePeople(a: string[], b: string[]) {
  return a.length === b.length && a.every((person, i) => person === b[i]);
}
