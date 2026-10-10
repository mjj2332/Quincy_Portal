# #741 12b reuse ledger (guest review page)

One line per UI element in `portal/apps/web/src/guest/`. Nothing new is installed. Paths are under `portal/apps/web/src/`.

| Element | Where | Uses |
|---|---|---|
| Passcode card | `guest/GuestScreens.tsx` | `components/reui/frame.tsx` (`Frame`, `FrameHeader`, `FrameTitle`, `FrameDescription`, `FramePanel`) |
| Passcode field, label, error | `guest/GuestScreens.tsx` | `components/reui/field.tsx` (`FieldGroup`, `Field`, `FieldLabel`, `FieldError` for the 401 text and the 429 countdown) |
| Passcode input | `guest/GuestScreens.tsx` | `components/reui/input.tsx` (`type="password"`, `autoComplete="off"`) |
| Submit, Open, All videos, Previous / Next video, Notes, note timecode | `guest/GuestScreens.tsx`, `GuestVideoScreen.tsx`, `GuestNotesPanel.tsx` | `components/reui/button.tsx` |
| Unavailable message, empty list, "No notes yet" | `guest/GuestScreens.tsx`, `GuestNotesPanel.tsx` | `components/quincy/EmptyState.tsx` |
| Video list container | `guest/GuestScreens.tsx` | `components/reui/frame.tsx` (`Frame`, `FramePanel`) |
| Video list row | `guest/GuestScreens.tsx` | `components/reui/item.tsx` (`ItemGroup`, `Item`, `ItemMedia variant="image"`, `ItemContent`, `ItemTitle`, `ItemDescription`, `ItemActions`) |
| Row poster | `guest/GuestScreens.tsx` | `components/LazyImage.tsx` |
| Premium badge, Studio / Client chip, Resolved chip | `guest/GuestScreens.tsx`, `GuestNotesPanel.tsx` | `components/reui/badge.tsx` |
| Version select | `guest/GuestVideoScreen.tsx` | `components/reui/select.tsx`, the same composition as `components/video/VideoReviewViewer.tsx` |
| Player (stage, scrubber, transport, timecode chip, markers) | `guest/GuestVideoScreen.tsx` | `components/quincy/VideoPlayer.tsx` (with `VideoStage` and `VideoTimelineMarkers` inside it), on `data-surface="inverse"` |
| Notes column and drawer body | `guest/GuestNotesPanel.tsx` | `components/reui/item.tsx` (`Item variant="outline"`), `components/reui/scroll-area.tsx` |
| Phone notes drawer (below 721px) | `guest/GuestVideoScreen.tsx` | `components/reui/sheet.tsx` (`side="bottom"`) |
| Saved-drawing overlay (read-only) | `guest/GuestMarkup.tsx` | `components/quincy/freehand-strokes.tsx` (`MarkupLayer`, `StrokeVisible`) with `lib/read-stored-markup.ts`. The staff `VideoMarkupOverlay` is not reusable: it is bound to the staff form store and `lib/api`. |
| Premium watermark | `guest/PremiumWatermark.tsx` | **Hand-built.** Searches: ReUI MCP `search` "watermark overlay on media" (top hits `c-spinner-11`, `c-icon-tile-14`, `c-popover-8`, all unrelated, `weakMatch: true`, "watermark" unmatched); the installed `components/reui/` and `components/quincy/` (no overlay / watermark item); `Notice` (a banner, not a picture overlay); `VideoStage`'s timecode chip (one fixed label, not a tiled field). Closest candidate `VideoStage`'s `overlay` slot: used as the mount point, but it only hosts content. A `pointer-events-none`, `aria-hidden`, token-only text field is the whole behaviour, so there is nothing to adapt. |
| "Couldn't reach Quincy" screen (network error / 5xx), with its Try again button | `guest/GuestScreens.tsx` (`UnreachableScreen`) | `components/quincy/EmptyState.tsx` and `components/reui/button.tsx`. No new element. |
| Initial rate-limit screen (countdown, token-only Try again) | `guest/GuestScreens.tsx` (`LimitedScreen`) | `components/quincy/EmptyState.tsx` and `components/reui/button.tsx` (disabled during the countdown). No new element. |
| Notes read failed in transit, in the notes panel | `guest/GuestNotesPanel.tsx` | `components/quincy/EmptyState.tsx` (`tone="error"`, `size="compact"`) and `components/reui/button.tsx`. No new element. |
