import { describe, it, expect } from "vitest";
import { applyOps, emptyCanvas, validateOp } from "../src/canvas.ts";
import { readdirSync, readFileSync } from "node:fs";

const flow = (id = "a-b") => ({ op: "upsert", id, kind: "mermaid", title: "T", source: "flowchart TD\n  A --> B" });

describe("validateOp", () => {
  it("accepts a well-formed mermaid upsert", () => {
    expect(validateOp(flow()).ok).toBe(true);
  });
  it("rejects a source that is not a known mermaid diagram", () => {
    const r = validateOp({ ...flow(), source: "A --> B" });
    expect(r.ok).toBe(false);
  });
  it("rejects ids that are not kebab-case", () => {
    expect(validateOp({ ...flow(), id: "Not Kebab" }).ok).toBe(false);
  });
  it("rejects unknown ops and non-objects", () => {
    expect(validateOp({ op: "nuke", id: "a" }).ok).toBe(false);
    expect(validateOp("hello").ok).toBe(false);
  });
});

describe("applyOps", () => {
  it("adds, then revises in place without reordering", () => {
    let s = applyOps(emptyCanvas(), [flow("one"), flow("two")]).state;
    s = applyOps(s, [{ ...flow("one"), title: "Revised" }]).state;
    expect(s.blocks.map((b) => b.id)).toEqual(["one", "two"]);
    expect(s.blocks[0].title).toBe("Revised");
  });

  it("drops bad ops but keeps the good ones in the same batch", () => {
    const r = applyOps(emptyCanvas(), [flow("ok"), { op: "upsert", id: "bad", kind: "mermaid", title: "x", source: "nope" }]);
    expect(r.state.blocks.map((b) => b.id)).toEqual(["ok"]);
    expect(r.rejected).toHaveLength(1);
  });

  it("reorders listed ids first and keeps the rest behind them", () => {
    let s = applyOps(emptyCanvas(), [flow("a"), flow("b"), flow("c")]).state;
    s = applyOps(s, [{ op: "reorder", ids: ["c", "a"] }]).state;
    expect(s.blocks.map((b) => b.id)).toEqual(["c", "a", "b"]);
  });

  it("deletes, and reports a delete of something that is not there", () => {
    let s = applyOps(emptyCanvas(), [flow("a")]).state;
    const r = applyOps(s, [{ op: "delete", id: "a" }, { op: "delete", id: "ghost" }]);
    expect(r.state.blocks).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
  });

  it("bumps rev only when something was applied", () => {
    const s = applyOps(emptyCanvas(), [flow("a")]).state;
    expect(applyOps(s, []).state.rev).toBe(s.rev);
  });
});

describe("fixtures", () => {
  it("are well-formed and chronological", () => {
    const files = readdirSync("src/fixtures").filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const fx = JSON.parse(readFileSync(`src/fixtures/${f}`, "utf8"));
      expect(fx.utterances.length).toBeGreaterThan(10);
      let last = -1;
      for (const u of fx.utterances) {
        expect(typeof u.speaker).toBe("string");
        expect(u.text.length).toBeGreaterThan(0);
        expect(u.t_ms).toBeGreaterThan(last);
        last = u.t_ms;
      }
    }
  });
});

describe("kind coercion", () => {
  it("treats a mermaid diagram type used as kind as mermaid", () => {
    const r = validateOp({ op: "upsert", id: "t", kind: "timeline", title: "T", source: "timeline\n  2024 : a" });
    expect(r.ok && r.op.op === "upsert" && r.op.kind).toBe("mermaid");
  });
});

describe("transport selection", () => {
  it("resolves the three backends and rejects anything else", async () => {
    const { pickTransport } = await import("../src/transport.ts");
    for (const n of ["api", "bedrock", "cli"]) expect(typeof pickTransport(n)).toBe("function");
    expect(() => pickTransport("gpt")).toThrow(/ROOMY_LLM/);
  });
});
