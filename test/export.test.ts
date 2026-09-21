import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Room } from "../src/room.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { StubLlm } from "./stub-llm.ts";

let server: RunningServer | undefined;

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const mermaidBundle = read("../node_modules/mermaid/dist/mermaid.min.js");
const inlineOpen = '<script data-roomy-mermaid="inline">';

async function baseUrl() {
  const address = await server?.ready.then((running) => running.address());
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer() {
  if (!server?.listening) {
    server = undefined;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
}

afterEach(closeServer);

describe("HTML export", () => {
  it("exports the canvas, transcript, participants, and an inline Mermaid runtime", async () => {
    server = startServer(0);
    await server.ready;

    const source = "flowchart TD\n  A --> B";
    const unsafeDiagram = 'flowchart TD\n  A["<script>alert(1)</script>"] --> B';
    const unsafeSource = "### Notes\n\nHello <script>alert('x')</script> & goodbye";
    const llm = new StubLlm().queueSpeculate([]).queueTick([
      { op: "upsert", id: "incident-flow", kind: "mermaid", title: "Incident flow", source },
      { op: "upsert", id: "unsafe-diagram", kind: "mermaid", title: "Unsafe diagram", source: unsafeDiagram },
      { op: "upsert", id: "unsafe-note", kind: "markdown", title: "A <script>title</script>", source: unsafeSource },
    ]);
    const room = new Room(llm);
    room.start();
    server.rooms.set("incident-review", { room, subscribers: 0 });

    const utterances = [
      { t_ms: 0, speaker: "Ada <img src=x>", text: "The gateway failed <script>" },
      { t_ms: 1000, speaker: "Lin", text: "We rolled it back." },
    ];
    for (const utterance of utterances) room.say(utterance);
    await room.maybeTick();

    const response = await fetch(`${await baseUrl()}/r/incident-review/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await response.text();

    // Every block's source and title survives, escaped.
    expect(html).toContain(source.replaceAll(">", "&gt;"));
    expect(html).toContain("Incident flow");
    expect(html).toContain("Hello &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; goodbye");
    expect(html).toContain("A &lt;script&gt;title&lt;/script&gt;");
    expect(html).toContain('A[&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;] --&gt; B');

    // Every utterance's speaker and text survives, escaped.
    expect(html).toContain("Ada &lt;img src=x&gt;");
    expect(html).toContain("The gateway failed &lt;script&gt;");
    expect(html).toContain("Lin");
    expect(html).toContain("We rolled it back.");

    // Nothing from the model or from people opens a tag: the only script elements are the
    // two the server writes, and no markup from a block or an utterance survives unescaped.
    expect(html.match(/<script/gi)).toHaveLength(2);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x>");

    // The runtime is genuinely inlined, byte for byte, with `</script` made inert.
    expect(mermaidBundle.length).toBeGreaterThan(1_000_000);
    const start = html.indexOf(inlineOpen);
    expect(start).toBeGreaterThan(-1);
    const inlined = html.slice(start + inlineOpen.length, html.indexOf("</script>", start));
    expect(inlined).toBe(mermaidBundle.replaceAll("</script", "<\\/script"));
    expect(html).toContain("mermaid.initialize");
    expect(html).toContain("mermaid.run()");
    expect(html).toContain('securityLevel: "strict"');

    // Nothing is fetched when the file is opened offline.
    const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["'][^"']*["']/gi)].map((match) => match[0]);
    expect(references.filter((reference) => /https?:\/\//i.test(reference))).toEqual([]);
  });

  it("anchors transcript times on the first turn, not on the epoch", async () => {
    server = startServer(0);
    await server.ready;

    const room = new Room(new StubLlm());
    room.start();
    server.rooms.set("wall-clock", { room, subscribers: 0 });
    // A live room stamps utterances with Date.now(); a fixture starts at zero.
    const started = Date.parse("2026-09-20T09:00:00Z");
    room.say({ t_ms: started, speaker: "Ada", text: "first" });
    room.say({ t_ms: started + 65_000, speaker: "Lin", text: "later" });

    const html = await (await fetch(`${await baseUrl()}/r/wall-clock/export`)).text();
    expect(html).toContain("<time>+0:00</time>");
    expect(html).toContain("<time>+1:05</time>");
  });

  it("exports a live session as a fixture that starts at zero", async () => {
    server = startServer(0, { llm: new StubLlm() });
    await server.ready;
    const room = new Room(new StubLlm());
    server.rooms.set("recorded", { room, subscribers: 0 });
    room.say({ t_ms: 1_000_000, speaker: "Ada", text: "first" });
    room.say({ t_ms: 1_004_000, speaker: "Lin", text: "second" });

    const fixture = await (await fetch(`${await baseUrl()}/r/recorded/export?format=fixture`)).json();
    expect(fixture.name).toBe("recorded");
    expect(fixture.utterances).toEqual([
      { t_ms: 0, speaker: "Ada", text: "first" },
      { t_ms: 4000, speaker: "Lin", text: "second" },
    ]);
    room.stop();
  });

  it("returns 404 for an unknown room and a meaningful page for an empty room", async () => {
    server = startServer(0);
    await server.ready;
    const base = await baseUrl();

    expect((await fetch(`${base}/r/unknown-room/export`)).status).toBe(404);
    expect((await fetch(`${base}/r/empty-room`)).status).toBe(200);
    const response = await fetch(`${base}/r/empty-room/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await response.text();
    expect(html).toContain("This room is empty");
    expect(html).toContain("No utterances were recorded");
    expect(html).toContain("No participants were recorded");
    expect(html).toContain(inlineOpen);
  });

  it("adds an Export control that opens the room route in a new tab", () => {
    const livePage = read("../public/index.html");
    expect(livePage).toContain('id="export"');
    expect(livePage).toContain('window.open(`${roomPath}/export`, "_blank"');
  });
});
