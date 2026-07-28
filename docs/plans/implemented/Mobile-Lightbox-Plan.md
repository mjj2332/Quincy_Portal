# Mobile Lightbox Redesign — Plan (Round 1)

## Provenance

Drafted by Sonnet 5 (this session) per `docs/Subagent-Orchestration.md` §2 policy 1. User-triggered:
a mobile screenshot showed the review panel occupying ~85% of a phone's screen width, leaving only
a thin sliver of the actual photo visible — the primary content of a *photo review* tool effectively
invisible on a phone. **Planning only — no implementation in this round.** Terra review loop follows
this draft per policy 1, fresh context each round, until approved.

## Root cause (confirmed by direct code read, not guessed)

`Lightbox.tsx:427` hardcodes `<aside className="vpanel open">` — the `open` class is never
conditional, and no toggle state exists anywhere in the component. Meanwhile `app.css:634-642`
**already implements** a slide-in drawer for exactly this scenario:

```css
@media (max-width: 1080px) {
  .viewer { grid-template-columns: 1fr; grid-template-rows: 1fr auto; }
  .vpanel { position: fixed; right: 0; top: 0; bottom: 0; width: min(420px, 90vw);
            z-index: 6; box-shadow: var(--shadow-lg);
            transform: translateX(100%); transition: transform var(--dur-slow) var(--ease-entrance); }
  .vpanel.open { transform: none; }
}
```

Since `open` is always present, the panel is **permanently visible** at `min(420px, 90vw)` —
on a 390-430px iPhone that's ~90% of the viewport, sitting at `z-index: 6` above `.viewer__stage`,
with no scrim and no way to close it. This exactly matches the screenshot. The bug is real, but a
bare fix (wire a toggle to the *existing* right-edge drawer) would still leave a 90vw panel
covering nearly the whole phone screen whenever open — better than "always open," but not a good
mobile review experience for a tool whose whole point is looking at the photo. This plan proposes
a real phone-specific redesign, not just un-hardcoding the class.

## Scope split by viewport band (reusing the app's existing breakpoints — no new pixel values invented)

The app has exactly three responsive tiers already (`app.css`, confirmed by direct search — no
breakpoint exists below 720px anywhere in the codebase today):

| Band | Existing breakpoint | Current `.vpanel` behavior | This plan |
|---|---|---|---|
| Desktop | `> 1080px` | Static, `var(--panel, 380px)` grid column, always visible | **Unchanged** |
| Tablet | `1080px ≥ w > 720px` | Right-edge drawer, `min(420px, 90vw)`, toggle-driven | **Unchanged in geometry** — just needs the toggle wired (Part 1 fixes this for tablet too, for free) |
| Phone | `≤ 720px` | Same right-edge drawer (bug: forced open) | **New bottom-sheet redesign** (this plan's real scope) |

Tablet width (721-1080px) has enough room for a 420px-capped right-edge panel to coexist with a
meaningfully-sized image — the existing drawer geometry is fine there once toggled. Phone width
does not: a right-edge sheet at 90vw is functionally a full-screen takeover on a 390px screen
either way, so the plan below treats phone width as needing a **different shape** (bottom sheet,
not right-edge), matching how mobile photo-review apps (Lightroom Mobile, Apple Photos, Instagram)
handle the same problem — image stays primary, controls live in a sheet anchored to the bottom.

## Part 1 — Fix the toggle for every viewport (unblocks tablet immediately, prerequisite for phone)

Add real open/close state to `Lightbox.tsx`, replacing the hardcoded class:

```tsx
const [panelOpen, setPanelOpen] = useState(false); // Terra round-2 correction: was `true`, contradicting "starts closed ≤1080px" below. Desktop CSS never reads `.open` outside the `≤1080px` media query, so `false` is safe there too — the panel stays visible on desktop regardless of this value.
```

- `<aside className={`vpanel ${panelOpen ? "open" : ""}`}>` — conditional now.
- A new close/collapse control inside `.vpanel__head` (visible only ≤1080px via CSS, so desktop
  users never see a stray close button on their always-visible panel).
- A new **open** trigger visible only ≤1080px, placed in the `.viewer__stage` overlay chrome (near
  `.viewer__close`/`.viewer__meta`) — since the panel starts closed on these widths, there must be
  a way back in. Suggested: an icon button labeled "Review" or "Info" (need a UI-review pass on
  exact icon/label; this is worth a screenshot/mockup exchange with the user before final build,
  not something to lock by prose alone).
- Default `panelOpen` state ≤1080px: **closed** on lightbox open (the image is what the user just
  clicked to see) — reconsider if user feedback says otherwise once built.
- Add a scrim behind the panel when open on ≤1080px, tap-to-close, since none exists today —
  closes the gap noted in the CSS research ("`.vpanel` currently has no scrim/backdrop... unlike
  this modal pattern"). **Terra correction: do not reuse the existing `.scrim` class unchanged.**
  It's `z-index: 90` (`app.css:552`) while the responsive `.vpanel` is `z-index: 6`
  (`app.css:640`) — applying `.scrim` as-is would render the backdrop ABOVE the panel, not behind
  it. This needs its own viewer-scoped backdrop element: a sibling of `.vpanel` inside `.viewer`,
  stacked between the stage and the panel (e.g. `z-index: 5`, panel stays `z-index: 6`), visible
  only when `panelOpen` is true on ≤1080px, click-to-close, and excluded from the tab order when
  hidden (`aria-hidden` / not rendered, not just `display:none` with lingering focusability).
- **Explicit DOM/accessibility contract for the two rendered content modes (Terra correction —
  this was previously left as "implementer's call," which isn't precise enough to build from):**
  - The `panelOpen` boolean's meaning is per-band: on tablet (`721-1080px`) it's a plain
    closed/open toggle of the existing full panel content. On phone (`≤720px`) — see Part 2 —
    `false` means the **peek** bar is showing (not "fully closed"; there is no fully-closed state
    on phone, the peek bar is always present), `true` means the **expanded** sheet is showing.
  - `<aside className="vpanel open">` becomes `<aside className={`vpanel ${panelOpen ? "open" : ""}`}>`
    — **Terra round-2 correction: `aria-expanded` does NOT belong on this non-interactive `<aside>`.**
    It belongs on the trigger **button** that controls it (the Review/Info trigger on tablet, the
    peek-bar handle on phone), paired with `aria-controls` pointing at the sheet's `id` — the
    standard disclosure-widget pattern, matching how `Topbar.tsx`'s own menu trigger is the
    precedent already in this codebase for a toggle-button-plus-controlled-region.
  - Phone-peek renders **only** the compact peek-bar controls (Part 2's Approve/Flag/rating/handle)
    — the full `.vpanel__scroll` content (zoom, decision, recommendation, rating, label, markup,
    comments, composer) must not be present in the DOM (or must be `inert`/`aria-hidden` with
    `tabindex="-1"` on every descendant control) while collapsed, so a keyboard/screen-reader user
    tabbing through the peek bar never lands on a control that's visually hidden behind it.
  - **Terra round-2 correction: this same requirement applies to the TABLET closed state too, not
    only phone-peek.** My prior fix only protected phone's peek content; a tablet panel translated
    off-screen via `transform: translateX(100%)` while `panelOpen` is false is still fully present
    in the DOM with all its controls tabbable by default — a keyboard user could tab straight into
    an invisible, off-screen composer textarea. Apply the same inert/`aria-hidden`/`tabindex="-1"`
    treatment (or conditional non-rendering) to the tablet closed state as well.
  - Expanded state (phone) and open state (tablet) both render the existing full panel content
    unchanged — no new components needed inside the sheet, just conditional peek-vs-full markup
    gated on the same boolean, band-aware via CSS/media-query-driven conditional rendering
    (implementer's call on `useMediaQuery`-style JS detection vs. pure-CSS show/hide of both
    variants — either is acceptable, but whichever is chosen must satisfy the non-focusable-when-
    hidden requirement above, on both bands).
- **New requirement (Terra correction): keyboard and focus handling, not a cosmetic UI-review
  detail.** The lightbox is already `role="dialog" aria-modal="true"` (`Lightbox.tsx:424`) — this
  redesign must not regress that:
  - Opening the sheet (tapping the Review/Info trigger, or the peek bar on phone) moves focus to
    the sheet's collapse control.
  - Closing the sheet (scrim tap, collapse control, or Escape) restores focus to the trigger that
    opened it (the Review/Info button on tablet, the peek bar's handle on phone).
  - Escape has layered behavior: if the sheet is open/expanded, Escape closes **the sheet** first;
    only a second Escape (sheet already closed/peeked) closes the whole lightbox.
  - **Terra round-2 correction: the exact priority order must be specified, because the existing
    handler's own branches would otherwise silently swallow the sheet's Escape.** Current order in
    `Lightbox.tsx:161-188`: (1) markup mode intercepts Escape first (`:167`); (2) then, if focus is
    on any interactive element (`input, textarea, select, button, a, [contenteditable]`,
    `:173`), Escape is treated as "cancel inline edit" and the handler `return`s immediately
    (`:174`) — **this branch would catch Escape while focus is on the sheet's own collapse
    `<button>`, since a button matches that selector, and never let the sheet-close logic run at
    all.** Corrected required order: drawing mode → **open/expanded sheet** → the existing
    interactive-element/cancel-inline-edit branch → lightbox close. The sheet's own Escape check
    must be inserted as a new tier ahead of the interactive-element branch, not folded into it.
  - When markup mode force-collapses the phone sheet (existing Part 4 behavior), move focus to the
    peek bar's handle — focus must never be left on a control that just became hidden/inert.

This alone fixes the tablet band completely (panel now toggleable, closes on demand, has a scrim)
and is a prerequisite for Part 2 (phone needs the same state, different CSS shape).

## Part 2 — Phone-width bottom sheet (≤720px only, nested inside the existing breakpoint)

Two-state sheet, both driven by the *same* `panelOpen` boolean from Part 1 — no new state, just a
different CSS shape selected by media query:

**Collapsed (peek) state — persistent bottom bar, ~64-72px tall:**
- Approve / Flag (icon-only, larger touch targets than desktop's text buttons)
- Star rating (compact — likely a single tap-to-cycle control or the existing 5-star row shrunk;
  exact treatment needs a design pass, not locked here)
- A chevron-up "Review" handle — tapping it, or any part of the bar's own background/handle
  surface, opens the full sheet. **Terra round-3 correction: this must NOT extend to the
  Approve/Flag/rating controls themselves** — a tap on those performs only that action (matching
  their existing desktop click handlers) and must not also expand the sheet via event bubbling.
  Implementer's call on the exact mechanism (`event.stopPropagation()` on the control buttons, or
  scoping the bar's own open-on-tap handler to just the non-control background/handle region), but
  the two behaviors must stay decoupled.
- Deliberately excludes: recommendation, label swatches, markup/annotations, comments — those
  need real screen space and belong in the expanded sheet only

**Expanded state — sheet slides up from the bottom, capped at `max-height: 85vh`:**
- Full existing `.vpanel__scroll` content unchanged (zoom, compare toggle, decision,
  recommendation, rating, label, markup & annotations, comments, composer) — same JSX, no new
  components needed inside the sheet, just a new outer CSS shape
- A drag-handle visual (static bar, not draggable in this v1 — see Non-Goals) plus an explicit
  collapse control
- Scrim behind it (shared with Part 1's tablet scrim, same element, different geometry)

**CSS shape** (illustrative — implementer confirms exact values against real device testing):

```css
@media (max-width: 720px) {
  .vpanel { left: 0; right: 0; top: auto; bottom: 0; width: auto; height: auto;
            max-height: 85vh; border-radius: var(--radius-lg) var(--radius-lg) 0 0;
            transform: translateY(calc(100% - 72px)); /* peek bar height */ }
  .vpanel.open { transform: translateY(0); }
  /* peek-state-only bar content vs. expanded-state-only .vpanel__scroll content,
     toggled via the same `open` class or a data-attribute — implementer's call on
     the cleanest way to show/hide the two content modes without duplicating markup */
}
```

**Other phone-only chrome adjustments** (all inside the same `≤720px` block):
- `.viewer__shortcuts` (the `← → frames · A approve · X flag...` pill) — **hide entirely**. It's a
  keyboard-shortcut hint; irrelevant without a physical keyboard, and currently unpositioned for a
  narrow viewport (would need to compete with the new bottom sheet for the same screen real
  estate).
- `.viewer__nav` (prev/next overlay arrows) and `.viewer__close` — enlarge touch targets (current
  sizing is desktop-mouse-oriented; exact size needs the same UI-review pass as the peek bar).
- `.viewer__meta` (filename + "Edited · Frame 3 of 24") — likely needs to shrink to just the frame
  counter on phone width; the full filename can run long and currently center-overlays the image.
- `env(safe-area-inset-*)` padding on the peek bar and top overlay chrome, for iOS notch/home-
  indicator clearance — nothing in the app currently uses safe-area insets (confirmed absent from
  `app.css`); this is new for the whole app, scoped here to the lightbox only.
- `.strip` (filmstrip) — keep visible on phone (frame-to-frame browsing is core, high-frequency),
  but shrink thumbnails (`.strip__button`/`.strip__t`, currently fixed 84×56px) to roughly 48×32px
  so 5-6 remain visible without excessive horizontal scroll, and reposition it to sit **above** the
  peek bar (not overlapped by it) in both sheet states.

## Part 3 — Touch navigation: swipe between frames

Pointer/touch handling already exists for pinch-zoom (`touchStartZoom`/`touchMoveZoom`,
`Lightbox.tsx:391-402`) and pan-when-zoomed (`startPan`/`movePan`, using Pointer Events which
already fire on touch, and which already declines to engage at `zoom.scale <= 1` —
`Lightbox.tsx:372-385`). Add: when `zoom.scale === 1` (not zoomed) and not in markup mode, a
horizontal single-finger swipe past a distance threshold calls `move(-1)`/`move(1)`, matching the
existing `←`/`→` keyboard behavior. This is additive to the existing prev/next overlay buttons and
to the existing pan/pinch handlers, not a replacement — all remain available, and the new gesture
must not steal input pan/pinch already legitimately owns.

**Gesture-ownership contract (Terra correction — needed for this to compose safely with the
existing zoom/pan/markup handlers, not just "add a swipe listener"):**
- Track a single pointer's start position and current position only when it begins **on the image
  canvas itself** (the same element `startPan`/`drawDown` already scope to) — a gesture that begins
  on the peek bar, the expanded sheet, the nav buttons, or the drawbar must never be interpreted as
  a frame-swipe.
- If a second pointer joins mid-gesture (pinch start), cancel the swipe candidate immediately —
  pinch-zoom owns two-pointer input, matching `touchStartZoom`'s existing `event.touches.length !== 2` guard on the pinch side.
- Only commit to "this is a swipe" once horizontal movement exceeds both a minimum distance
  threshold **and** a vertical-dominance check (`|dx| > |dy|` by a real margin, not just `> 0`) —
  otherwise an intentional vertical scroll gesture (e.g. inside the expanded sheet's
  `.vpanel__scroll`) can misfire as a frame change.
- Call `move()` at most once per gesture (on release past threshold, or once the threshold is first
  crossed — implementer's call, but not repeatedly during a single drag).

## Part 4 — Markup/drawing mode on phone

When `markup` is true, force the sheet to collapsed (peek) state regardless of its state before
entering draw mode — drawing needs the full image visible, matching how the existing desktop
`.drawbar` already overlays the image rather than living in the side panel. The drawbar's own
touch targets (`.swatch` 19px, `.wbtn` 28px, `app.css:297-304`) are borderline for touch; bump to a
phone-specific minimum (44px is the standard iOS/Android minimum tap target) inside the `≤720px`
block, without changing desktop sizing.

## Non-goals for this round (explicitly deferred, not silently dropped)

- **Drag-to-resize the sheet.** V1 is tap-to-toggle only (peek ↔ expanded), CSS-transition driven,
  matching the complexity level of the *existing* desktop/tablet toggle pattern. A native-feeling
  drag gesture with velocity-based snap points is real additional work (touch tracking, rubber-band
  resistance, snap-point physics) — worth a follow-up plan if the tap-only version feels
  insufficient once used for real, but not blocking this round.
- **RAW ↔ Edited compare mode (`.viewer--compare`) on phone.** Side-by-side comparison of two
  images plus a control sheet does not fit a phone screen meaningfully. This plan does not attempt
  a phone-specific compare redesign (e.g. a swipe-between-RAW-and-Edited toggle) — recommend
  disabling/hiding the "Compare with RAW" trigger at `≤720px` with a short explanatory string
  ("Compare available on larger screens"), and scoping a real mobile-compare design as a separate
  future plan if wanted.
- **Exact peek-bar icon/label choices, exact touch-target pixel values, exact color/spacing of the
  new sheet corners.** These are real UI decisions better made against an actual rendered
  prototype/screenshot than locked in prose — flagged throughout this plan rather than guessed.

## Files touched (implementation phase, not this planning round)

- `portal/apps/web/src/components/Lightbox.tsx` — `panelOpen` state, toggle buttons, peek-bar JSX,
  swipe handling in the existing touch handlers, markup-mode auto-collapse.
- `portal/apps/web/src/styles/app.css` — Part 1's scrim + toggle CSS (all bands), Part 2's new
  `≤720px` bottom-sheet block, Part 3 needs no CSS, Part 4's phone-only touch-target bump.
- No backend, no schema, no migration — this is a frontend-only, presentation-layer change with
  zero API surface changes. **Routing table classification (per Terra's review): "Normal feature or
  refactor," not "Small, mechanical, strongly tested"** — it changes dialog interaction, gesture
  arbitration, and responsive layout, and verification is primarily manual (no automated coverage
  exists for the Lightbox's rendered layout today, only pure-logic zoom/navigation helpers).

## Verification approach (for the eventual build round, noted now so the plan is complete)

- `npm run typecheck`, `npm run build -w @quincy/web` (per `CLAUDE.md`).
- No existing automated test coverage for `Lightbox.tsx`'s rendered layout (only
  `lightbox-zoom.test.ts`/`lightbox-navigation.ts` cover pure logic, not DOM/CSS) — manual
  verification via the iOS Simulator or Browser-pane device-width resize will be required at build
  time; this plan does not propose new automated visual-regression tests (out of scope, existing
  project convention has none).
- Test against real content: a RAW asset, an Edited asset with an existing annotation/comment
  thread, and the markup-drawing flow — on both a phone-width (~390px) and tablet-width (~800px)
  viewport, confirming Part 1's toggle fix didn't regress the tablet drawer.
