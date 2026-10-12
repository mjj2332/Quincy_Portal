# #787 slice 9: reuse ledger

One line per UI element in the diff. Paths are under `portal/apps/web/src/`. No raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or widget `role` was added outside `components/reui/` and `components/quincy/`, so `config/ui-primitive-allowlist.ts` gains no entry (`ui-primitive-ratchet.guard.test.ts` passes).

| Element | Reuse |
|---|---|
| Page and Preview sections | `components/reui/frame` (`Frame`, `FramePanel`; ADR 0014), `components/quincy/SectionHead` |
| Tabs (Photos, Film, Floorplan, Description, Premium) | `components/reui/tabs` (`variant="line"`) |
| Photo tile open control | `components/reui/button` ghost over `components/LazyImage` (the tile composition from slice 10's former Preview dialog) |
| Hero image | Plain `<img>` (not a primitive): the page's `delivery_web` JPEG with `srcset` and `fetchpriority="high"`; `LazyImage` is lazy by design and would defeat the hero's priority |
| "Ask the studio" (`secondary` variant), Web-size, Full-res, Download, View, Download original | `buttonVariants` from `components/reui/button` on `<a>` (links, not buttons) |
| Request unlock, Reload, Dismiss, Try again, slideshow toggle, Previous and Next | `components/reui/button` (`Button`) |
| Request unlock sending state | `components/reui/spinner` |
| Premium badge | `components/reui/badge` (`warning` solid over photos: tiles and lightbox; `warning-light` in document rows and beside film placeholders) |
| PDF rows (Floorplan, Description) | `components/reui/item` (`Item`, `ItemMedia`, `ItemContent`, `ItemTitle`, `ItemDescription`, `ItemActions`, `ItemGroup`) |
| Loading screen | `components/reui/skeleton` |
| Empty page, gone, outdated, rate-limited | `components/quincy/EmptyState` |
| Unreachable (transient) | `guest/GuestScreens` `UnreachableScreen` |
| Chunk load failure | `guest/GuestLoadFailure` |
| Footer credit (name text + mailto link) | plain `<a>` in `delivery/StudioCredit.tsx` (a text link, not a control) |
| Footer rule | `components/reui/separator` |
| Lightbox shell | `components/reui/dialog` (`Dialog`, `DialogContent`, `DialogTitle`, `DialogDescription`, `DialogClose`) |
| Lightbox slides | `components/reui/carousel`, base-nova `carousel` vendored through the sandbox per `docs/reui-reuse.md` (embla-carousel-react 8.6.0); kept out of the entry and vendor chunks by `build/vendor-chunk-guard.ts` |
| Lightbox counter, locked and processing tiles | Typography on Quincy tokens (`--type-label`, `--space-*`); `ProcessingTile` and `LockedTile` are plain `<div>` placeholders with no interactive primitive |
| Staff Preview body | `delivery/DeliveryPage` itself, inside the existing `components/video/ReviewLinkDialogFrame` and `reui/dialog` frame |
| Film player | **Hand-built** native `<video controls playsInline preload="none" poster>` in `delivery/FilmList.tsx`. Searches: ReUI MCP `video player` returned only `c-button-group-38` (a controls-styling example, no player); `photo lightbox gallery slideshow` returned no lightbox or gallery component. Closest candidates: `components/quincy/VideoPlayer` fails because it needs `VideoVersionDto` timing fields (fps, frame count, timecode) the public DTO does not carry, and it pulls in staff review code that `guest-boundary.guard.test.ts` bans from `delivery/`; `c-button-group-38` fails because it styles buttons and plays nothing. A native `<video>` is the browser's own accessible player and needs no raw-primitive allowlist entry (`<video>` is not in the ratchet's signature list). |
| Photo viewer | **Hand-built composition** of `reui/dialog` + `reui/carousel` in `delivery/DeliveryLightbox.tsx`, since no ReUI lightbox or gallery exists (searches above). Staff `components/Lightbox.tsx` fails: it is the review lightbox with annotations and staff data hooks, banned from `delivery/` by the boundary guard, and is a baseline raw-primitive file. |
