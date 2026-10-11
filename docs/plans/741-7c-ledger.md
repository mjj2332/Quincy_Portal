# #741 7c reuse ledger (Version compare UI)

ReUI MCP searches re-run for 7c: "before after compare image slider wipe" (compare-1 marketing card, c-code-block-16 code diff, nothing for media),
"video comparison wipe media slider" (c-slider-1/2/8 plain sliders, comparison-2/6 product spec tables; weak match flagged by the MCP).
No media wipe exists in the registry.

| Element | Item |
|---|---|
| Compare / Single view button | installed `reui/button` (outline) with Lucide `Columns2`, in the viewer header |
| Transport (prev / play / next), offset reset | installed `reui/button` + `reui/tooltip` via `IconTip` (VideoPlayer export) |
| Side A / B Version selects | installed `reui/select` (the viewer's Version select pattern; the other side's Version is a disabled item) |
| Select labels (v3 / v2) | installed `reui/label` with `htmlFor`, like the offset (was a hand-written `<label>` reading A / B) |
| Layout (Side by side / Wipe), Sound side | installed `reui/toggle-group` |
| Mute, Notes toggle | installed `reui/toggle` |
| Offset (frames) | installed `reui/number-field` + `reui/label` (VideoNotePasteDialog composition) |
| Notes side switch (tab per side) | installed `reui/tabs` |
| Notes list, composer, I/O | existing `VideoNotesPanel` (one instance), `useVideoNotes` per side |
| Shared scrubber | installed `reui/slider`, domain in A frames |
| Marker lanes, pending band | Quincy `VideoTimelineMarkers` / `VideoPendingRangeBand`, frames mapped through `aOf` |
| Wipe handle | installed `reui/slider`; track hidden, thumb is the handle, themed by the slider's tokens |
| Wipe clip region, wipe pointer surface, divider line | **hand-built** `clip-path` and a `div` with pointer handlers (no widget role, no raw control). Searches above; closest candidates `compare-1`, `comparison-2/6`, `c-code-block-16`, `c-slider-*`: none is a media wipe |
| Stage per side | Quincy `VideoStage` |
| Side label, "Starts in N frames", "Ended" | installed `reui/badge` |
| Buffering | installed `reui/spinner` in a polite live region |
| Transport readout (`<output>`) | **hand-built** semantic `<output>` (a live region for the two timecodes). Searches: ReUI `search` for "timecode readout", "counter", "stat": nothing; the nearest, `reui/badge`, is a status chip, not a live-updating mono readout, and the single player's own readout is the same hand-built element |
| Offset help text ("e.g. +12: ...") | plain `<span>` in the label type style, prefixed "e.g." so it reads as an example, not as live state. Closest candidate `reui/field` description: rejected, it is tied to a Field wrapper the NumberField composition does not use |
| Sound group caption | plain `<span>` in the label type style (`aria-labelledby` on the `reui/toggle-group`); `reui/label` is for a labelled control and a toggle group has no single control to point at |
| Notes column surface | `data-surface="default"` on the column, as the single viewer's notes panel, so the tab strip and panel are one light surface (not a dark strip over a light panel) |
| Caution notices on the viewer | Quincy `Notice` inside `data-surface="default"` with `bg-card`, as VideoStage's "can't play" Notice |
| Side labels | `reui/badge` drawn through `VideoStage`'s `overlay(box)`, on the picture's corner (top-left; B top-right in wipe) |
| Rate, aspect, offset-bounds, blocked, recovery notices | Quincy `Notice` (+ Quincy `Button` text variant for Resume) |

No raw `<button>`/`<input>`/widget role added outside reui/quincy; the allowlist does not grow.
