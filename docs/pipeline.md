# The live pipeline

How speech becomes canvas edits without lag and without flicker. This replaces the
timer-driven tick loop in `src/room.ts`. Nothing in `src/canvas.ts`, the prompt contract or
the client changes.

**One data structure, three operations, one policy.**

## The journal

An ordered log of **segments** — one speaker's completed thought, made of one or more ASR
utterances. Each committed segment carries the **ops** it produced and the **stable
snapshot** of the canvas after applying them:

```
stable[n] = apply(stable[n-1], ops[n])
```

At most one segment is **live**: still receiving words, not yet committed. It has no
snapshot. What people see is the **overlay**:

```
shown = apply(stable[head], liveOps)
```

Sketch, not binding:

```ts
interface Segment { speaker: string; text: string; utterances: Utterance[]; openedAt: number; closedAt?: number }
interface Entry   { segment: Segment; ops: Op[]; snapshot: CanvasState }
class Journal     { entries: Entry[]; live?: Segment; liveOps: Op[] }
```

### Invariants

1. **Stable snapshots derive only from committed segments.** Speculation never touches them.
2. **`liveOps` is replaced on every recomputation, never accumulated.** There is no delta
   to compute: the overlay is always rebuilt from `stable[head]` plus the current live text.
   Ops are full-source upserts on stable ids, so wholesale replacement is safe — an
   unchanged block has an identical id and source and the client skips re-rendering it.
3. **The LLM always sees `stable[head]`, never the overlay.** Feeding speculation back to
   the model drifts. It also means every speculative call shares one prefix (system prompt
   + stable canvas), so prompt caching pays for nearly all of the input.

## Speculate — the fast loop

Recompute `liveOps` from `stable[head]` + the live segment's text. Cheap model, small
prompt, low `max_tokens`, cached prefix.

Not per word. **At most one speculative call in flight; when it returns, if the live text
has grown, fire again with the latest text.** This is as fast as the model allows without
choosing a debounce constant, and it coalesces under rapid speech. If the segment committed
while the call was out, discard the result.

## Commit — the slow loop

When a segment closes: compute `ops[n]` from `stable[n-1]` + the segment, with the previous
one or two segments as context. Apply, store the snapshot, drop the overlay. Memoize per
segment so replay and amend are cache hits.

Memoized means cached, not deterministic. The model is not deterministic; the journal
simply never asks twice.

The periodic restructure pass (Sonnet, `RESTRUCTURE_EVERY`) is a commit whose input is the
whole journal rather than one segment. It fits here unchanged.

## Segmentation — the policy

A segment closes on any of:

- a pause from its speaker longer than ~1.5 s — Web Speech's own final-result boundary is
  a usable proxy;
- an utterance arriving from a different speaker;
- a length cap (~60 s or ~400 chars), so a monologue still commits.

The second rule means one live segment per room, not per speaker. Overlapping speech in a
remote meeting is rare enough for that to be the right shortcut; per-speaker heads are the
upgrade path. Mark it `ponytail:`.

## Bad boundaries

**Early termination** is mostly handled by a carry-forward rule: a segment shorter than
~N chars does not commit; it is prepended to the next segment from the same speaker.
"Yeah", "right", "so —" never reach the model alone. One `if`, no rollback.

**Late termination** costs nothing structurally: the model sees two thoughts in one
segment and emits ops for both. Slightly worse ops, not a broken journal.

What remains is a long segment closed one breath too early. For that, **amend**: if the
same speaker resumes within ~2 s of a commit, reopen the last segment, drop
`stable[head]`, and make it live again with the new text. Exactly one step back. Build
this second, after observing how often carry-forward leaves it needed. Without it the
failure is a flicker — a block briefly reflects half a thought and is then overwritten
under the same id — not corruption.

## Cost

Speculation at roughly one call per 1–2 s of continuous speech is ~30–40 Haiku calls a
minute per room. With the stable canvas cached as prefix that is on the order of a few
dollars an hour. Acceptable for the PoC; the lever if it is not is a longer minimum gap
between speculative calls, not a smaller model.
