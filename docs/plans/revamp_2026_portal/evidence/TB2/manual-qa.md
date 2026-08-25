# TB2 manual QA

Run date: 2026-08-25 (Asia/Kuala_Lumpur; timestamps below are UTC from the browser Network
events). Scope: matrix items 1, 2, 3, 4, 5, 6, 7, 8, 9, and 12, covered in this file. Items 10 and
11 were addressed in a separate live session with a genuine second principal — see
`access-loss-purge.md` for the full record. Summary: item 10 (both the membership-removal and
account-deactivation sub-cases) was live-reproduced and passed; item 11 was not attempted live and
is covered instead by the automated test suite plus two independent Opus code-level review passes.

## Environment and fixture disposition

- Local Worker: `http://localhost:8787`, already running and healthy (`HTTP 200`). The app was
  served directly from the Worker, not Vite 5173.
- Browser: existing Chrome session was already authenticated as the local seeded Quincy Admin.
  No Google sign-in screen was opened and no sign-in was attempted.
- Project A: existing local synthetic `1 Synthetic Test Street`; two RAW files,
  `quincy-r2-fixed-central.jpg` and `quincy-r2-fixed.jpg`. Both remained in `Processing preview`.
- Project B: disposable local synthetic `2 Synthetic Test Avenue`; one safe fixture upload,
  `260624-CR521409.jpg`, was used for the manual-upload lifecycle. Its local job reached
  `failed` because `quincy-portal-background` was not running. No real client project or paid /
  ambiguous AutoHDR send was used.
- The local rendition/background-worker gap is already documented in `docs/todo.md` and
  `docs/lessons.md`; it blocked rendered thumbnails, Lightbox interaction, and an active
  publication job.

## Result summary

| Item | Result | Evidence / disposition |
|---|---|---|
| 1 | Pass | Direct A, ordinary-link A→B→A, Back/Forward, and Cmd-click B all kept route-safe data. See `direct-url-history-and-ab-isolation.md`. |
| 2 | Pass for collection separation; Lightbox sub-check N/A | Slow 3G alternation produced exact `raw` and `edited` request keys and no cross-collection filenames. Lightbox could not open because A's two assets were still processing. |
| 3 | Pass for the browser race | Under Slow 3G, Edited started first, RAW started 369 ms later, the old Edited request ended `net::ERR_ABORTED`, and the final DOM remained RAW. See the exact event table below and `raw-edited-late-race-network.png`. |
| 4 | Partial: reconnect pass; hidden-tab portion N/A | Offline observing tab restored and refetched. The browser-control harness could not produce a real `hidden` `document.visibilityState`; all tabs stayed `visible`, and `Page.setWebLifecycleState("hidden")` was unsupported. This is recorded explicitly, not treated as a hidden-tab pass. |
| 5 | Pass with required same-session proxy caveat | Visible B observer showed 30-second raw/detail cadence. After the observed raw poll at 04:16:19.218, actor PATCH started at 04:16:22.992; observer detail refetched at 04:16:23.017 and showed the change. The actor/observer were two same-session tabs, not separate browser profiles. |
| 6 | Partial: detail-only pass; RAW-only N/A | Same-session BroadcastChannel detail invalidation was narrow and fast. RAW review/selection/cover controls were disabled by the rendition gap, so no honest RAW-only mutation was fabricated. |
| 7 | Partial / local-infra N/A for active owned publication lifecycle | Safe manual upload completed its callback and reached terminal failed state. The local background Worker absence prevented an active queued/running publication job and therefore prevented proving the owned 5-second lifecycle through its true terminal transition. Observed legacy status requests were ~5.01 s apart; ordinary project-data requests were ~30.0 s apart. |
| 8 | Partial | Comment draft, non-default filter, scroll, active RAW tab, open composer, and assignee survived a cross-tab detail refresh; all drafts were cancelled/cleared. Multi-tile selection was unavailable because both RAW tiles were disabled. Native date input opened, but the browser automation did not commit its value to the React draft state, so no due-date pass is claimed. |
| 9 | N/A | No rendered thumbnails / enabled asset controls existed locally; see the documented rendition-pipeline gap. No Lightbox draft or deletion mutation was attempted. |
| 12 | Pass for passive checks; subchecks dispositioned | Upload completion callback, Back/Forward/new-tab, comments/checklist read and draft cancellation, Network, Console, and responsive captures were exercised. Cover/review/RAW-selection revert was N/A because controls were disabled; delivery links were N/A because neither disposable project had a delivery collection. |

## Network and race evidence

Expected project query keys were exact tuples: `["project-data", projectId, "detail"]` and
`["project-data", projectId, "assets", collectionKind]`. Browser URLs matched those keys. The
late-race run used Slow 3G emulation (`latency=2200 ms`, `downloadThroughput=12000 B/s`,
`uploadThroughput=12000 B/s`) and cache disabled:

| UTC | Sequence | Event |
|---|---:|---|
| 04:00:58.708 | 368 | A `assets?collection=edited` request started. |
| 04:00:59.077 | 372 | A `assets?collection=raw` request started, 369 ms later. |
| after seq 372 | 374 | The earlier Edited request ended `net::ERR_ABORTED`. |
| after 04:00:59 | — | Final DOM contained `RAW frames`; no Edited content replaced it. |

Workspace Console check: zero `error` entries and zero `warn` entries in the inspected QA tab.
Network records were captured from the browser's CDP-backed DevTools Network domain.

## Method deviation and evidence caveat

The native Chrome DevTools panel could not be exposed through the local Mac UI connector
(`cgWindowNotFound`). I did not bypass that security boundary. The CDP Network event stream is
the primary evidence; the required PNG is a redaction-safe companion workspace-state crop, while
the exact request timeline is recorded above and in the linked Markdown records. This deviation is
explicitly disclosed rather than presenting the crop as a native DevTools-panel screenshot.

## Redaction and cleanup checks

- Screenshots were visually inspected after saving. Account identity in the fixed Chrome header
  was excluded from the responsive and race PNG crops. Synthetic street names and fixture
  filenames are the only project/media labels retained.
- No secret, signed URL, token, provider UID, private Dropbox path, real client contact, or billing
  data appears in the evidence files.
- Test comment and subtask drafts were not submitted. Detail-field edits used for timing were
  restored to their original empty values. No AutoHDR send was triggered.
- A read-only local D1 check after the run confirmed both synthetic projects have
  `agency_name=NULL`. Disposable B remains as synthetic local state with one fixture asset and
  one terminal failed manual-upload job; no real client data was created, mutated, or left
  behind. The attempted recoverable archive confirmation was not relied on after the browser
  dialog connector reset.

## Exact evidence files written

- `manual-qa.md`
- `direct-url-history-and-ab-isolation.md`
- `raw-edited-late-race-network.png`
- `focus-reconnect-poll-timing.md`
- `broadcast-timing-and-narrow-requests.md`
- `draft-lightbox-selection-scroll.md`
- `workspace-after-1440x900.png`
- `workspace-after-1024x768.png`
- `workspace-after-390x844.png`
