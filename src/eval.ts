import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realLlm, resetLlmStats } from "./llm.ts";
import { Room, type ServerMsg } from "./room.ts";
import type { Fixture } from "./transcript.ts";

interface EvalResult {
  reportPath: string;
  summaryLine: string;
}

const countBy = (values: string[]) => values.reduce<Record<string, number>>((counts, value) => {
  counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}, {});

const formatCounts = (counts: Record<string, number>) => {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}:${value}`).join(", ") : "none";
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function runEval(fixtureName: string): Promise<EvalResult> {
  if (!/^[a-z0-9-]+$/.test(fixtureName)) {
    throw new Error(`fixture must contain only lowercase letters, numbers, and hyphens: ${fixtureName}`);
  }

  let fixture: Fixture;
  try {
    fixture = JSON.parse(await readFile(new URL(`./fixtures/${fixtureName}.json`, import.meta.url), "utf8")) as Fixture;
  } catch (error) {
    throw new Error(`could not read fixture "${fixtureName}": ${errorMessage(error)}`);
  }

  resetLlmStats();
  const room = new Room();
  let transportError: string | undefined;
  const off = room.subscribe((message: ServerMsg) => {
    if (message.type === "status" && message.note) transportError = message.note;
  });
  const started = Date.now();

  try {
    // Calling maybeTick after each utterance preserves Room's normal thresholds without
    // waiting through fixture timestamps or involving the server.
    for (const utterance of fixture.utterances) {
      room.say(utterance);
      await room.maybeTick();
      if (transportError) throw new Error(`LLM transport error: ${transportError}`);
    }
    await room.maybeTick();
    if (transportError) throw new Error(`LLM transport error: ${transportError}`);
  } finally {
    off();
  }

  const wallTime = Date.now() - started;
  const blocksByKind = countBy(room.state.blocks.map((block) => block.kind));
  const rejectedByReason = countBy(room.metrics.rejectedReasons);
  const stats = realLlm.stats;
  const calls = stats?.calls ?? 0;
  const usage = stats?.usage ?? { input: 0, output: 0, cacheRead: 0 };
  const summaryLine = [
    `Summary: fixture=${fixture.name}`,
    `calls=${calls}`,
    `ops applied=${room.metrics.opsApplied}`,
    `ops rejected=${room.metrics.rejectedReasons.length} (${formatCounts(rejectedByReason)})`,
    `blocks by kind=${formatCounts(blocksByKind)}`,
    `wall time=${wallTime}ms`,
    `tokens input=${usage.input}, output=${usage.output}, cacheRead=${usage.cacheRead}`,
  ].join("; ");

  const sections = room.state.blocks.map((block) => [
    `## ${block.title}`,
    "",
    `\`\`\`${block.kind}`,
    block.source,
    "```",
    "",
  ].join("\n"));
  const report = [
    `# Eval: ${fixture.name}`,
    "",
    ...sections,
    "## Summary",
    "",
    summaryLine,
    "",
  ].join("\n");

  const reportDir = resolve("evals");
  await mkdir(reportDir, { recursive: true });
  const reportPath = resolve(reportDir, `${fixture.name}-${Date.now()}.md`);
  await writeFile(reportPath, report, "utf8");
  console.log(summaryLine);
  return { reportPath, summaryLine };
}

async function main() {
  const fixtureName = process.argv[2];
  if (!fixtureName) throw new Error("usage: npm run eval -- <fixture>");
  await runEval(fixtureName);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(`eval failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
