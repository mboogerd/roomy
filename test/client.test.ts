import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
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

// ponytail: the client has no build step, so — as test/rooms.test.ts already does for the
// name bootstrap — the two pieces with real behaviour are lifted out of the page and run in
// a vm against stub globals. A jsdom harness is the upgrade if the client grows.
function section(from: string, to: string) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  if (start === -1 || end === -1) throw new Error(`no ${from} section in public/index.html`);
  return html.slice(start, end);
}

function stubElement() {
  const classes = new Set<string>();
  const parts = new Map<string, any>();
  return {
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    hidden: false,
    offsetWidth: 0,
    onclick: undefined as undefined | (() => void),
    attributes: new Map<string, string>(),
    children: [] as any[],
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute(k: string, v: string) { this.attributes.set(k, v); },
    querySelector(sel: string) {
      if (!parts.has(sel)) parts.set(sel, stubElement());
      return parts.get(sel);
    },
    append(child: any) { this.children.push(child); },
    addEventListener() {},
  };
}

describe("the client's canvas draw", () => {
  const source = section("// Cache by id+source", "let presentPeople");

  function drawScope() {
    const canvas = stubElement();
    Object.defineProperty(canvas, "innerHTML", {
      set(value: string) { if (!value) canvas.children.length = 0; },
      get: () => "",
    });
    const context = createContext({
      document: { createElement: () => stubElement() },
      $: (id: string) => (id === "canvas" ? canvas : stubElement()),
      // Resolves a turn later, so a second draw can start while the first is awaiting.
      mermaid: { render: (_id: string, src: string) => new Promise((r) => setTimeout(() => r({ svg: `<svg>${src}</svg>` }), 0)) },
      post: () => {},
      setTimeout,
    });
    return { canvas, draw: runInContext(`${source}\ndraw`, context) as Function };
  }

  const diagram = (id: string) => ({ id, kind: "mermaid", title: id, source: `flowchart TD\n  ${id}` });

  it("renders one section per block", async () => {
    const scope = drawScope();
    await scope.draw({ blocks: [diagram("a"), diagram("b")] }, ["a"]);
    expect(scope.canvas.children.length).toBe(2);
    expect(scope.canvas.children[0].className).toContain("changed");
    expect(scope.canvas.children[1].className).not.toContain("changed");
  });

  it("drops a superseded draw instead of appending its leftovers", async () => {
    const scope = drawScope();
    const stale = scope.draw({ blocks: [diagram("a"), diagram("b")] }, []);
    const current = scope.draw({ blocks: [diagram("c")] }, ["c"]);
    await Promise.all([stale, current]);
    expect(scope.canvas.children.map((el: any) => el.querySelector(".block-title").textContent)).toEqual(["c"]);
  });

  it("marks speculative blocks provisional and leaves committed ones alone", async () => {
    const scope = drawScope();
    await scope.draw({ blocks: [diagram("a"), diagram("b")] }, [], ["b"]);
    expect(scope.canvas.children[0].className).not.toContain("provisional");
    expect(scope.canvas.children[1].className).toContain("provisional");
  });
});

describe("the client's mic button", () => {
  const source = section("function showMicMessage", "</script>");

  function micScope(SpeechRecognition?: unknown) {
    const nodes = { mic: stubElement(), "mic-label": stubElement(), "mic-note": stubElement() };
    nodes["mic-note"].hidden = true; // as the markup ships it
    const context = createContext({
      $: (id: string) => nodes[id as keyof typeof nodes] ?? stubElement(),
      window: SpeechRecognition ? { SpeechRecognition } : {},
    });
    runInContext(source, context);
    return nodes;
  }

  it("says so inline — no dialog — when the browser has no Web Speech API", () => {
    const nodes = micScope();
    expect(nodes["mic-note"].hidden).toBe(false);
    expect(nodes["mic-note"].textContent).toMatch(/unavailable in this browser/);

    nodes.mic.onclick!();
    expect(nodes["mic-note"].hidden).toBe(false);
    expect(nodes.mic.classList.contains("recording")).toBe(false);
  });

  it("ships the note hidden rather than as a dialog", () => {
    expect(html).toMatch(/<p id="mic-note"[^>]*\shidden>/);
  });

  it("shows a recording state while listening and clears it on stop", () => {
    let stopped = 0;
    class FakeRecognition {
      onend?: () => void;
      start() {}
      stop() { stopped++; this.onend?.(); }
    }
    const nodes = micScope(FakeRecognition);
    expect(nodes["mic-note"].hidden).toBe(true);

    nodes.mic.onclick!();
    expect(nodes.mic.classList.contains("recording")).toBe(true);
    expect(nodes.mic.attributes.get("aria-pressed")).toBe("true");
    expect(nodes["mic-label"].textContent).toMatch(/stop/i);

    nodes.mic.onclick!();
    expect(stopped).toBe(1);
    expect(nodes.mic.classList.contains("recording")).toBe(false);
    expect(nodes.mic.attributes.get("aria-pressed")).toBe("false");
    expect(nodes["mic-label"].textContent).toMatch(/start/i);
  });
});
