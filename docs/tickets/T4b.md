# T4b — Failed diagrams must not litter the page

**Status:** merged (C2b follow-up PASS)
**Model:** gpt-5.6-luna @ max · **Escalate to:** gpt-5.6-sol @ xhigh
**Wave:** 2 follow-up (C2b) · **Branches:** `ticket/T4b`

## Context

Read `CLAUDE.md`. The client is one file, `public/index.html`; mermaid comes from the CDN.
The browser is the authority on whether a diagram renders and reports failures to
`/render-error` (`draw()` calls `mermaid.render(...)`, then `post("render-error", ...)` on throw).

## Problem (observed in a real browser at 1400px, `incident-review` replayed at 12x)

1. When `mermaid.render(id, source)` throws, mermaid leaves a detached error node in
   `document.body`: a `<div id="d" + id>` containing the bomb "Syntax error in text" SVG. The
   client never removes it. After one replay there were **27** of them in `document.body`,
   and they render over the canvas and the right rail, hiding the whole UI.
2. A block whose source is unchanged and already failed is re-rendered (and re-reported to
   `/render-error`) on every subsequent `state` message. Each attempt leaks another node.

## Solution direction

- After every `mermaid.render` (success or failure) remove the temporary node mermaid created
  for that render id (`document.getElementById("d" + renderId)?.remove()`), or use mermaid's
  supported option to suppress error rendering — whichever is smaller. Nothing mermaid
  generates may survive outside `#canvas`.
- Remember, per block id, the last source that failed; do not re-render or re-report an
  identical source. A changed source is retried. Show the existing "Unable to render" state.
- No changes to any server message shape. No new dependency.

## Files expected to touch

- `public/index.html`
- `test/client.test.ts` — extend the existing `node:vm` harness for `draw()`

Nothing under `src/`.

## Acceptance criteria

- [ ] A test stubs `mermaid.render` to throw and asserts that after `draw()` no error node created by the stub remains attached, and that `/render-error` was posted once
- [ ] A test calls `draw()` twice with the same failing source and asserts a single render attempt and a single report; then a changed source triggers a new attempt
- [ ] A test asserts nodes from a successful render are also cleaned up
- [ ] Existing tests still pass; no unrelated files touched

## Verify

```bash
npm ci && npm run typecheck && npm test
```

## Report on completion

- Checks run and results
- Files touched
- Anything you could not do, and why
