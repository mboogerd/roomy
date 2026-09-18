import Anthropic from "@anthropic-ai/sdk";
import type { CanvasState } from "./canvas.ts";
import type { Utterance } from "./transcript.ts";
import { buildTickPrompt, buildRestructurePrompt, buildSummaryPrompt } from "./prompt.ts";

// Two-tier: cheap model on every tick, capable model on the periodic rethink.
export const TICK_MODEL = "claude-haiku-4-5";
export const RESTRUCTURE_MODEL = "claude-sonnet-5";

// ROOMY_ prefix so the key never collides with the Claude CLI auth precedence inside evaluator containers.
const client = new Anthropic({ apiKey: process.env.ROOMY_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY });

/**
 * ponytail: the ops array is requested in prose and parsed leniently, not via
 * structured outputs. validateOp() is the real gate, so a malformed response
 * costs one dropped tick. Move to output_config.format if drops get frequent.
 */
function parseOps(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function complete(model: string, system: string, user: string, maxTokens = 4000): Promise<string> {
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export async function tick(state: CanvasState, window: Utterance[], summary: string): Promise<unknown[]> {
  const p = buildTickPrompt(state, window, summary);
  return parseOps(await complete(TICK_MODEL, p.system, p.user));
}

export async function restructure(state: CanvasState, summary: string): Promise<unknown[]> {
  const p = buildRestructurePrompt(state, summary);
  return parseOps(await complete(RESTRUCTURE_MODEL, p.system, p.user, 8000));
}

export async function summarize(previous: string, window: Utterance[]): Promise<string> {
  const p = buildSummaryPrompt(previous, window);
  return (await complete(TICK_MODEL, p.system, p.user, 600)).trim();
}

/** Second chance for a block the browser could not render. */
export async function repair(id: string, source: string, error: string): Promise<unknown[]> {
  const text = await complete(
    TICK_MODEL,
    `You fix broken mermaid diagrams. Output ONLY a JSON array with a single upsert operation:
[{"op":"upsert","id":"...","kind":"mermaid","title":"...","source":"..."}]
Keep the same id and the same meaning. Fix only what makes it fail to parse.
Common causes: unquoted labels containing punctuation, stray characters in node ids,
a diagram keyword that does not exist, indentation that is wrong for mindmap.`,
    `id: ${id}\n\nrenderer error:\n${error}\n\nsource:\n${source}`,
  );
  return parseOps(text);
}
