#!/usr/bin/env bash
# Run once, by a human, before the orchestrator starts. Proves both worker kinds can
# authenticate and act headlessly inside Docker. Seconds when healthy.
#
#   export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)   # interactive, once
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

echo "== app under test: workers need ROOMY_ANTHROPIC_API_KEY for the eval harness"
: "${ROOMY_ANTHROPIC_API_KEY:=${ANTHROPIC_API_KEY:?set ROOMY_ANTHROPIC_API_KEY}}"
docker run --rm -v "$PWD:/work:ro" -e ROOMY_ANTHROPIC_API_KEY -w /work roomy-worker-claude \
  sh -c 'npm ci --silent --prefix /tmp/app --cache /tmp/npm >/dev/null 2>&1; echo "toolchain ok"'

echo "PREFLIGHT OK"
