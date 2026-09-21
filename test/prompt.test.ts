import { describe, expect, it } from "vitest";
import { emptyCanvas, validateOp } from "../src/canvas.ts";
import { readFileSync } from "node:fs";
import { buildRepairPrompt, buildRestructurePrompt, buildSpeculatePrompt, buildTickPrompt } from "../src/prompt.ts";

/**
 * The prompt is judged by reading its output, not by a test. These two checks cover the
 * parts of it that are a contract rather than a matter of taste: the diagram types it
 * advertises have to be ones `validateOp` accepts, and every pass that can draw has to
 * carry the mermaid quirks - or a block leaves the model, is applied, and then never
 * renders in the browser.
 */
const drawingPrompts = {
  commit: buildTickPrompt(emptyCanvas(), [], ""),
  speculate: buildSpeculatePrompt(emptyCanvas(), "still being spoken"),
  restructure: buildRestructurePrompt(emptyCanvas(), ""),
};

/** The sentence that tells the model which diagram types exist. */
function advertisedHeads(system: string): string[] {
  const listed = /first line must be exactly one of: ([^.]+)\./.exec(system)?.[1];
  expect(listed, "no prompt sentence listing the allowed diagram types").toBeTruthy();
  return (listed ?? "").split(/[\s,]+/).filter(Boolean);
}

describe("prompt", () => {
  it("advertises only diagram types the canvas accepts", () => {
    const heads = advertisedHeads(drawingPrompts.commit.system);
    expect(heads.length).toBeGreaterThan(5);
    for (const head of heads) {
      const result = validateOp({
        op: "upsert", id: "a-block", kind: "mermaid", title: "A block",
        source: `${head}\n  a --> b`,
      });
      expect(result.ok, `prompt offers "${head}", which validateOp rejects`).toBe(true);
    }
  });

  it("gives every drawing pass the same mermaid rules", () => {
    const heads = advertisedHeads(drawingPrompts.commit.system);
    for (const [pass, prompt] of Object.entries(drawingPrompts)) {
      expect(advertisedHeads(prompt.system), pass).toEqual(heads);
      // C2b, in a real browser: a timeline period written "14:02" is a parse error and
      // the block never renders. Any pass can write a timeline, so all of them get the rule.
      expect(prompt.system, `${pass} does not forbid colons`).toMatch(/NEVER write a colon/);
      expect(prompt.system, `${pass} does not show the colon-free clock form`).toMatch(/14h02/);
    }
  });
});

describe("prompt contracts added after the first live look", () => {
  it("forbids trading a block down on both passes that may rewrite one", () => {
    expect(drawingPrompts.commit.system).toContain("Never trade a block down");
    expect(drawingPrompts.restructure.system).toContain("Never trade a block down");
  });

  it("puts a room glossary in front of the passes that read raw speech, and nothing when empty", () => {
    const names = ["Kwame", "PgBouncer"];
    expect(buildTickPrompt(emptyCanvas(), [], "", names).user).toContain("Kwame, PgBouncer");
    expect(buildSpeculatePrompt(emptyCanvas(), "live", names).user).toContain("Kwame, PgBouncer");
    expect(drawingPrompts.commit.user).not.toContain("Names to spell exactly");
  });

  it("keeps the repair prompt in prompt.ts, and no prompt text in llm.ts", () => {
    expect(buildRepairPrompt("a", "flowchart TD", "boom").user).toContain("boom");
    expect(readFileSync(new URL("../src/llm.ts", import.meta.url), "utf8")).not.toContain("You fix");
  });
});
