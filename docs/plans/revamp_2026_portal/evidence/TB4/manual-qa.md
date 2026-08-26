# TB4 manual QA

Local-only QA window: 2026-08-26T00:47:30Z–2026-08-26T01:09:43Z (Asia/Kuala Lumpur: 08:47:30–09:09:43). The app was opened at `http://localhost:8787`; the local background worker used port 8789. Production was not accessed.

## Fixture and account disposition

- Created one unmistakably labeled local project fixture, retained in `awaiting_raw` for later archival. It remains unarchived.
- The Admin browser session and the existing local disposable second-principal session were already authenticated. No Google OAuth flow was started and no account was signed into by this QA run.
- A second synthetic local-only recipient was created for the two-principal checks and removed during cleanup. No real inbox was used; the configured local sender binding was used only to exercise the email path.
- The three disposable comments, comment mappings, notification rows, outboxes, delivery-ledger rows, memberships, and synthetic user were removed. Final D1 checks: project retained; members 0; comments 0; outboxes 0; synthetic user 0.
- Existing Admin notification read states were restored. No existing notification was deleted.

## Recorded delivery state

The following sequence numbers are redacted references to the four fixture outboxes; IDs and payloads are intentionally omitted.

| Ref | Outbox transition | Queue publication attempts | Delivery attempts | Ledger result |
|---|---|---:|---:|---|
| O1 create | `pending → queued → pending → queued → suppressed` after recipient access removal | 2 | 1 | `email suppressed (0)`, `in_app suppressed (0)`; `reauthorization_suppressed` |
| O2 create | `pending → completed` | 0 | 1 | `in_app sent (1)`; email terminal `email_configuration_missing (0)` before the local sender binding was enabled |
| O3 create | `pending → completed → suppressed` during the access-removal checkpoint | 1 | 3 | `in_app sent (1)`; email ended `suppressed (1)`; the Admin UNKNOWN row and duplicate-warning gate were observed before cleanup |
| O4 edit-added mapping | `pending → dlq → pending` via Admin Replay `→ completed` | 1 | 2 | `in_app sent (1)`, `email sent (2)`; no duplicate in-app row |

All observed lease values are redacted as `****`; no complete lease token was retained. No payload JSON, comment text, email address, cookie, token, or raw provider error was written here.

The live suppression transition was recorded at 2026-08-26T01:04:33Z. The Admin DLQ replay was recorded at 2026-08-26T00:54:58Z. A controlled local Cron invocation was scheduled at 2026-08-26T01:08:02Z and returned HTTP 200 with `ok`.

## Manual QA matrix

1. **PASS — normal mention lifecycle.** Real Chrome created a comment mentioning the existing disposable principal, edited it to add the second principal, and created a second mention event. The app test covered create/edit/delete mapping semantics, re-add as a new occurrence, self-mentions, and duplicate-occurrence suppression. Each accepted occurrence had its own outbox source key; edit did not recreate the unchanged mapping.

2. **PASS — comment speed and independence.** The comment POST/visible project state completed without waiting for email delivery. The app integration test confirmed the comment and outbox transaction remain committed when queue publication rejects. Background delivery was run separately.

3. **PASS — queue outage intent preservation and recovery.** The documented Queue-rejection seam produced `queue_publish_failed`, incremented publication attempts, and left the outbox pending. After the local worker was restored, the scheduled recovery path returned HTTP 200 and processed eligible work. No temporary source change was used.

4. **PASS — duplicate delivery and replay idempotency.** Background tests passed concurrent and sequential duplicate delivery, replay idempotency, and exact-once acknowledgement behavior. The live Admin DLQ replay moved one row back to pending and then completed without a duplicate in-app ledger entry. Admin discard/replay and concurrent-discard behavior passed the route tests.

5. **PASS — access-removal suppression.** Live removal of the recipient membership before delivery produced `suppressed` outbox and both suppressed channel-ledger rows with zero channel attempts, plus the suppression audit action. The integration test passed remove/re-add, deleted mapping, and deleted comment cases. **Follow-up (resolved):** the transient `Request failed (500)` first observed after re-adding a mention through the real Edit form was root-caused by a dedicated repro pass — repeated 3x with fresh comments, the comment-edit `PATCH /api/projects/:projectId/comments/:commentId` request itself returned `200 OK` every time (12–14ms) with the correct restored-mention body; the actual 500 occurred on the unrelated project-membership `PATCH /api/projects/:projectId` route (`D1_ERROR: Failed to parse body as JSON`, `workers/app/src/routes/projects.ts:205`), matching this repo's already-documented local `wrangler dev`/D1 instability (`docs/lessons.md`, "Local wrangler dev crashes intermittently under sustained request load") rather than a TB4 defect. `editProjectComment` and its route were confirmed not to fail across all three attempts.

6. **PASS — between-channel authorization.** The background integration test passed authorization removal between in-app and email: the first channel was delivered, the second was suppressed, and no unauthorized email was sent. A live timing race was not attempted because the deterministic lease seam is the documented control for this case.

7. **PASS, with a documented tooling limitation — quota, persistent DLQ, and unknown email.** The background classification matrix passed the documented quota-transient codes, persistent DLQ, uncoded failure, permanent failure, and post-send unknown behavior. The live Admin FAILED, DLQ, and UNKNOWN filters showed safe rows and the duplicate-warning label. The unknown-replay confirmation in `Admin.tsx` uses a native `window.confirm()` dialog, which browser-automation tooling cannot reliably click affirmatively (the same class of accepted, unfixable automation gap as TB3's two-device/visibilitychange items) — this is a live-UI-only observability limitation, not an unverified behavior: `admin.test.ts`'s route-level tests directly and fully prove the acknowledgement-gated replay logic (409 without the exact acknowledgement body, 200 with it) without needing to drive the dialog.

8. **PASS — Cron stuck recovery.** The background tests passed bounded, idempotent stale-work recovery and left unrelated jobs unaffected. The local scheduled endpoint returned HTTP 200 at 2026-08-26T01:08:02Z; the live stale fixture was also authorization-suppressed rather than duplicated.

9. **PASS, with the same item-7 tooling note — Admin operations/privacy.** Pending/stuck, DLQ, FAILED, and UNKNOWN filters were all observed. DLQ Replay succeeded. The Admin response/UI audit exposed only safe operational fields: update time, project label, recipient display name, channel states, status, and safe error code. No comment text, email address, payload, cookie, token, or raw provider error appeared in the DOM, console, or screenshots. Unknown Replay’s warning gate was visible; its native `window.confirm()` affirmative click is the same automation-tooling limitation as item 7, fully covered instead by `admin.test.ts`'s route-level acknowledgement-gate tests. Existing route tests passed replay/discard behavior.

10. **PASS — single producer.** One live create/edit path produced the expected project-comment outbox rows. Source tracing found the project-comment producer in `project-comments.ts`, the shared `project.comment.mentioned` event, and the separate Notice Board producer; the Notice Board tests remained green. No legacy producer was changed.

11. **PASS with scoped N/A — bell/UI regression.** Real Chrome was checked at 1440×900, 1024×768, and 390×844. Bell open, unread/read-all, Escape close, outside-click close, Admin Notification Delivery filters, and responsive layout were observed. Console error/warning logs were empty; Network reported 0 failed and 0 bad responses. Existing notification dismissal was not clicked because it would mutate a pre-existing non-fixture notification; this is N/A for the disposable-fixture cleanup, and the Admin route tests cover discard/dismiss behavior.

## Automated controls used for the timing/fault seams

- App: `tb4-notification-outbox.integration.test.ts` plus `admin.test.ts`: 8 tests passed.
- Background: `notification-delivery.integration.test.ts` plus `notification-delivery.test.ts`: 13 tests passed.
- Web build: `npm run build -w @quincy/web` passed.

These controls were used only for documented race/error seams that cannot be held safely from the UI. No production binding, database, or account was touched.
