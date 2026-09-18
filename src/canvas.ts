// The contract between the LLM and the canvas. Everything else depends on this file.
// Changing these types is a breaking change for the prompt, the server and the client.

export type BlockKind = "mermaid" | "markdown";

export interface Block {
  id: string;          // stable, LLM-chosen, kebab-case, e.g. "auth-tradeoffs"
  kind: BlockKind;
  title: string;       // short human label shown above the block
  source: string;      // full mermaid or markdown source, never a diff
}

export type Op =
  | { op: "upsert"; id: string; kind: BlockKind; title: string; source: string }
  | { op: "delete"; id: string }
  | { op: "reorder"; ids: string[] };

export interface CanvasState {
  blocks: Block[];     // render order
  rev: number;         // bumped on every applied batch; clients use it to detect gaps
}

export const emptyCanvas = (): CanvasState => ({ blocks: [], rev: 0 });

// Mermaid diagram headers we accept. A block whose first non-empty line does not
// start with one of these is rejected before it ever reaches a client.
const MERMAID_HEADS = [
  "flowchart", "graph", "mindmap", "sequenceDiagram", "classDiagram",
  "stateDiagram", "stateDiagram-v2", "erDiagram", "journey", "timeline",
  "gitGraph", "quadrantChart", "requirementDiagram", "C4Context",
];

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Cheap structural gate. Catches malformed ops and obviously-not-mermaid sources.
 * ponytail: real mermaid parsing needs a DOM, so the browser is the authority on
 * renderability — it reports failures back and the server re-asks (see server.ts).
 * Add jsdom + mermaid.parse here only if client-side rejects get noisy.
 */
export function validateOp(op: unknown): { ok: true; op: Op } | { ok: false; reason: string } {
  if (typeof op !== "object" || op === null) return { ok: false, reason: "not an object" };
  const o = op as Record<string, unknown>;

  if (o.op === "delete") {
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return { ok: false, reason: "bad id" };
    return { ok: true, op: { op: "delete", id: o.id } };
  }

  if (o.op === "reorder") {
    if (!Array.isArray(o.ids) || !o.ids.every((i) => typeof i === "string" && ID_RE.test(i)))
      return { ok: false, reason: "bad ids" };
    return { ok: true, op: { op: "reorder", ids: o.ids as string[] } };
  }

  if (o.op === "upsert") {
    if (typeof o.id !== "string" || !ID_RE.test(o.id)) return { ok: false, reason: "bad id" };
    // Models reliably confuse the block kind with the mermaid diagram type
    // ("kind":"timeline"). That is a naming slip, not a bad diagram - coerce it.
    if (typeof o.kind === "string" && MERMAID_HEADS.includes(o.kind)) o.kind = "mermaid";
    if (o.kind !== "mermaid" && o.kind !== "markdown") return { ok: false, reason: `bad kind: ${String(o.kind)}` };
    if (typeof o.title !== "string" || !o.title.trim()) return { ok: false, reason: "empty title" };
    if (typeof o.source !== "string" || !o.source.trim()) return { ok: false, reason: "empty source" };
    if (o.source.length > 8000) return { ok: false, reason: "source too long" };
    if (o.kind === "mermaid") {
      const head = o.source.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      if (!MERMAID_HEADS.some((h) => head.startsWith(h)))
        return { ok: false, reason: `unknown mermaid diagram type: ${head.slice(0, 40)}` };
    }
    return { ok: true, op: { op: "upsert", id: o.id, kind: o.kind, title: o.title, source: o.source } };
  }

  return { ok: false, reason: `unknown op: ${String(o.op)}` };
}

/** Applies ops in order. Returns the new state plus the ops that survived validation. */
export function applyOps(state: CanvasState, ops: unknown[]): { state: CanvasState; applied: Op[]; rejected: string[] } {
  const blocks = state.blocks.slice();
  const applied: Op[] = [];
  const rejected: string[] = [];

  for (const raw of ops) {
    const v = validateOp(raw);
    if (!v.ok) { rejected.push(v.reason); continue; }
    const op = v.op;

    if (op.op === "upsert") {
      const i = blocks.findIndex((b) => b.id === op.id);
      const block: Block = { id: op.id, kind: op.kind, title: op.title, source: op.source };
      if (i === -1) blocks.push(block); else blocks[i] = block;
    } else if (op.op === "delete") {
      const i = blocks.findIndex((b) => b.id === op.id);
      if (i === -1) { rejected.push(`delete of unknown block ${op.id}`); continue; }
      blocks.splice(i, 1);
    } else {
      // Unlisted blocks keep their relative order, appended after the listed ones.
      const listed = op.ids.map((id) => blocks.find((b) => b.id === id)).filter((b): b is Block => !!b);
      const rest = blocks.filter((b) => !op.ids.includes(b.id));
      blocks.length = 0;
      blocks.push(...listed, ...rest);
    }
    applied.push(op);
  }

  return { state: { blocks, rev: applied.length ? state.rev + 1 : state.rev }, applied, rejected };
}
