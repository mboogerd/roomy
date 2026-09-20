import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
const mermaidCdn = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

function externalClientReferences() {
  const imports = [...html.matchAll(/\bimport\s+[^;]*?from\s+["'](https?:\/\/[^"']+)["']/g)]
    .map((match) => match[1]);
  const sources = [...html.matchAll(/\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/g)]
    .map((match) => match[1]);
  return [...imports, ...sources];
}

describe("the client page structure", () => {
  it("keeps mermaid as its only external import or script source", () => {
    expect(externalClientReferences()).toEqual([mermaidCdn]);
  });

  it("keeps the T2 identity bootstrap and the responsive board contract", () => {
    expect(html).not.toContain("alert(");
    expect(html).toMatch(/@media\s*\(\s*max-width\s*:\s*900px\s*\)/);
    expect(html).toContain("localStorage.getItem");
    expect(html).toContain("localStorage.setItem");
    expect(html).toContain("grid-template-columns: repeat(auto-fit");
    expect(html).toContain(".block.markdown");
  });

  it("provides visual states for updates, speculation, presence, and recording", () => {
    expect(html).toContain("@keyframes block-change");
    expect(html).toContain("animationend");
    expect(html).toContain("msg.speculative");
    expect(html).toContain(".block.provisional");
    expect(html).toContain("person.current");
    expect(html).toContain('id="mic-note"');
    expect(html).toContain("Live transcription is unavailable in this browser");
    expect(html).toContain("button.recording");
    expect(html).toContain('aria-pressed="false"');
  });

  it("groups the transcript and lets users pause following", () => {
    expect(html).toContain('className = "turn"');
    expect(html).toContain("relativeTime");
    expect(html).toContain("followLog");
    expect(html).toContain('id="follow-state"');
    expect(html).toContain("atLogBottom");
  });
});
