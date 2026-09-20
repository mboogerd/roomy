import { describe, expect, it, vi } from "vitest";
import { emptyCanvas } from "../src/canvas.ts";
import { buildTickPrompt } from "../src/prompt.ts";
import type { Llm } from "../src/llm.ts";
import { isSteeringUtterance, Room, SEGMENT_PAUSE_MS, type ServerMsg } from "../src/room.ts";
import type { Utterance } from "../src/transcript.ts";
import { StubLlm } from "./stub-llm.ts";

const utterance = (speaker: string, text: string, t_ms = 0): Utterance => ({ t_ms, speaker, text });

const addressed = (window: Utterance[]) =>
  window.some((u) => (u as Utterance & { instruction?: true }).instruction === true);

const sequence = {
  op: "upsert",
  id: "auth-flow",
  kind: "mermaid",
  title: "Auth flow",
  source: "sequenceDiagram\n    Gateway->>Service: exchange token",
};

/**
 * A model that obeys: an addressed commit draws what was asked, an ordinary one keeps the
 * stub default. Standing in for the real model is what lets a test show the canvas move
 * in response to steering without a network call.
 */
const obeying = (stub: StubLlm): Llm => ({
  async tick(state, window, summary) {
    const ops = await stub.tick(state, window, summary);
    return addressed(window) ? [sequence] : ops;
  },
  restructure: (state, summary) => stub.restructure(state, summary),
  summarize: (previous, window) => stub.summarize(previous, window),
  repair: (id, source, error) => stub.repair(id, source, error),
  speculate: (state, text) => stub.speculate(state, text),
});

describe("steering utterances", () => {
  it("only treats a leading Roomy as direct address", () => {
    expect(isSteeringUtterance("Roomy, draw that as a sequence diagram")).toBe(true);
    expect(isSteeringUtterance("... ROOMY: drop the timeline.")).toBe(true);
    expect(isSteeringUtterance("the roomy layout")).toBe(false);
    expect(isSteeringUtterance("room is booked")).toBe(false);
  });

  it("renders an instruction in its own commit-prompt section", () => {
    const instruction = {
      ...utterance("Ada", "Roomy, draw that as a sequence diagram"),
      instruction: true as const,
    };
    const prompt = buildTickPrompt(emptyCanvas(), [instruction], "");

    expect(prompt.user).toContain("## Participant instruction");
    expect(prompt.user).toContain("A participant asked: Roomy, draw that as a sequence diagram");
    expect(prompt.user).toContain("compatible with the operations contract");
    expect(prompt.user).toContain("## What was just said\n(nothing new)");
  });

  it("closes conversation before the instruction and consumes it on one commit", async () => {
    const stub = new StubLlm();
    const messages: ServerMsg[] = [];
    const room = new Room(stub);
    room.subscribe((message) => messages.push(message));

    room.say(utterance("Ada", "The auth flow needs a clear boundary before the gateway calls the service."));
    room.say(utterance("Ada", "Roomy, draw that as a sequence diagram", 100));
    room.say(utterance("Ada", "The next thought explains which service owns the token exchange.", 200));
    await room.maybeTick();

    const commits = stub.calls.filter((call) => call.method === "tick");
    expect(commits).toHaveLength(2);
    expect(commits[0]?.instruction).toBe("Roomy, draw that as a sequence diagram");
    expect(commits[1]?.instruction).toBeUndefined();
    expect(room.entries[0]?.segment.text).not.toContain("Roomy");

    const steering = messages.find((message) =>
      message.type === "utterance" && message.utterance.text.startsWith("Roomy"));
    expect(steering).toMatchObject({
      type: "utterance",
      utterance: { text: "Roomy, draw that as a sequence diagram", instruction: true },
    });
    room.stop();
  });

  it("moves the canvas on the next commit, with the instruction in the prompt the model sees", async () => {
    const stub = new StubLlm();
    const room = new Room(obeying(stub));

    room.say(utterance("Ada", "The gateway waits on the service before it hands back a token."));
    await room.maybeTick();
    const drawn = room.stable.blocks.map((block) => block.id);
    expect(drawn).toHaveLength(1);

    room.say(utterance("Ada", "Roomy, draw that as a sequence diagram", 100));
    await room.maybeTick();

    // The commit that carries the instruction is the one that redraws the canvas.
    expect(room.entries).toHaveLength(2);
    expect(room.entries[1]?.ops).toEqual([sequence]);
    expect(room.stable.blocks.map((block) => block.id)).toEqual([...drawn, "auth-flow"]);
    expect(room.stable.blocks.at(-1)?.source).toContain("sequenceDiagram");

    // The prompt text the model receives for that commit, built from the window it was given.
    const commit = stub.calls.filter((call) => call.method === "tick").at(-1);
    const prompt = buildTickPrompt(emptyCanvas(), commit?.window ?? [], "");
    expect(prompt.user).toContain("A participant asked: Roomy, draw that as a sequence diagram");
    expect(prompt.user.split("## Participant instruction")[0]).not.toContain("Roomy");

    // Steering is never conversation: no block on the canvas is drawn from its text.
    expect(room.stable.blocks.map((block) => block.source).join("\n")).not.toContain("Roomy");
    room.stop();
  });

  it("forces an instruction-only commit after the pause when nobody speaks", async () => {
    vi.useFakeTimers();
    try {
      const stub = new StubLlm();
      const room = new Room(stub);
      room.say(utterance("Ada", "Roomy, drop the timeline."));

      expect(stub.calls.filter((call) => call.method === "tick")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(SEGMENT_PAUSE_MS);

      const commit = stub.calls.find((call) => call.method === "tick");
      expect(commit?.instruction).toBe("Roomy, drop the timeline.");
      expect(room.metrics.segmentsCommitted).toBe(1);
      room.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
