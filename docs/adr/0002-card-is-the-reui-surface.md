---
status: accepted
---

# `card` is the Portal's ReUI surface

ReUI blocks ship in surface variants: the same block composed on `card`, or on a flatter
panel/table-like surface. The variant is not a theme toggle — it decides which primitives the block
pulls in and how it nests them, so two blocks on different surfaces put visually different
containers side by side on one screen.

The Board (#76, shipped across #80–#83) was the Portal's first ReUI block adoption. It is
`kanban-board-3`, whose surface is `card`, and adopting it committed the Portal to `card` for every
block that follows.

## Considered options

**Commit to `card` (chosen).** Take the block's own surface and hold it for all future adoptions.

**Flatten the block to match existing Quincy screens.** Rewrite `kanban-board-3`'s composition onto
the Portal's existing panel idiom, so the Board looks like the List and the Calendar rather than
like a ReUI card grid.

**Decide per block.** Let each adoption choose the surface that suits it.

## Why

All three `kanban-board-*` blocks are `card`, so no future kanban work can conflict with this
choice — the decision was free in the one area most likely to need a second block.

Per-block choice was rejected because surface is the thing a user actually perceives when two
adopted blocks share a screen: mixed surfaces read as two applications, which is precisely the
complaint #76 exists to fix (the old Board "reads as a different application from everything
reskinned in #56").

Flattening was rejected because it discards the adoption's whole economic argument. The reason to
adopt a block is that the next one is cheap; a block rewritten onto a local idiom is not an
adoption, it is a bespoke screen with extra steps, and it would have to be re-derived every time
ReUI revises the block.

## Consequences

Quincy's `--radius-card` is `var(--radius-none)`, so Cards render **square**. A ReUI block on this
surface will never resemble the vendor's rounded preview. That is the token set winning, which is
correct — `portal/apps/web/src/styles/` is the design authority — and it is not a porting defect. An
agent comparing a screenshot against ReUI's documentation will read it as one.

`avatar`, `card` and `item` entered `components/reui/` to serve this surface (#80) and are now
shared vendored primitives; a later block on the same surface reuses them rather than installing
its own.

Choosing the surface once also fixes what `data-slot` values exist in the DOM, which the test seam
now depends on: guard F in `testing/test-seam.guard.test.ts` forbids DOM tests from selecting a
`data-slot` only a vendored file authors, precisely because a surface or version change can rename
one.
