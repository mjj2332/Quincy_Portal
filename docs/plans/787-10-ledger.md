# #787 slice 10: reuse ledger (staff Delivery tab)

One line per UI element. Registry searches ran through the ReUI MCP (`mcp__ReUI__search`) on 2026-10-11; nothing was installed, because every element is already vendored.

| Element | Item used |
|---|---|
| Tab trigger "Delivery" | `components/reui/tabs` `TabsTrigger` inside the existing `ProjectHeader` `TabsList` (same trigger as Collaboration) |
| Tab panel surface | `components/reui/frame` (`Frame`, `FramePanel`, `FrameHeader`, `FrameTitle`, `FrameDescription`; ADR 0014) |
| Item rows (select, thumbnail, name, actions) | `components/reui/item` (`Item`, `ItemMedia`, `ItemContent`, `ItemTitle`, `ItemDescription`, `ItemActions`, `ItemGroup`). MCP search "selectable image list rows with checkbox, thumbnail, switch and actions": `wishlist-1` (pro block, same `item` + `checkbox` + `badge`) is the closest; it is a shop layout with bulk-action toolbar, so only its primitives are used |
| Row checkbox | `components/quincy/Checkbox` (the Quincy-owned real `<input type="checkbox">`; `reui/checkbox` is a `<span role="checkbox">`, see the header of `quincy/Checkbox.tsx`), in a 44px label hit area |
| Cover control | `components/reui/toggle` (`Toggle`, `size="sm"`, 44px below 721px), `aria-pressed` |
| Premium switch, Admin page switch | `components/reui/switch` with `components/reui/label` |
| Premium / Page state chips | `components/reui/badge` (`success-light`, `warning-light`, `info-light`, `outline`) |
| Preview, Publish, Unlock, Re-lock, Select all / Clear, Retry | `components/reui/button` |
| Copy address | `components/video/CopyTextButton` (the `c-button-41` Copy to Copied swap on `reui/button`; MCP `c-input-group-40` "Share link input" also fits but needs a visibility `dropdown-menu` this page does not have, so only the copy action is reused) |
| Address text | plain text in the `Frame` (a `readonly` input would hide it from `textContent` and add a raw input outside the allowlist) |
| Preview dialog | `components/reui/dialog` composed per `video/ReviewLinkDialogFrame` + `quincy/SheetCloseButton` (the Review links dialog pattern) |
| Preview tiles | `components/LazyImage`; locked and PDF tiles use `lucide-react` icons; chips are `reui/badge` |
| Publish confirm, Unlock, Re-lock | `components/reui/alert-dialog` (`size="default"`, the `VideoDeliveryPanel` pattern, `ConfirmDeleteDialog` shape) |
| Payment reference field | `components/reui/input` with `components/reui/label` (as `VideoDeliveryPanel`) |
| Problem, receipt, archived messages | `components/quincy/Notice` (`critical` + `role="alert"`, `positive`, `caution` + `role="status"`) |
| Group headings, loading line | hand-built `<h3>` and `<p>` text in tokens; no ReUI item for plain headings (searched `list`, `item`: only row components exist) |

No new raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or widget `role` outside `components/reui/` and `components/quincy/`; `config/ui-primitive-allowlist.ts` is unchanged.

## Decisions taken for this slice

- Premium state of a photo, Floorplan PDF or Copy PDF comes from the staff assets list (`premium`, `premiumUnlocked`), exposed only for those kinds; a Floorplan preview answers false/false because the PDF holds the state (the same rule `lockedSql` applies).
- The activity row `project.delivery.published` keeps linking to the Project sheet: its `deep_link_path` is frozen (see `project-activity.ts`). `?tab=delivery` still opens the tab.
- Selection order on the page is photos, Floorplans, Copy documents, then Videos, each in the order its list came. A Video row publishes its current Version.
- The tab mounts on first open and then stays mounted (hidden), so a half-made selection survives a tab hop.

## Sol round 1 additions

- Older-version rows ("Older versions on the page now"): `reui/item` (`Item`, `ItemContent`, `ItemTitle`, `ItemDescription`, `ItemActions`) + `reui/badge`, same composition as the candidate rows. Searched: the ReUI `item` examples; no candidate differs.
- Premium switch hit area: `reui/switch` wrapped in a native `label` (the hit target, `min-h-11` below 721px), matching the existing selection-checkbox label. No new raw primitive.
- Page switch row: the existing `reui/switch` + `reui/label` row gains the same `min-h-11` touch class.
- "Discard unfinished publish": `reui/button` (ghost), same as the other actions.

## Sol round 2 additions

- Publish-off reason (`delivery-publish-reason`): a plain `span` of label-type text beside the Publish `reui/button`, in the same row. Searched: `reui/notice`-style callouts (the tab's `quincy/Notice` is a block banner, too heavy for a one-line reason beside a button) and the ReUI `field` description; none is an inline hint. No new raw primitive.
- Staff Delivery state now carries a Video Version's premium and unlock from its Video (`videos.premium`, `video_premium_unlocks`), so older served Video rows show the real state; a Video premium write also asks for the Delivery state again.

## Sol round 3 additions

- Candidates come from `GET /delivery/candidates` (Client Delivery gate alone), not from the Assets and Videos lists, so Video Review being closed hides nothing. No new UI element: the rows are unchanged.
- Video premium and Unlock go to `PUT /delivery/videos/:videoId/premium[-unlock]` (same handlers as the Video Review routes, Client Delivery admission). The tab no longer imports `video-approval-data`.
- Page switch: the `reui/switch` and its text now sit inside one native `label` (`min-h-11`), so the whole row is the hit target (the previous `label htmlFor` pair only enlarged a div). The premium switches already wrapped their text in a `label`. No new raw primitive; the `reui/label` import stays for the payment reference field.
- Archive latch: lifted only by a SUCCESSFUL Project read newer than the refusal that shows it unarchived; a failed refresh keeps it.
- Known limit: a photo uploaded in another tab reaches the candidates on the next focus or after 15 seconds (the candidates read has its own `delivery-candidates` resource, invalidated by premium writes and failures here), not by the Assets list's invalidation.

## Sol round 4 additions

- Request unlock in Preview: the installed `reui/button` (outline, sm) under each locked tile in `DeliveryPreviewDialog`. Searched: `components/` and `components/quincy` for an existing request-unlock control (none; slice 9's public-page component does not exist in this branch). It switches to a disabled "Requested" label locally and sends nothing; the tab test asserts no POST, PUT or GET follows the click.
- First Publish: every candidate ticked, first photo as cover (PRD §6.7 says "all ticked by default"; it names no default cover, so the first photo is a choice the person can change).
- Candidates freshness: no new UI. `delivery-candidates` is invalidated wherever Assets, Videos or Video Trash are (`withDependentResources`, local and received), and when the Delivery tab is shown again.

## Sol round 6 additions

- Preview inspect (photo full-size): `reui/button` (ghost) around the existing tile, opening an `<img>` in the inspect panel above the grid. Searched `components/quincy/` and `components/` for a lightbox: `Lightbox.tsx` is review-specific (annotations, ratings, keyboard scope) and takes review assets, not DTO URLs.
- Preview inspect (Video): a raw `<video controls>` (not an ratchet-listed primitive, so no allowlist entry). `quincy/VideoPlayer` was considered and fails: it needs a Version's fps, frame count and timecode metadata, which the page DTO does not carry, and is a frame-accurate review player (inverse surface). Slice 9 will swap this body for the shared public-page presentation.
- Preview inspect (Floorplan/Copy PDF): an `<a target="_blank" rel="noopener noreferrer">` styled with `buttonVariants` from `reui/button`; a new tab uses the browser's own PDF viewer.
- "Close <label>" for the inspect panel: `reui/button` (outline, sm).
- Pending Publish: no UI; `lib/delivery-pending-store.ts` (session + Project keyed, retired by `onPrincipalTerminal`).
- Cover is derived (null unless a selected, eligible photo); no UI change.
