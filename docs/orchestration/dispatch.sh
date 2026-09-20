#!/usr/bin/env bash
# Dispatch one sandboxed worker, per docs/orchestration/PLAN.md "Sandbox".
#   dispatch.sh impl <id> <base-commit> [extra prompt text]   # gpt-5.6-luna@max; creates the clone
#   dispatch.sh escalate <id> <base-commit> <diagnosis>       # gpt-5.6-sol@xhigh; fresh clone
#   dispatch.sh eval <id> <base-commit> [extra prompt text]   # claude-opus-5 on the existing clone
# Needs CLAUDE_CODE_OAUTH_TOKEN and ROOMY_LLM in the environment. Returns once the container is up.
set -euo pipefail
mode=${1:?impl|escalate|eval}; id=${2:?ticket id}; base=${3:?base commit}; extra=${4:-}
[[ $id =~ ^T[0-9]+b?$ ]] || { echo "bad ticket id: $id"; exit 1; }
REPO=$(cd "$(dirname "$0")/../.." && pwd)
RUN=${ROOMY_RUN_DIR:-$HOME/.roomy-run}
clone=$RUN/clones/$id
: "${CLAUDE_CODE_OAUTH_TOKEN:?}" "${ROOMY_LLM:?}"

fresh_clone() {
  docker rm -f "$id" >/dev/null 2>&1 || true
  rm -rf "$clone" "$RUN/codex-home-$id"
  git clone -q "$REPO" "$clone"
  git -C "$clone" checkout -q -b "ticket/$id" "$base"
  git -C "$clone" config user.email "$id@run"
  git -C "$clone" config user.name "Worker $id"
  mkdir -p "$RUN/codex-home-$id"
  cp ~/.codex/auth.json "$RUN/codex-home-$id/"
}

codex_run() { # model effort
  docker run -d --name "$id" \
    -v "$clone:/work" -v "$REPO/docs/tickets:/tickets:ro" \
    -v "$RUN/codex-home-$id:/home/node/.codex" \
    -e CLAUDE_CODE_OAUTH_TOKEN -e ROOMY_LLM -w /work \
    roomy-worker-codex codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral \
    -m "$1" -c "model_reasoning_effort=$2" -o /home/node/.codex/last-message.md \
    "Read /tickets/$id.md and execute it. Work only on the current branch. Run the ticket's Verify commands. Commit your work with a clear message. Your final message must be the completion report the ticket asks for. $extra"
}

case $mode in
  impl)     fresh_clone; codex_run gpt-5.6-luna max ;;
  escalate) fresh_clone; extra="Previous attempt was rejected. Diagnosis: $extra"; codex_run gpt-5.6-sol xhigh ;;
  eval)
    docker rm -f "eval-$id" >/dev/null 2>&1 || true
    docker run -d --name "eval-$id" \
      -v "$clone:/work" -v "$REPO/docs/tickets:/tickets:ro" \
      -e CLAUDE_CODE_OAUTH_TOKEN -e ROOMY_LLM -w /work \
      roomy-worker-claude claude -p "You are the evaluator for ticket /tickets/$id.md. The branch in /work contains an implementer's attempt; the base is $base. Judge it against the ticket and nothing else, on three axes: (1) faithfulness — every acceptance criterion met as written; (2) testing — each criterion is covered by an automated test that would fail if the work were wrong, and no test touches the network; (3) architectural cleanliness — CLAUDE.md rules and the frozen contracts in BACKLOG.md hold, no unrequested abstraction, no scope creep. Repair is the default: fix anything within the ticket's scope yourself, including missing tests, and commit your repairs on this branch. Reject only with a written repair-versus-redo estimate concluding redo is cheaper. Run the ticket's Verify commands last. Your final message is a report: verdict PASS or REJECT, what you repaired, files touched beyond the ticket's claim, and the estimate if rejecting. $extra" \
      --model claude-opus-5 --dangerously-skip-permissions ;;
  *) echo "unknown mode $mode"; exit 1 ;;
esac
