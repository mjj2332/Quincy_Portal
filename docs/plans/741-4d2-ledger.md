# #741 PR 4d-ii reuse ledger

One line per new UI element. Searches: installed `components/reui/` and `components/quincy/` first; ReUI MCP `search` run 2026-10-09 for "video player with scrubber timeline, timecode and transport controls" (surface frame) returned only timeline examples/blocks (c-timeline-6, timeline-1, c-timeline-2, timeline-6 ...), no video player, scrubber or transport, so the stage, chip, transport and marker layer stay hand-built on reui/slider, quincy/Button, reui/toggle.

| Element | Item used | Notes |
|---|---|---|
| Review viewer shell (full-viewport dialog, inverse surface) | `reui/dialog` (`Dialog`, `DialogContent`, `DialogTitle`, `DialogDescription`, `DialogClose`) | installed; prior art `quincy/EmbeddedVideoDialog.tsx`. Not a hand-built `role="dialog"` (no allowlist entry). `showCloseButton={false}`: the header's "Video" button is the close |
| "Video" back/close button | `reui/button` (`ghost`) inside `DialogClose render=` with `pointer-coarse:min-h-11 max-[721px]:min-h-11` | installed |
| Title and meta line | `DialogTitle` / `DialogDescription` with token typography | installed |
| Version switcher | `reui/select` (`Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`) + a `<label htmlFor>` | installed; chosen over `quincy/NativeSelect` so options carry uploader and date; the trigger has the coarse tap target |
| Version details column | `reui/item` (`ItemGroup`, `Item size="xs"`, `ItemTitle`, `ItemDescription`) | installed |
| Scrubber | **`reui/slider`**, base-nova `slider` vendored through the sandbox (`docs/reui-reuse.md`), new file `components/reui/slider.tsx` | `npx shadcn@latest add slider` in `tmp/ReUI-Test-1`; skinned per `reui-skin.guard.test.ts` (hairline track, `bg-primary` range so the inverse scope paints it, no ring width, `data-[orientation=…]` variants), `thumbProps` added for `aria-valuetext`. Single thumb; 5b overlays markers, 5b/7 adds range thumbs |
| Note markers over the scrubber | none in 4d-ii | the scrubber's wrapper leaves room; 5b adds a hand-built layer (its ledger line carries the searches) |
| Previous frame / Play-Pause / Next frame buttons | `reui/button` (`outline`, `default`, `size="icon"`) + `reui/tooltip` with `reui/kbd` in the tip | installed; icons `lucide-react` `StepBack` / `Play` / `Pause` / `StepForward`; coarse tap target on each |
| Mute | `reui/toggle` (default variant, default size, `size-8` to match the icon buttons, `aria-pressed`) + `reui/tooltip` | installed |
| Full screen | `reui/button` (`ghost`, icon) + `reui/tooltip` | installed; shown only when `document.fullscreenEnabled` |
| Shortcut legend | `reui/kbd` (`Kbd`, `KbdGroup`) | installed. `Kbd` paints `bg-muted` and `inverse.css` does not remap `--muted` (see the note at `reui.css` ~288-297), so the chips were unreadable on ink; resolved without touching tokens by skinning the legend chips with the Lightbox's `SHORTCUT_KBD` classes (`bg-secondary`, hairline `border-border`, `text-foreground`). Hidden on coarse pointers and at <=721px. The tooltip `Kbd` is unchanged (its own tooltip-content variant) |
| Unplayable notice | `quincy/Notice` (`caution`) in a `data-surface="default"` light panel inside the stage | installed; no download link |
| Open review (card) | `quincy/Button` (`primary`) with the coarse tap-target classes | installed |
| Stage + `<video>` | native `<video>` (not a ratchet signature) | **hand-built.** Searches: `components/reui/`, `components/quincy/` (`EmbeddedVideo` is the whiteboard's native-controls player with a download fallback, wrong contract), ReUI MCP-less local copy (no media/player item), base-nova (none). Fails because no installed or registry item draws frames, locks controls out or exposes a frame clock |
| Picture-box overlay layer and timecode chip | hand-built `div` + `span` sized from `renderedMediaBox` | **hand-built.** Searches as above plus `reui/badge` (a pill with its own padding scale; the chip is mono text measured to the picture, no component fits). The chip is `aria-hidden`, the `<output>` readout carries the announcement |
| Timecode / frame readout | hand-built `<output>` with the mono token | text, not a widget |

No allowlist entry was added: the dialog, select, slider, toggle, tooltip and buttons are all `reui/` primitives, and the only raw media element is `<video>`. `ui-primitive-ratchet.guard.test.ts`, `reui-skin.guard.test.ts` and `design-system-guards.test.ts` pass unchanged.
Not in 4d-ii (later slices): notes panel, markers and in/out (5b), markup (6b), compare (7), export (8/9), sharing.
