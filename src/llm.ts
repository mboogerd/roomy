import type { CanvasState } from "./canvas.ts";
import type { Utterance } from "./transcript.ts";
import { buildTickPrompt, buildRestructurePrompt, buildSummaryPrompt, buildSpeculatePrompt } from "./prompt.ts";
import { pickTransport } from "./transport.ts";

// Two-tier: cheap model on every tick, capable model on the periodic rethink.
export const TICK_MODEL = "claude-haiku-4-5";
export const RESTRUCTURE_MODEL = "claude-sonnet-5";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface LlmStats {
  calls: number;
  usage: TokenUsage;
}

/** The model seam used by Room. Test implementations cover the fast and committed paths. */
export interface Llm {
  tick(state: CanvasState, window: Utterance[], summary: string): Promise<unknown[]>;
  restructure(state: CanvasState, summary: string): Promise<unknown[]>;
  summarize(previous: string, window: Utterance[]): Promise<string>;
  repair(id: string, source: string, error: string): Promise<unknown[]>;
  speculate(state: CanvasState, text: string): Promise<unknown[]>;
  readonly stats?: LlmStats;
}

// Which transport carries a prompt (API, Bedrock, or the claude CLI) is decided by ROOMY_LLM; see transport.ts.
const transport = pickTransport();

const stats: LlmStats = {
  calls: 0,
  usage: { input: 0, output: 0, cacheRead: 0 },
};

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
  stats.calls++;
  const response = await transport(model, system, user, maxTokens);
  stats.usage.input += response.usage.input;
  stats.usage.output += response.usage.output;
  stats.usage.cacheRead += response.usage.cacheRead;
  return response.text;
}

async function tick(state: CanvasState, window: Utterance[], summary: string): Promise<unknown[]> {
  const p = buildTickPrompt(state, window, summary);
  return parseOps(await complete(TICK_MODEL, p.system, p.user));
}

async function restructure(state: CanvasState, summary: string): Promise<unknown[]> {
  const p = buildRestructurePrompt(state, summary);
  return parseOps(await complete(RESTRUCTURE_MODEL, p.system, p.user, 8000));
}

async function speculate(state: CanvasState, text: string): Promise<unknown[]> {
  const p = buildSpeculatePrompt(state, text);
  return parseOps(await complete(TICK_MODEL, p.system, p.user, 1200));
}

async function summarize(previous: string, window: Utterance[]): Promise<string> {
  const p = buildSummaryPrompt(previous, window);
  return (await complete(TICK_MODEL, p.system, p.user, 600)).trim();
}

/** Second chance for a block the browser could not render. */
async function repair(id: string, source: string, error: string): Promise<unknown[]> {
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

/** The production implementation used when Room is constructed without an argument. */
export const realLlm: Llm = { tick, restructure, summarize, repair, speculate, stats };
