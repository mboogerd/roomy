// How a prompt reaches a Claude model. Everything above this file is transport-agnostic:
// llm.ts builds prompts and parses ops; this file only moves text and reports usage.
//
//   ROOMY_LLM=api      Anthropic API, ANTHROPIC_API_KEY (or ROOMY_ANTHROPIC_API_KEY)     default
//   ROOMY_LLM=bedrock  Amazon Bedrock, AWS credentials + ROOMY_AWS_REGION; model ids get an "anthropic." prefix
//   ROOMY_LLM=cli      the local `claude` CLI in print mode; bills whatever `claude` is logged in as
//
// The CLI transport spawns a process per call (2-5 s overhead) and wraps our prompt in
// Claude Code's own; it exists so a subscription can pay for development.
// ponytail: per-call spawn. A persistent --input-format stream-json session is the upgrade if latency matters.

import { spawn } from "node:child_process";

export interface Completion {
  text: string;
  usage: { input: number; output: number; cacheRead: number };
}

export type Transport = (model: string, system: string, user: string, maxTokens: number) => Promise<Completion>;

const api: Transport = async (model, system, user, maxTokens) => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ROOMY_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY });
  return viaSdk(client, model, system, user, maxTokens);
};

const bedrock: Transport = async (model, system, user, maxTokens) => {
  // Optional dependency: `npm i @anthropic-ai/bedrock-sdk` when you first set ROOMY_LLM=bedrock.
  const mod = await import("@anthropic-ai/bedrock-sdk" as string).catch(() => {
    throw new Error("ROOMY_LLM=bedrock needs: npm install @anthropic-ai/bedrock-sdk");
  });
  const client = new mod.AnthropicBedrockMantle({ awsRegion: process.env.ROOMY_AWS_REGION ?? "us-east-1" });
  return viaSdk(client, `anthropic.${model}`, system, user, maxTokens);
};

// API and Bedrock share the Messages surface; only the client differs.
async function viaSdk(client: any, model: string, system: string, user: string, maxTokens: number): Promise<Completion> {
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    // The system prompt is the stable prefix across every call in a room; cache it.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  return {
    text: res.content.map((b: any) => (b.type === "text" ? b.text : "")).join(""),
    usage: {
      input: res.usage.input_tokens,
      output: res.usage.output_tokens,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
    },
  };
}

const cli: Transport = (model, system, user, maxTokens) =>
  new Promise((resolve, reject) => {
    const args = [
      "-p", "--bare", "--no-session-persistence", "--output-format", "json",
      "--model", model, "--system-prompt", system, "--tools", "", "--max-turns", "1",
    ];
    // CLAUDECODE unset so the CLI does not refuse to run "inside" another Claude Code session.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn(process.env.ROOMY_CLAUDE_BIN ?? "claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error || typeof j.result !== "string") throw new Error(j.result ?? err ?? `claude exited ${code}`);
        resolve({
          text: j.result,
          usage: {
            input: j.usage?.input_tokens ?? 0,
            output: j.usage?.output_tokens ?? 0,
            cacheRead: j.usage?.cache_read_input_tokens ?? 0,
          },
        });
      } catch (e) {
        reject(new Error(`claude cli failed (exit ${code}): ${err.trim() || out.slice(0, 300) || String(e)}`));
      }
    });
    child.stdin.end(user);
    void maxTokens; // the CLI has no max_tokens knob; prompts already ask for terse output
  });

const transports: Record<string, Transport> = { api, bedrock, cli };

export function pickTransport(name = process.env.ROOMY_LLM ?? "api"): Transport {
  const t = transports[name];
  if (!t) throw new Error(`ROOMY_LLM must be one of ${Object.keys(transports).join(", ")}, got "${name}"`);
  return t;
}
