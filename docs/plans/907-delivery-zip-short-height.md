# #907 — Delivery photo Download all dialog at short heights

Planned by deep-reasoner and Codex (blind, in parallel); synthesized by the session.

**Bug.** At 874×330 the dialog is 306px tall; the header, size radios and footer are pinned, so `ZipListScroll` (`delivery-zip-body`) collapses to 3px and the ready notice and the summary vanish.

**Chosen: a height-only breakpoint, CSS only (deep-reasoner's option a).** Below `(height < 520px)` — the same breakpoint as `POPUP_SHORT_QUERY` and lesson "A nested scroller taller than its host's window traps the wheel (#686)" — the dialog itself becomes the one scroller:

- `DialogContent`: `[@media(height<520px)]:overflow-y-auto` + `overscroll-contain`.
- `DialogFooter`: `[@media(height<520px)]:sticky bottom-0` with an opaque background equal to `bg-muted/50` over the popover, so the footer stays pinned while the header, radios and body scroll.
- `ZipListScroll` gains an optional `className`; the delivery dialog passes `[@media(height<520px)]:flex-none`, so its inner scroller never overflows (no nested scroller, no fade, not focusable). The guest film dialog passes nothing and is unchanged.
- At 520px and taller nothing changes, so the desktop, tablet and portrait phone layouts that already passed review stay as they are.

**Rejected.** (c) Moving the radios into the scroll body: `ZipPanel` is keyed by opening and size, so every size change would remount the radios and drop keyboard focus (Codex itself flagged this risk). (b) A min-height on the scroll area: it nests one scroller inside another, the trap #686 describes.

**Tests.** A DOM test pins the dialog's child order (header, `delivery-zip-sizes`, `delivery-zip-body`, footer), checks that the radios sit outside the body, checks that the radio element and its focus survive a size switch, checks the short-height classes, and checks that the guest body has none.
