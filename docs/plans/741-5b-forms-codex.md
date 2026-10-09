## Recommendation

Replace the split state with **one collection-scoped controller**, created by [VideoCollectionPanel.tsx](/Users/tingruilee/quincy-wt/741-5b/portal/apps/web/src/components/video/VideoCollectionPanel.tsx). Subscribe through React’s `useSyncExternalStore`; keep TanStack Query authoritative for server notes.

This is smaller than a module singleton: the collection already survives viewer close, panel remounts and Version changes, and its lifetime matches the draft spec. No new state library.

### 1. Ownership table

Proposed module: `lib/video-note-form-owner.ts`.

**Scope:** query client + principal identity/authorization epoch + project.  
**Form key:** `(assetId, kind, targetId)`; `assetId` identifies the Version. Composer has no target; edit targets a note; reply targets a root.

| State | Owner/key | Created by | Retired/reset by |
|---|---|---|---|
| Active form: kind, noteId/rootId, versionId | Owner’s single active pointer | Viewer open; explicit Edit/Reply/Resume | Another activation; Version leave; viewer close; explicit dismissal; access termination |
| Text per form | Owner’s form records, keyed above | Typing; first Edit seeds opened text | Explicit discard/Cancel; definitive deletion; successful submission **only if unchanged**; Video tab ends |
| Composer visibility + frozen anchor | Composer record | Visibility choice; first character captures anchor | Empty/discarded/successfully cleared draft resets Internal + no anchor; retained drafts preserve both |
| Marks per form | Owner’s active record | Edit opening seeds original frames; synchronous I/O/Make point | Clear; deactivation; Version leave; viewer close; applicable success |
| Baseline revision/body/frames | Retained edit record; separate delete intent | First Edit/Delete opening | Record discarded/successfully retired; never changed by refetch |
| Conflict snapshot | Same edit record or delete intent | Parsed 409 response | Explicit dismissal; successful retry; another 409 replaces it |
| Phase | Derived from the operation attached to that record | Begin confirmation/request | That operation settles or confirmation is cancelled; no component phase mirror |
| In-flight submission | Owner’s operation map, unique operation ID | Submit captures exact payload, draft token, form key, clock and call-time context | Confirmation cancellation/timeout; sent request settles |
| Completion | Owner’s atomic operation transition | Mutation result | Settle once; conditionally retire originating draft; never reset another active form |
| Escape-spent | Owner’s active activation | First form-owned Escape | User text/mark change; new activation; form closes |

All retained text, baselines and conflicts survive form unmount and Version changes. All principal state disappears at identity/access retirement.

**Two details prevent new races:**

- Compare a **draft identity/user-edit revision**, not trimmed text. Body, visibility, anchor and intentional mark edits advance it; lifecycle mark clearing does not.
- After Version leave, resumed edits discard previous marked-frame changes. Seed the opened baseline frames for display, but Save sends frame fields only after a new explicit frame action.

### 2. Transitions and guards removed

**Post:** synchronously capture the draft and frames; freeze its controls; seek/pause and confirm range start or frozen anchor, with the settled 10-second timeout. Cancellation invalidates the operation before it can send. Edit Save sends its stored intent directly.

A request already sent survives viewer close/Version leave. Its result updates the originating record reactively, including a remounted composer. It closes an edit only if that same record still owns that operation.

**Filters:** keep an active edit/reply visibly pinned outside filtered results when necessary, labelled “Outside current filters.” Counts and markers remain filtered. Parked drafts offer Resume/Discard; reopening preserves their baseline and conflict snapshot.

Delete:

- Composer `attempt`, phase refs/mirrors, token refs and phase-report effects.
- `use-note-forms` form generation, marks generation and pending-mark promises.
- Component-local composer/edit/reply draft copies and conflict flags.
- Filter/unmount-driven form clearing.
- `data-escape-spent`, DOM dirty-state decisions and `quincy-notes-escape`.
- `DraftStore`, `clearSent`, `clearSentDraft` and effect-driven draft mirroring.
- Component-owned submission completion and access-error callbacks.

Keep **operation IDs**, call-time mutation context, and the viewer’s **per-keydown Escape snapshot** for Base UI’s duplicate reports. These have defined ownership rather than component-lifetime guards.

### 3. Review closure

#### Round 3

| Finding | Closure |
|---|---|
| **1 — conflict hides editor** | Text/baseline/conflict are retained by the owner; the active form remains visibly pinned outside filters. |
| **2 — remounted composer retains posted text** | Every composer reads the same reactive record; successful completion clears the unchanged originating draft. |
| **3 — deferred marks** | I/O capture synchronously; no pause, promise or pending-mark state. |
| **4 — stale access error skipped** | Mutation data-layer handling runs before any owner/UI liveness suppression. |
| **5 — cluster’s invisible range wins** | Multi-member clusters hit-test as points at their rendered position. |

#### Round 1

| Finding | Closure |
|---|---|
| **1 — live revision overwrites** | Save uses opened revision; explicit Save anyway uses the stored 409 snapshot. |
| **2 — shared editor marks** | One active form; marks belong to its keyed record. |
| **3 — controls change captured submission** | Freeze submitting controls; immutable payload and conditional draft retirement. |
| **4 — confirmation accepts another frame** | Require the captured clock and exact captured anchor; mismatch keeps draft and sends nothing. |
| **5 — Escape still posts** | First form-owned Escape cancels confirmation centrally before focusing its textarea. |
| **6 — marked Post bypasses confirmation** | Every composer Post follows the same confirmation path. |
| **7 — Delete repeats stale revision** | Delete anyway uses the immutable returned conflict note’s revision. |
| **8 — invisible editor owns I/O** | An active editor remains visibly pinned; closing it explicitly transfers ownership. |
| **9 — sticky public visibility** | Clearing text resets Internal and anchor. |
| **10 — pending band misalignment** | Preserve the shipped slider-only wrapper alignment. |

#### Round 2

| Finding | Closure |
|---|---|
| **1 — old Version callback resets new form** | Completion addresses its operation and originating record only. |
| **2 — unmounted success leaves draft** | Owner completion retires unchanged draft independently of component lifetime. |
| **3 — Escape depends on focus ancestry** | Owner decides from active form + dirtiness + Escape-spent. |
| **4 — marked Post skips timeout** | Same bounded confirmation path for every marks state. |
| **5 — pending marks resurrect** | Pending marking is removed entirely. |
| **6 — resize clustering absent** | Preserve measured-width clustering and resize recomputation. |
| **7 — phone anchor target too small** | Preserve the shipped fine-pointer phone 44px rule. |

**Data-layer requirement:** [video-notes-data.ts](/Users/tingruilee/quincy-wt/741-5b/portal/apps/web/src/lib/video-notes-data.ts) currently misses 401/403 classification, and its direct promises bypass MutationCache handling. Handle access there for all five writes; terminate the **captured** principal client on 401, recheck/purge access at the appropriate scope on 403/access-404, and prevent retired-client cache writes. An authorship 403 must not terminate an unrelated current principal.

### 4. Cluster hit-testing rule

Adopt the proposed rule:

- **Multiple members:** point at `cluster.first.startFrame`, matching the rendered cluster position.
- **Singleton:** retain point/range hit-testing through `endFrame - 1`.
- Preserve the 8px reach, thumb-centre geometry and deterministic frame → creation time → ID tie-break.
- Recompute render and hit-test candidates from the same measured-width clustering result.

### 5. Behaviour tests

Paths below are under `portal/apps/web/src/`.

| File | Behaviour to pin |
|---|---|
| `components/video/VideoNotes.dom.test.tsx` | Conflict resolves thread out of Open: draft/conflict remain visible; retry sends stored conflict revision despite another refetch. |
| Same | Post on v2 → v1 → v2 while request pending: remount sees pending state; success visibly clears unchanged draft; newer draft survives. |
| Same | v1 submission completes while v2 edit is open: v2 text, marks, phase and active form remain unchanged; cache patches v1. |
| Same | Version/close/dismiss cancels confirmation; late frame arrival sends nothing; text returns and marks do not. |
| Same | Dirty composer/edit/reply owns first Escape even with player focus; textarea gains focus; second closes; user changes re-arm it; nested layers consume first. |
| `components/video/VideoNoteComposer.dom.test.tsx` | All marks states confirm captured anchor, timeout keeps draft, controls freeze, ambiguous failure never auto-retries. |
| `components/video/VideoNoteThread.dom.test.tsx` | Opened revision survives refetch/remount; explicit conflict retry; resumed text-only edit sends no discarded frame intent; Save never seeks. |
| `lib/video-notes-data.test.ts` | Late 401 after caller unmount clears originating principal; old-principal success/401 cannot affect fresh client; scoped 403 handling; no post-retirement cache repopulation. |
| `lib/video-timeline-geometry.test.ts` + `components/quincy/VideoTimelineMarkers.dom.test.tsx` | Clustered full-length range cannot steal a midpoint singleton click; singleton ranges still hit; resize changes candidates. |

Replace tests asserting that I pauses/waits or that filtering discards edits. Retain the band alignment, phone target and notes-off viewer regressions.

### 6. File-level changes

Approximate production-code sizes:

| File | Change |
|---|---|
| **New** `lib/video-note-form-owner.ts` | ~200–260 lines: typed records, transitions, subscription and operation coordination |
| `components/video/use-note-forms.ts` | Delete all 111 lines |
| `VideoCollectionPanel.tsx` | Replace DraftStore with scoped owner; ~15–25 lines |
| `use-video-notes.ts` | Bind lazy data/clock adapters; remove form/draft/access mirrors; net −35–55 lines |
| `VideoNoteComposer.tsx` | Controlled rendering + commands; net −100–130 lines |
| `VideoNoteThread.tsx` | Controlled edit/reply/conflict state; net −75–100 lines |
| `VideoNotesPanel.tsx` | Owner-backed delete intent and retained-form presentation; roughly −15–35 lines |
| `VideoNotesHost.tsx`, `VideoReviewViewer.tsx` | Pass owner; explicit lifecycle/Escape commands; net −15–30 lines |
| `lib/video-notes-data.ts` | Access policy and retired-client fences; +40–70 lines |
| Marker component/geometry | Point projection for clusters; ~5–15 lines |
| Tests, plan/ledger/map/lesson | Rewrite obsolete assertions; add lifetime regressions; correct async-mark guidance |

Keep the owner lightweight so collection imports do not eagerly load the notes UI/data chunk. Keep frame-clock subscriptions confined to the anchor chip.

**Reuse ledger additions:** pinned retained thread → existing `reui/item`/`VideoNoteThread`; outside-filter/conflict notice → `quincy/Notice`; Resume/Discard → `quincy/Button`. Existing forms and marker ledger remain applicable.

Read-only inspection at `75fa51e5`; no files changed or tests run. Independent Luna exploration and Sol plan review completed. Opus was unavailable; TypeSafe documentation access failed, so no TypeSafe verdict was used.