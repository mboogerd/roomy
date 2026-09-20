import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realLlm, type Llm, type TokenUsage } from "./llm.ts";
import { Room, type ServerMsg } from "./room.ts";
import type { Fixture } from "./transcript.ts";

interface EvalResult {
  reportPath: string;
  summaryLine: string;
}

interface EvalOptions {
  llm?: Llm;      // the real one by default; scenario tests pass a stub
  outDir?: string;
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0 };

const countBy = (values: string[]) => values.reduce<Record<string, number>>((counts, value) => {
  counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}, {});

const formatCounts = (counts: Record<string, number>) => {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}:${value}`).join(", ") : "none";
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function runEval(fixtureName: string, options: EvalOptions = {}): Promise<EvalResult> {
  const llm = options.llm ?? realLlm;
  if (!/^[a-z0-9-]+$/.test(fixtureName)) {
    throw new Error(`fixture must contain only lowercase letters, numbers, and hyphens: ${fixtureName}`);
  }

  let fixture: Fixture;
  try {
    fixture = JSON.parse(await readFile(new URL(`./fixtures/${fixtureName}.json`, import.meta.url), "utf8")) as Fixture;
  } catch (error) {
    throw new Error(`could not read fixture "${fixtureName}": ${errorMessage(error)}`);
  }

  // Stats are cumulative per process, so report the delta this run is responsible for.
  const before = { ...(llm.stats?.usage ?? ZERO_USAGE) };
  const callsBefore = llm.stats?.calls ?? 0;

  const room = new Room(llm);
  let transportError: string | undefined;
  const off = room.subscribe((message: ServerMsg) => {
    if (message.type === "status" && message.note) transportError = message.note;
  });
  const started = Date.now();

  try {
    // Feed the transcript through the same single-ingest path as the server. Speaker
    // changes close segments synchronously; the final maybeTick flushes the last one
    // without sleeping through fixture timestamps.
    for (const utterance of fixture.utterances) room.say(utterance);
    await room.maybeTick();
    if (transportError) throw new Error(`LLM transport error: ${transportError}`);
  } finally {
    off();
  }

  const wallTime = Date.now() - started;
  const blocksByKind = countBy(room.state.blocks.map((block) => block.kind));
  const rejectedByReason = countBy(room.metrics.rejectedReasons);
  const usage = llm.stats?.usage ?? ZERO_USAGE;
  const summaryLine = [
    `Summary: fixture=${fixture.name}`,
    `calls=${(llm.stats?.calls ?? 0) - callsBefore}`,
    `ops applied=${room.metrics.opsApplied}`,
    `ops rejected=${room.metrics.rejectedReasons.length} (${formatCounts(rejectedByReason)})`,
    `blocks by kind=${formatCounts(blocksByKind)}`,
    `segments committed=${room.metrics.segmentsCommitted}`,
    `segments carried forward=${room.metrics.segmentsCarriedForward}`,
    `speculative calls made=${room.metrics.speculativeCallsMade}`,
    `speculative results discarded as stale=${room.metrics.speculativeResultsDiscarded}`,
    `amend would have mattered=${room.metrics.amendWouldHaveMattered}`,
    `wall time=${wallTime}ms`,
    `tokens input=${usage.input - before.input}, output=${usage.output - before.output}, cacheRead=${usage.cacheRead - before.cacheRead}`,
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

  const reportDir = resolve(options.outDir ?? "evals");
  await mkdir(reportDir, { recursive: true });
  const reportPath = resolve(reportDir, `${fixture.name}-${Date.now()}.md`);
  await writeFile(reportPath, report, "utf8");
  console.log(summaryLine);
  return { reportPath, summaryLine };
}

async function main() {
  const fixtureName = process.argv[2];
  if (!fixtureName) throw new Error("usage: npm run eval -- <fixture>");
  const { reportPath } = await runEval(fixtureName);
  console.log(`report: ${reportPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(`eval failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
