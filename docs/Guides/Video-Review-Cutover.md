# Video Review Cutover (#741)

How the owner turns native video review on for one pilot Project, then for every Project, then
moves active Videos off Frame.io, and how to turn it off again. Operator-only: there is no admin
toggle route and no migration ever sets these rows (`docs/plans/741.md`, "Owner rules"). Every
command runs from `portal/workers/app`.

## What flips

Video review is a set of `feature_flags` rows. A **missing row is off**, and a Project nobody
opened has no video review. The gate reads them in one statement
(`portal/workers/app/src/lib/video-review-gate.ts:11-18`); the keys come from
`portal/packages/shared/src/video-review.ts:27-30`.

Open for a Project = `video_review` AND (`video_review_all_projects` OR `video_review_pilot:<projectId>`).
A part is on only when the Project is open AND its `video_review_<part>` row is on. Rows count only
with `enabled = 1`.

| Flag key | Turns on |
|---|---|
| `video_review` | Master switch. Open check for listing, streaming and posters (no "view" part exists; viewing survives `upload` being turned off, `video-review-gate.ts:20-23`) |
| `video_review_pilot:<projectId>` | Scope: that one Project |
| `video_review_all_projects` | Scope: every Project |
| `video_review_upload` | Upload Versions |
| `video_review_notes` | Time-coded notes and replies |
| `video_review_markup` | Freehand markup on notes |
| `video_review_compare` | Compare two Versions |
| `video_review_export` | EDL / FCPXML marker export |
| `video_review_links` | Staff create and manage Review links |
| `video_review_guest` | The guest surface (`/d/review`); needed with `video_review` for any guest request (`guest/link.ts:30-33`) |
| `video_review_guest_comments` | Guest notes |
| `video_review_delivery` | Approval, Release, premium unlock, downloads and Download all |
| `video_review_notify_staff` | Staff notifications for video events |
| `video_review_notify_client` | Client hourly digest email |
| `video_review_trash` | Video trash (`manageVideoTrash`) |

The part list is `VIDEO_REVIEW_PARTS` (`shared/src/video-review.ts:9`). It has 12 parts: `trash`
is not in the part list of `docs/plans/741.md` (11 parts).

Table shape (`portal/packages/db/src/schema.ts:59-71`): `key` text primary key, `enabled` integer
0/1, `updated_by` nullable user id, `updated_at` integer epoch milliseconds, not null. The
commands below leave `updated_by` null.

## 1. Pre-flight (owner, before any pilot)

- [ ] **NLE import.** Import both marker files from
  `qa-evidence/741-8-9/` (main checkout): `cfr-25-v2-notes-all-public.edl` and
  `cfr-25-v2-notes-all-public.fcpxml` (also `cfr-25-v2-notes-all-with-internal.edl`) into your
  editor. Confirm every marker lands on the right frame and carries the right note text. Do not
  pilot if a marker is off.
- [ ] **Email probe, on a throwaway test Project** (`docs/plans/741-13-15.md`, "Email proof, two
  steps"). There is no preview deploy, and the guest flow is pinned to the production
  `APP_ORIGIN`. The code route also answers 404 unless the master flag, Project scope and `guest`
  are all on, so the probe needs temporary flags on a **test** Project, never a client Project:
  1. Enable `video_review`, `video_review_pilot:<testProjectId>`, `video_review_upload`,
     `video_review_links` and `video_review_guest`, using the `INSERT … ON CONFLICT` shape from section 2. Leave
     `guest_comments`, `notify_staff` and `notify_client` **off**.
  2. On the test Project, upload a short Version and create a Review link. Open it in a private
     window. With `guest_comments` and `notify_*` off the page shows no "Add a note" or email
     prompt, so request the code from that window's DevTools instead:
     - In the Network tab, find any `/d/api/links/<linkId>/…` request the page made and copy the
       `<linkId>`.
     - In the Console of the same tab (same origin, so the guest cookie and `Origin` header go with
       it), run:
       ```js
       await fetch("/d/api/links/<linkId>/email/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "first@example.com" }) }).then(async (r) => [r.status, await r.json()])
       ```
       Expect `[202, { sent: true, resendAfterSeconds: 60 }]`. A 403 `invalid_origin` means it was
       run from another tab; a 404 means one of the five flags is missing.
     - Use a **second private window** for the second address: once a session has a code, a
       different address on the same session needs a fresh session, and the same session can send
       again only after 60 seconds.
     Use two addresses that are **not** verified Email Routing destinations (otherwise the probe
     proves nothing), and confirm both codes arrive in the inbox, not spam.
  3. Remove the temporary rows with the section 4 `DELETE`, using the same five keys.

  If either code fails to arrive, stop and reopen the sender choice. Workers Paid is confirmed on
  #741. Set-up reference: `docs/Guides/Cloudflare-Email-Service-Setup.md`.
- [ ] **Migrations 0068 and 0069 applied.** Read-only; the output must say
  "No migrations to apply" (`docs/Guides/CI-Deploy.md:13`):
  ```sh
  npx wrangler d1 migrations list DB --remote
  npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('videos','video_notes','guest_reviewers','guest_sessions','video_releases') ORDER BY name"
  ```
  The second command must return all five tables (0068 creates `videos`, `video_notes`,
  `guest_reviewers`; 0069 creates `guest_sessions`, `video_releases`).
- [ ] **#802 (zip truncation).** Guest "Download all" of large videos is cut off by the current zip
  writer (Worker CPU limit above about 700 MB, issue #802, open) until #802's native writer ships.
  Keep `video_review_delivery` **off**, or accept single downloads only, until then.

## 2. Pilot: one Project

Pick one Project and take its id. Capture a Time Travel bookmark first
(`npx wrangler d1 time-travel info DB`, record the id) so there is a restore point; a restore loses
every write since it (`docs/Guides/CI-Deploy.md:25`).

Enable master, scope and the first parts in one statement:

```sh
npx wrangler d1 execute DB --remote --command "INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('video_review', 1, CAST(unixepoch('now') AS INTEGER) * 1000), ('video_review_pilot:<projectId>', 1, CAST(unixepoch('now') AS INTEGER) * 1000), ('video_review_upload', 1, CAST(unixepoch('now') AS INTEGER) * 1000), ('video_review_notes', 1, CAST(unixepoch('now') AS INTEGER) * 1000), ('video_review_markup', 1, CAST(unixepoch('now') AS INTEGER) * 1000), ('video_review_compare', 1, CAST(unixepoch('now') AS INTEGER) * 1000), ('video_review_export', 1, CAST(unixepoch('now') AS INTEGER) * 1000) ON CONFLICT(key) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at"
```

Suggested order of parts (one `INSERT` per step, same shape; only `key` changes):

1. `upload`, `notes`, `markup`, `compare`, `export` (staff only; also `trash` here, suggested, so a
   removed Video can be recovered).
2. Wait for the pre-flight probes, then `links`, `guest`.
3. `guest_comments` and `notify_client` only after the email probe passed.
4. `notify_staff` once staff are ready to receive the emails.
5. `delivery` only once #802 has shipped (or you accept single downloads only).

Check the current rows (read-only):

```sh
npx wrangler d1 execute DB --remote --command "SELECT key, enabled, datetime(updated_at / 1000, 'unixepoch') AS updated FROM feature_flags WHERE key LIKE 'video_review%' ORDER BY key"
```

**What to watch** (read-only; timestamps are epoch ms, `docs/agents/production-data.md`):

```sh
# Audit rows from the feature (audit_log: action, target_type, target_id, created_at)
npx wrangler d1 execute DB --remote --command "SELECT action, target_type, target_id, datetime(created_at / 1000, 'unixepoch') AS at FROM audit_log WHERE action LIKE 'video%' OR action LIKE 'review_link%' ORDER BY created_at DESC LIMIT 50"
# Notification outbox for video events, by status (event type project.video_review.notification)
npx wrangler d1 execute DB --remote --command "SELECT status, COUNT(*) AS n FROM notification_outbox WHERE event_type = 'project.video_review.notification' GROUP BY status"
# Dead-lettered or failed ones, with the error
npx wrangler d1 execute DB --remote --command "SELECT id, status, last_error_code, delivery_attempts, datetime(updated_at / 1000, 'unixepoch') AS at FROM notification_outbox WHERE event_type = 'project.video_review.notification' AND status IN ('failed','dlq') ORDER BY updated_at DESC LIMIT 20"
# Client digest rows not yet sent
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS pending FROM guest_notification_digest WHERE sent_at IS NULL"
```

Anything in `failed` or `dlq`, or a pending digest that does not drain within the hour, is a stop:
turn the affected `notify_*` part off (section 4) and diagnose.

## 3. Cutover

Only after the pilot Project has been through a full review round (upload, notes, a guest Review
link, export) without a stop.

1. Open every Project:
   ```sh
   npx wrangler d1 execute DB --remote --command "INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('video_review_all_projects', 1, CAST(unixepoch('now') AS INTEGER) * 1000) ON CONFLICT(key) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at"
   ```
   Parts stay per-part: enable any not yet on, same shape as section 2. The pilot rows can stay or
   be deleted; `all_projects` makes them redundant.
2. **Move active Videos off Frame.io.** Frame.io history is not imported (spec "Out of scope"):
   re-upload each active cut as a Version in the Project's Video Collection.
3. **Video only.** If Frame.io also delivers photos for a client, keep Frame.io for photos until the
   single delivery page exists (spec "Out of scope").
4. **Tell clients.** For each Video create a Review link and send the new
   link in place of the Frame.io link. The link is shown once, at creation; afterwards "Replace
   link" issues a new one and ends existing guest sessions (`docs/plans/741.md`, decisions).

## 4. Rollback

Delete rows; a missing row is off. Data is kept: Videos, Versions, notes, Review links and
approvals stay in D1 and R2, and reappear when the rows come back.

```sh
# One part
npx wrangler d1 execute DB --remote --command "DELETE FROM feature_flags WHERE key = 'video_review_delivery'"
# All projects back to pilot-only
npx wrangler d1 execute DB --remote --command "DELETE FROM feature_flags WHERE key = 'video_review_all_projects'"
# One pilot Project
npx wrangler d1 execute DB --remote --command "DELETE FROM feature_flags WHERE key = 'video_review_pilot:<projectId>'"
# Everything off
npx wrangler d1 execute DB --remote --command "DELETE FROM feature_flags WHERE key = 'video_review' OR key LIKE 'video_review\_%' ESCAPE '\' OR key LIKE 'video_review_pilot:%'"
```

Confirm with the section 2 SELECT: it must return no rows.

What users see when off: staff routes answer 404 and the web reads `GET /api/projects/:id/video-review`
as closed with no parts (200, `shared/src/video-review.ts:32`), so the Video UI is absent. Guest
Review links answer the same `/d/*` stub as before the feature, byte-identical
(`docs/plans/741.md`, Flags). Do not use the Time Travel restore for this: it loses every write
since the bookmark.
