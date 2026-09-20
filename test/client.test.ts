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
    id: "",
    // className and classList are one thing in the DOM; the page uses both on the same node.
    get className() { return [...classes].join(" "); },
    set className(value: string) {
      classes.clear();
      for (const c of value.split(/\s+/).filter(Boolean)) classes.add(c);
    },
    textContent: "",
    innerHTML: "",
    title: "",
    hidden: false,
    offsetWidth: 0,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    dataset: {} as Record<string, string | undefined>,
    onclick: undefined as undefined | (() => void),
    parentNode: undefined as any,
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
    get lastElementChild() { return this.children.at(-1); },
    querySelectorAll(sel: string) {
      const wanted = sel.split(".").filter(Boolean);
      return this.children.filter((child: any) => wanted.every((c) => child.classList.contains(c)));
    },
    append(child: any) { child.parentNode = this; this.children.push(child); },
    remove() {
      const parent = this.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index !== -1) parent.children.splice(index, 1);
      this.parentNode = undefined;
    },
    addEventListener() {},
  };
}

describe("the client's canvas draw", () => {
  const source = section("// Cache by id+source", "let presentPeople");

  function drawScope(options: { fail?: (source: string) => boolean } = {}) {
    const canvas = stubElement();
    Object.defineProperty(canvas, "innerHTML", {
      set(value: string) { if (!value) canvas.children.length = 0; },
      get: () => "",
    });
    const document = {
      body: stubElement(),
      createElement: () => stubElement(),
      getElementById(id: string) {
        return document.body.children.find((node: any) => node.id === id);
      },
    };
    const renderCalls: Array<{ id: string; source: string }> = [];
    const posts: Array<{ path: string; body: unknown }> = [];
    const context = createContext({
      document,
      $: (id: string) => (id === "canvas" ? canvas : stubElement()),
      // Settles a turn later, so a second draw can start while the first is awaiting. Like
      // real mermaid, a failure rejects rather than throwing, and leaves its "d" + id node behind.
      mermaid: {
        render: (id: string, src: string) => {
          renderCalls.push({ id, source: src });
          const temporary = stubElement();
          temporary.id = "d" + id;
          document.body.append(temporary);
          return new Promise((resolve, reject) => setTimeout(() => {
            if (options.fail?.(src)) reject(new Error("Syntax error in text"));
            else resolve({ svg: `<svg>${src}</svg>` });
          }, 0));
        },
      },
      post: (path: string, body: unknown) => { posts.push({ path, body }); },
      setTimeout,
    });
    return {
      canvas,
      document,
      renderCalls,
      posts,
      draw: runInContext(`${source}\ndraw`, context) as Function,
    };
  }

  const diagram = (id: string, source = `flowchart TD\n  ${id}`) => ({ id, kind: "mermaid", title: id, source });

  it("renders one section per block", async () => {
    const scope = drawScope();
    await scope.draw({ blocks: [diagram("a"), diagram("b")] }, ["a"]);
    expect(scope.canvas.children.length).toBe(2);
    expect(scope.canvas.children[0].className).toContain("changed");
    expect(scope.canvas.children[1].className).not.toContain("changed");
  });

  it("cleans up the temporary node and reports a failed render once", async () => {
    const scope = drawScope({ fail: () => true });
    await scope.draw({ blocks: [diagram("bad")] });
    expect(scope.document.body.children).toHaveLength(0);
    expect(scope.posts).toHaveLength(1);
    expect(scope.posts[0].path).toBe("render-error");
  });

  it("does not retry an unchanged failure, but retries changed source", async () => {
    const scope = drawScope({ fail: () => true });
    const first = { blocks: [diagram("a", "bad source one")] };
    const changed = { blocks: [diagram("a", "bad source two")] };
    await scope.draw(first);
    await scope.draw(first);
    expect(scope.renderCalls).toHaveLength(1);
    expect(scope.posts).toHaveLength(1);

    await scope.draw(changed);
    expect(scope.renderCalls).toHaveLength(2);
    expect(scope.posts).toHaveLength(2);
  });

  it("cleans up the temporary node of a failed render a newer draw superseded", async () => {
    const scope = drawScope({ fail: () => true });
    const stale = scope.draw({ blocks: [diagram("a", "bad source")] });
    await scope.draw({ blocks: [diagram("a", "bad source")] });
    await stale;
    expect(scope.renderCalls).toHaveLength(2);
    expect(scope.document.body.children).toHaveLength(0);
  });

  it("cleans up the temporary node after a successful render", async () => {
    const scope = drawScope();
    await scope.draw({ blocks: [diagram("ok")] });
    expect(scope.document.body.children).toHaveLength(0);
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

describe("the client's transcript", () => {
  const source = section("function atLogBottom", "function clearLog");

  function logScope() {
    const log = stubElement();
    const context = createContext({
      document: { createElement: () => stubElement() },
      $: (id: string) => (id === "log" ? log : stubElement()),
      renderPresence: () => {},
      requestAnimationFrame: () => {},
    });
    return { log, append: runInContext(`${source}\nappendUtterance`, context) as Function };
  }

  const said = (text: string, t_ms: number) => ({ speaker: "Ada", text, t_ms });

  it("keeps a steering utterance out of the speaker's turn and marks it", () => {
    const { log, append } = logScope();
    append(said("The gateway waits on the service.", 0));
    append(said("Then it hands back a token.", 1000));
    expect(log.children).toHaveLength(1);

    append({ ...said("Roomy, draw that as a sequence diagram", 2000), instruction: true });
    expect(log.children).toHaveLength(2);
    expect(log.children[1].className).toContain("instruction");
    expect(log.children[1].children.at(-1).textContent).toBe("Roomy, draw that as a sequence diagram");

    // The next ordinary utterance starts a fresh turn rather than joining the instruction.
    append(said("Which service owns the exchange?", 3000));
    expect(log.children).toHaveLength(3);
    expect(log.children[2].className).not.toContain("instruction");
  });

  it("has a style for a steering turn", () => {
    expect(html).toContain(".turn.instruction");
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
