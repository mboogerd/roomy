// Drive the authenticated ingest endpoint from a fixture:
// npm run ingest -- <slug> <fixture> <speed>
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Fixture } from "./transcript.ts";

const [slug, fixtureName = "architecture-debate", speedText = "10"] = process.argv.slice(2);
if (!slug) throw new Error("usage: npm run ingest -- <slug> <fixture> <speed>");

const speed = Number(speedText);
if (!Number.isFinite(speed) || speed <= 0) throw new Error(`speed must be a positive number, got ${speedText}`);

const secret = process.env.ROOMY_INGEST_SECRET;
if (!secret) throw new Error("ROOMY_INGEST_SECRET is required");

const fixturePath = fileURLToPath(new URL(`fixtures/${fixtureName}.json`, import.meta.url));
const fixture: Fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const configured = new URL(process.env.ROOMY_URL ?? "http://localhost:3000");
const endpoint = new URL(configured);
endpoint.pathname = `/r/${encodeURIComponent(slug)}/ingest`;
endpoint.search = "";

const startedAt = Date.now();
for (const utterance of fixture.utterances) {
  const due = startedAt + utterance.t_ms / speed;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now())));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-roomy-secret": secret,
    },
    body: JSON.stringify(utterance),
  });
  const detail = await response.text();
  if (!response.ok) throw new Error(`ingest failed for ${fixtureName}: HTTP ${response.status} ${detail}`);
}

console.log(`ingested ${fixtureName} at ${speed}x — ${endpoint.origin}/r/${encodeURIComponent(slug)}`);
