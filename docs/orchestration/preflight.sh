#!/usr/bin/env bash
# Run once, by a human, before the orchestrator starts. Proves both worker kinds can
# authenticate and act headlessly inside Docker. Seconds when healthy.
#
#   export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)   # interactive, once; needs a Pro/Max login
#   export ROOMY_LLM=cli                                     # or api (+ROOMY_ANTHROPIC_API_KEY) or bedrock
#   bash docs/orchestration/preflight.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

RUN_DIR="${ROOMY_RUN_DIR:-$HOME/.roomy-run}"
mkdir -p "$RUN_DIR/codex-home"

echo "== build images"
docker build -q -f docs/orchestration/Dockerfile.codex  -t roomy-worker-codex  . >/dev/null
docker build -q -f docs/orchestration/Dockerfile.claude -t roomy-worker-claude . >/dev/null

echo "== codex: auth is ~/.codex/auth.json (ChatGPT login), copied per run so token refresh can write"
cp "$HOME/.codex/auth.json" "$RUN_DIR/codex-home/auth.json"
docker run --rm -v "$RUN_DIR/codex-home:/home/node/.codex" -w /tmp roomy-worker-codex \
  codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --ephemeral \
  -m gpt-5.6-luna -c model_reasoning_effort=max "Reply with exactly: ok"

echo "== claude: auth is CLAUDE_CODE_OAUTH_TOKEN; ANTHROPIC_API_KEY must NOT be forwarded"
: "${CLAUDE_CODE_OAUTH_TOKEN:?mint one with: claude setup-token}"
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN -w /tmp roomy-worker-claude \
  claude -p "say ok" --model claude-opus-5 --dangerously-skip-permissions

echo "== app under test: ROOMY_LLM=${ROOMY_LLM:=cli}"
export ROOMY_LLM
case "$ROOMY_LLM" in
  cli) echo "   uses the claude CLI with CLAUDE_CODE_OAUTH_TOKEN (proved above); nothing more to check" ;;
  api)
    : "${ROOMY_ANTHROPIC_API_KEY:?set ROOMY_ANTHROPIC_API_KEY for ROOMY_LLM=api}"
    code=$(curl -s -o /tmp/roomy-preflight.json -w "%{http_code}" https://api.anthropic.com/v1/messages \
      -H "x-api-key: $ROOMY_ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
      -d '{"model":"claude-haiku-4-5","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}')
    [ "$code" = "200" ] || { echo "API key check failed (HTTP $code): $(cat /tmp/roomy-preflight.json)"; exit 1; } ;;
  bedrock) echo "   bedrock: workers need AWS credentials forwarded; not covered by this script" ;;
  *) echo "unknown ROOMY_LLM=$ROOMY_LLM"; exit 1 ;;
esac
docker run --rm -v "$PWD:/work:ro" -w /work roomy-worker-claude \
  sh -c 'npm ci --silent --prefix /tmp/app --cache /tmp/npm >/dev/null 2>&1; echo "toolchain ok"'

echo "PREFLIGHT OK"
