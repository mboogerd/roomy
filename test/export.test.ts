import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Room } from "../src/room.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { StubLlm } from "./stub-llm.ts";

let server: RunningServer | undefined;

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
    const unsafeSource = "### Notes\n\nHello <script>alert('x')</script> & goodbye";
    const llm = new StubLlm().queueSpeculate([]).queueTick([
      { op: "upsert", id: "incident-flow", kind: "mermaid", title: "Incident flow", source },
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

    expect(html).toContain(source.replaceAll(">", "&gt;"));
    expect(html).toContain("Incident flow");
    expect(html).toContain("Hello &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; goodbye");
    expect(html).toContain("Ada &lt;img src=x&gt;");
    expect(html).toContain("The gateway failed &lt;script&gt;");
    expect(html).toContain("Lin");
    expect(html).toContain("mermaid.initialize");
    expect(html).toContain("mermaid.run()");
    expect(html).toContain('data-roomy-mermaid="inline"');

    const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["'][^"']*["']/gi)].map((match) => match[0]);
    expect(references.some((reference) => /https?:\/\//i.test(reference))).toBe(false);
  });

  it("returns 404 for an unknown room and a meaningful page for an empty room", async () => {
    server = startServer(0);
    await server.ready;
    const base = await baseUrl();

    expect((await fetch(`${base}/r/unknown-room/export`)).status).toBe(404);
    expect((await fetch(`${base}/r/empty-room`)).status).toBe(200);
    const html = await (await fetch(`${base}/r/empty-room/export`)).text();
    expect(html).toContain("This room is empty");
    expect(html).toContain("No utterances were recorded");
    expect(html).toContain("No participants were recorded");
  });

  it("adds an Export control that opens the room route in a new tab", () => {
    const livePage = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
    expect(livePage).toContain('id="export"');
    expect(livePage).toContain('window.open(`${roomPath}/export`, "_blank"');
  });
});
