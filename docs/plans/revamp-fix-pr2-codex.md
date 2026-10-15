# PR 2 plan — guest phone composer

## 1. Scope and design

Implement the guest equivalent of PR 1’s shipped strip, using the final ledger decisions. The prototype remains authoritative for P2, P6 and P7; PR 1 supplies the settled adaptations.

**ReUI design plan**

- **Surface:** operational review flow.
- **Archetype:** record detail.
- **Container:** existing `ReviewSplit` and Quincy review sheet.
- **Density:** PR 1’s phone strip, including its compact icons and 44px hit targets.
- **Regions:** phone header → flexible film → sheet body → composer foot.
- **States:** notes loading/empty/error; editor loading/failure; verification; pending/failed writes; edit conflict.
- **Motion:** existing components only; viewport-driven root writes use `transition: none`.

Phone behavior applies below 721px. Tablet and desktop retain their current composer.

## 2. Frame → component map

| Frame/state | Rendering responsibility |
|---|---|
| **P2 — guest rest, half stop** | `GuestVideoScreen`: header, Notes tab and public open-thread count. `ReviewSplit` / `ReviewSheet`: stops and film allocation. `GuestNotesPanel`: delivery row and notes body. New `GuestNoteComposer`: pill at the foot. |
| **P6 as guest — keyboard up** | `GuestNoteComposer`: hint, + tray, pill, round Send and Cancel. `GuestNoteField` → lazy `GuestNoteEditor` → `QuincyRichTextEditorBase`: rich field, wrapping, inline addons and portalled toolbar. `useGuestCompose`: draft and submission. |
| **P7 as guest — drawing** | `useGuestCompose`: confirmed drawing frame, draft strokes, overlay and existing `MarkupToolbar` replacement. `GuestNoteComposer`: pressed pen in the pill. `ReviewSplit`: draw layout. |
| **Edit own root note** | `GuestThreadItem` → `writing.editRoot` → `beginEdit`. The same foot strip loads the existing document, marks and drawing baseline; its Send icon becomes **Save** semantically. Reply editing remains inline. |

P6 and P7 are role substitutions of `MobileReview`; neither needs a new prototype layout.

## 3. Reuse recommendation and files

**Recommend a guest twin of the strip, sharing the existing editor, sheet machinery and installed primitives.**

Importing `VideoNoteComposer` directly breaches the guest boundary through its staff editor/network dependencies. A shared presentational strip is feasible, but extracting the proven staff implementation would broaden this PR substantially.

Keep domain state in `useGuestCompose`; move its rendering into `guest/GuestNoteComposer.tsx`. That component consumes `SheetModeContext` **inside** `ReviewSplit`. The hook itself runs above that provider and must not try to read it there.

| File | Planned change |
|---|---|
| `guest/GuestNoteComposer.tsx` — new | Phone strip and existing desktop form presentation, driven by guest state/actions. |
| `guest/use-guest-compose.tsx` | Expose rendering state/actions; preserve create/edit validation, revisions, drawing and stale-operation protections. Add explicit phone entry/focus behavior. |
| `guest/GuestVideoScreen.tsx` | Mount strip, route entry through verification, relocate phone copy action/status, count open threads, wire viewport tracking. |
| `guest/GuestApp.tsx` | Supply the outer video-column element for viewport tracking; bound the phone document column including notices. |
| `guest/GuestNotesPanel.tsx` | Separate phone composer foot from scrollable body content; preserve desktop placement. |
| `guest/GuestNoteEditor.tsx` | Forward `pill`, `pillWrap`, addons, toolbar target, content classes and attributes to the shared base. Add a scoped readiness/focus handoff if needed. |
| `guest/GuestNoteField.tsx` | Phone-sized lazy fallback and recoverable loading failure. |
| `guest/GuestNoteItem.tsx` | Update post-delete focus fallback for the new composer entry. Root-edit routing already exists. |
| Named tests below | Extend coverage. |

No planned changes to staff composer files, shared ReUI variants, API payloads or server authorization.

## 4. Guest behavior

### Entry and verification

- Replace the phone foot’s outline **Add a note** button with the pill: **+ · timecode · Add a note… · pen**, beside round Send.
- Before the editor is requested, use a lightweight composition of installed components for the entry appearance. Keep the guest editor chunk lazy.
- All entry affordances enforce `canWrite` and verification. An unverified guest opens the existing email-code dialog before creating a draft, drawing or uploading.
- Preserve the requested entry intent—typing, tray or drawing—through verification, scoped to the current screen/Version. Cancellation or a stale continuation must not open a new draft elsewhere.
- Retain the existing desktop Add button and stacked form.

### Strip and tray

Carry PR 1’s final behavior over:

- One line with ellipsis at rest.
- Wrap only in compose mode; wrapped text occupies the full row above the addons.
- `--radius-pill` on one line, `--radius-lg` when wrapped.
- `--border-hover` focus hairline.
- Whole-line text clamp, up to four lines when room permits; text yields to the 96px film floor.
- + remains present at rest. An open tray holds compose mode.
- Tray controls retain field focus on pointer/mouse press; keyboard users retain normal access.

**Guest tray contents:** frame back/forward, Mark in, Mark out, Clear marks, drawing attachment/removal controls, separator, and the entire formatting toolbar. Frame steps are needed here because compose hides the player transport. No visibility toggle.

Retain guest drawing gates and edit restrictions. A note carrying a saved drawing still requires removing and saving it before changing its frames.

### Anchoring

Phone entry pauses playback and captures its frame before opening the draft. Refocusing a nonempty draft or entering edit must not restamp it.

Match staff’s empty-draft frame stepping without treating an explicit Mark in as an automatic stamp: distinguish automatic point anchoring from manually set marks, drawing anchors and edit baselines.

### Copy, status and footer rows

Proposed phone placement, subject to the capability/layout conflicts in §8:

- **Copy my notes from another version:** existing header ⋯ action sheet, under the existing `canPaste` gate. Keep its current verification semantics and dialog.
- **Paste status:** persistent `role="status"` content in the sheet body, outside the composer.
- **Identity, then email updates:** retain that order in the phone body’s scrollable content. Hide/inert them with the body in collapsed, compose and draw states.
- **Delivery row:** stays at the top of the Notes body and disappears with that body during compose/draw.

These rows must not add permanent height below the pill.

### Copy and submission

- New-note hint: **“Paused at TC · the note is stamped here”**.
- Range hint identifies the marked range. No “Internal” or visibility choice.
- Edit hint identifies **Editing note** and its saved anchor.
- Phone action is icon-only: accessible name **Send note** for create, **Save note** for edit; pending names **Posting…** / **Saving…**, with Spinner.
- Desktop retains **Post note** / **Save**.
- Submit through the existing guest validation, including media-only notes. Suppress duplicates and submission during uploads/drawing confirmation.
- Pending submission holds compose mode. Success closes the draft and returns to browse; failure preserves it.
- Cancel discards the complete draft, closes the tray, blurs the field and unmounts the active editor to abort its uploads.

### Editing and lazy loading

Root Edit opens and focuses this strip; it must work from a collapsed sheet too. Preserve revision snapshots, no-op saves, latest-version display, re-verification recovery and drawing/frame restrictions.

During a cold editor load, show the **same pill footprint**, timecode and loading status/Skeleton; disable Send and unavailable toolbar actions. Keep an explicit loading hold until readiness. Replace the current global two-second polling with a scoped, cancellable readiness handoff.

Chunk failure needs Retry and Cancel without losing the draft. Automatic keyboard presentation after asynchronous verification/loading requires the Simulator evidence in §10.

## 5. Keyboard and document mechanism

Use the staff hook contract:

```ts
useVisualViewport(
  phone && sheetControl.composing,
  onKeyboardGone,
  viewportRoot,
  phone,
);
```

Here `viewportRoot` is the **outer guest video column**, including notices above `GuestVideoScreen`.

- `GuestApp` supplies that element through a callback ref/prop.
- On phone video screens, make this column a bounded, top-anchored viewport shell. Remove the phone `min-h-dvh` floors that would prevent keyboard shrinkage; retain a `dvh` fallback when Visual Viewport is unavailable.
- `GuestVideoScreen` becomes a `flex-1 min-h-0` child. Notices consume space inside the measured box.
- The hook exclusively writes height, transform and transition. Remove React’s competing height/translate style.
- Track from phone-screen mount through browse, compose, verification and draw—not only after focus.
- Use the sheet’s mode as the single layout switch. Draft existence must not keep the tall strip visible after blur.
- Keep scrolling inside the notes body, toolbar tray and clamped editor. Prevent ordinary background document scrolling while this phone view is active; preserve/restore prior document styles and scroll on exit.
- Continue following viewport events while Safari restores its keyboard pan. Apply no second keyboard inset.
- Reuse PR 1’s ink document-canvas treatment for exposed recovery frames; fresh-load Safari bar tint remains PR 3.

When the software keyboard disappears without blur, use the existing ≥150px detection and `blurComposerField` when no hold remains. This returns to browse without clearing or remounting the draft. Tray/post holds continue until released.

Leaving the video screen or crossing to desktop must release viewport styles and document changes.

## 6. Open-note count

The phone Notes tab counts **open public root threads on the displayed Version**:

```ts
!thread.resolved &&
(!thread.deleted || thread.replies.length > 0)
```

The guest read already projects public threads only.

- Ordinary open root: **1**.
- Open tombstone retaining replies: **1**.
- Resolved root, including a resolved tombstone: **0**.
- Replies: **0 additional count**.
- Deleted root without replies: **0**; normally omitted by the server.
- Hide the numeric badge at zero; loading must not masquerade as zero.

Compute from the current thread list so successful writes/deletes/pastes update it immediately. Keep collection/latest-Version counts outside this PR. Preserve the desktop heading’s existing total-count presentation.

## 7. Reuse lines and guard impact

| New/changed element | Reuse |
|---|---|
| Pill and wrapped field | Existing `QuincyRichTextEditorBase` and `InputGroup variant="pill"`. |
| Timecode/range chip | PR 1’s semantic-token mono chip and short-range treatment; no Badge sizing substitution. |
| Rest/loading entry | Installed InputGroup/addons, Button and Skeleton; no raw interactive primitive. |
| + and pen | Installed ghost icon Button, `PILL_ICON`, existing pressed hairline treatment. |
| Inline options tray | Installed `Collapsible` / `CollapsibleContent keepMounted`; existing scroll-fade helper. |
| Mark/frame/removal controls | Existing Quincy/ReUI Buttons and guest mark commands. |
| Formatting | Existing rich-text toolbar, portalled into the tray; existing toolbar separator. |
| Send/Save and pending state | Existing `Button size="icon-round"`, lucide Send and Spinner. |
| Cancel | Existing Quincy text Button and PR 1’s compact hit-area treatment. |
| Hint/error/conflict text | Semantic text/status/alert regions; preserve complete conflict information. |
| Copy action | Existing `ReviewActionSheet` / `ActionRow` and `GuestPasteDialog`. |
| Identity/subscription | Existing rows, relocated on phone only. |
| Notes states | Existing EmptyState/retry Button; Skeleton loading; empty action uses the same verified compose entry. |
| Viewport shell | Existing hook and bounded document layout; no new modal. |

`ui-primitive-allowlist.ts` remains unchanged. Do not weaken boundary, design-system or primitive guards.

## 8. Owner conflicts to resolve before build

| Conflict | Recommendation for owner synthesis |
|---|---|
| P2 omits Copy, paste feedback, identity and subscription capabilities. | Approve the ⋯/scrollable-body placements in §4. Keeping them beneath the pill would change its required footprint. |
| P6 does not show edit locks, latest saved text or revision conflicts. | Preserve fully readable, scrollable edit details above the pill. Do not truncate the latest saved text into the two-line hint. Agree this supplemental region before implementation. |
| Lazy loading/verification may finish outside iOS’s keyboard-opening gesture. | Keep lazy loading and attempt the scoped readiness focus. If the Simulator requires another tap, stop for an owner choice between explicit tap-to-continue and earlier editor loading. Do not silently change the loading policy. |
| Guest review is a document; staff is a dialog. | Approve bounding the outer phone column, including notices. Simply copying the staff inner-root sizing leaves document-height and scroll defects. |
| D22 describes latest-Version collection counts; the tab describes the Version being reviewed. | Use displayed-Version threads for the tab; leave collection counts unchanged. |

**Already settled:** existing drawing tools stay despite P7’s illustrative top toolbar; uppercase button casing, full formatting tray, and the final pill tokens carry over.

## 9. DOM tests and verification

| Test file | Changes |
|---|---|
| `guest/GuestNotesWrite.dom.test.tsx` | Replace phone Add-button assumptions; verify every entry route, tray focus/holds, frozen stamp, mark/frame steps, Send states, Cancel, phone root edit, conflict and 401/re-verification draft preservation. Retain desktop cases. |
| **New** `guest/GuestNoteComposer.phone.dom.test.tsx` | Isolated rest/compose/draw structure, correct guest controls, accessible action names, holds, and editor identity across blur/mode/721px crossings. |
| `guest/GuestNoteEditor.dom.test.tsx` | Exercise actual rich editor pill props, toolbar portal, no mentions, guest media transport and upload blocking. |
| **New** `guest/GuestNoteField.dom.test.tsx` | Delayed chunk, footprint/loading state, scoped focus handoff, cancellation/stale readiness and recoverable failure. |
| `guest/GuestApp.dom.test.tsx` | Replace old no-keyboard `min-h-dvh` expectation; test outer-column viewport writes before focus, transition suppression, notice allocation, dismissal without blur, cleanup and count cases. |
| `guest/GuestVerifyDialog.dom.test.tsx` | Extend only if readiness/focus integration changes its contract. |

The existing write-suite editor stub proves flow; it cannot prove real editor wrapping or keyboard geometry.

Run relevant guest tests, staff phone composer/viewer regression tests, `ReviewSheet.dom.test.tsx`, viewport-hook tests, guest boundary, primitive ratchet, design-system and test-seam guards. Then run `npm run verify` from `portal/`.

Apply ReUI C1–C4 self-checks to changed files, fixing findings within two rounds. Document the bounded document shell if its fixed positioning triggers C4.

## 10. Browser pass

Serve this branch through `serve-branch.sh`. Every phone row runs in **Safari on the iOS Simulator**, including a smaller supported phone. Save screenshots in one folder with viewport, state and frame in each filename.

| Row | Prototype | Required evidence |
|---|---|---|
| Rest: verified/unverified; half and collapsed | P2, P3 | Pill remains visible; correct count; extras reachable. |
| First focus, keyboard up, typed text | P6 as guest | Entire strip above keyboard; text visible; anchor frozen; no first-focus flash. |
| Long draft and wrap | P6 + PR 1 ledger | Text above addon row; correct radius; whole-line scroll; film floor where space permits. |
| Tray open; horizontal scroll; formatting and marks | P6 + settled tray | Keyboard retained; every control reachable; tray holds compose. |
| Pen → stroke → Done | P7 as guest → P6 | Keyboard hides, canvas works, pen pressed, draft retained, keyboard/text return. |
| Root edit, including drawing lock | P6/P7 as guest | Saved anchor retained; Save semantics; restriction and conflict text readable. |
| Cancel with text, marks, drawing and upload | P6 → P2 | Complete discard, upload aborted, clean rest pill. |
| Ordinary blur and keyboard dismissal without blur | P6 → P2 | Draft retained; one-line rest; sheet/transport recover. |
| Blur while tray is open | P6 | Hold survives; closing tray restores browse appropriately. |
| Verify → compose, cold chunk | P2 → verification → P6 | Real keyboard and editable text after verification; no stale continuation. |
| Copy/paste; identity/email rows | P2 + approved capability placement | Actions/status reachable without enlarging composer foot. |
| Fresh load versus post-Cancel | P2 | Measure root recovery separately from PR 3 Safari tint. |

Each PASS/FAIL records screenshot, visual-viewport bounds, strip bounds and film height. Run desktop/tablet regression passes for the stacked form, root editing, copy/paste, footer rows and breakpoint crossing.

The session judges stage 1; the design reviewer then judges the saved screenshots blind against the matching prototype states.