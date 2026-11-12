# Plan: retire the every-minute cron (PR 3)

Settled 2026-11-12 from blind Opus (deep-reasoner) and Codex plans, synthesized by the session.
Base: PR 2 (`fix/d1-jobs-retention`), which sits on PR 1. The owner's decision is that nothing in
the Portal is real-time critical: reminders may fire up to 30 minutes late.

## The fact that decided the shape

**Workers Paid allows 10,000 subrequests per invocation** (Cloudflare changelog 2026-02-11, and
`workers/platform/limits`), and this account is on Paid (`wrangler.jsonc` comment and lessons
§ "Workers plan tier was the root cause…").
- Codex assumed 1,000 and designed a maintenance queue with continuations and cursors. That
  design is **not adopted**.
- Opus's worst-case counts (~1.7k for the recovery tier added to ~5–6.5k of existing hourly work)
  fit inside 10k. Keep its arithmetic in the PR description.

## Shape

- **Triggers** (`workers/background/wrangler.jsonc`): `["*/30 * * * *", "0 * * * *"]`.
  - At :00 these are two invocations, each with its own budget.
  - Production already fires two crons at :00 today (minute + hourly). Every write is CAS- or
    lease-fenced, so this adds no new hazard.
  - Codex's single-trigger variant is not needed.
- **`*/30` branch:** `scanProjectDeadlineOccurrences`, `scanSubtaskReminderOccurrences`, `processExternalRoleCachePurges` (F1),
  `reconcileEditedArrivals` and `recoverNotificationOutbox`.
  - Outbox recovery is on this tier so a failed reminder send is retried within 30 min rather
    than ~90 (Opus F3). It costs ~500 subrequests.
- **`0 * * * *` branch:** existing hourly work plus the rest of the old minute tier, ordered:
  1. Rendition recovery, manual publish sweep, external upload sweep, video upload
     sweep.
  2. Rotating Editor page, then initial-sync recovery, then move recovery. Move recovery comes
     after the page, so the 10-min throttle de-duplicates.
  3. Existing RAW, AutoHDR, subtask reconcile, digests, guest work, `pruneJobHistory`, video
     trash, CRC and daily sweeps.
- Delete the `* * * * *` branch. An unknown cron keeps its warning.
- Leave `boardSchemaVariant` as is (both plans). Invocations drop from 61/h to 3/h.

## Caps (sized for 10k)

| Constant | Now | New | Why |
|---|---|---|---|
| `PROJECT_DEADLINE_SCAN_LIMIT` | 100 | 250 | 30 shoots × 9 occurrences clears in 2 pages |
| `SUBTASK_REMINDER_SCAN_LIMIT` | 100 | 250 | same |
| `EDITED_ARRIVAL_PAGE_SIZE` | 25 | 50 | 100/h, well above arrival rates |
| move recovery `.limit` | 10 | 50 | 30 rescheduled shoots in one page; INGEST concurrency 1 keeps Dropbox calm |
| initial-sync `.limit` | 25 | 50 | |
| `NOTIFICATION_RECOVERY_LIMIT` | 100 | 200 | needs the bind fix below; pinned in `packages/db/test/tb4-contracts.test.ts` |
| embedded rendition `RECOVERY_LIMIT` | 10 | 50 | a failed HEIC batch clears in one run |
| `MANUAL_PUBLISH_SWEEP_LIMIT` | 25 | 50 | pinned in `manual-publish-recovery.test.ts` |
| upload sweeps / role purge | 100 / 20 | unchanged | |

## Correctness fixes

- **Existing bug (Codex):** `recoverNotificationOutbox`'s expired-email UPDATE binds 2 timestamps
  plus up to `NOTIFICATION_RECOVERY_LIMIT` IDs. That is 102 at today's 100, over D1's 100-bind
  limit. Bind the IDs as one JSON array (`IN (SELECT value FROM json_each(?))`) and test a full
  page.
- `PROJECT_DEADLINE_OPERATIONAL_TARGET_MS` goes from 120 s to 35 min. Otherwise every off-grid
  reminder logs "latency target exceeded".
- On-grid reminders are not late: the scans bind the nominal `scheduledTime`, and the default
  17:00 Deadline and the 1d/4h/1h presets land on :00. Only custom times or offsets lag, by up
  to 30 min.

## Windows that become slower (documented, not changed)

- Expired editor move lease: takeover up to ~70 min. Still under `MOVE_OVERDUE_MS` (2 h), so no
  false "overdue".
- Stale initial sync: 20–80 min.
- Notification consumer crash under the 10-min delivery lease: recovered within 40 min.
- Dead video upload: still counts toward the 3-per-user cap and the archive 409 for up to 75 min
  instead of 16.
- Manual publish detection: 2–3 h.

## Owner decisions (2026-11-12)

- **F1 — External role cache purge: keep it on the 30-min tier.**
  - Move `processExternalRoleCachePurges` into the `*/30` branch.
  - `PURGE_RETRY_DELAY_MS`: 1 min → 30 min.
  - `PURGE_DEADLINE_MS`: 30 min → 3 h. That allows ~6 attempts, within the existing 5-attempt cap;
    raise the cap to 6 only if the test shows the deadline is hit first.
  - The stale edge-cache window after a role change is now up to 30 min.
  - No auth code changes.
  - Legacy payloads already carry a persisted `deadlineAt`. Test that an in-flight job written
    under the old 30-min deadline still completes or freezes exactly as before.
- **F2 — Subtask advance reminders under 30 min: accept and document.**
  - Off-grid advance reminders under 30 min are usually superseded; "Due now" always arrives.
  - Document this in `docs/maps/notifications.md` and the shared GLOSSARY reminder entry.
  - No code change.
  - Separately, `notification-delivery.ts:~1070` hard-codes "due in 1 day" for every advance
    offset. That is a pre-existing bug and out of scope.

## Tests

- **`scheduled.test.ts`:**
  - Per tier: each job runs exactly once and never on the other tier.
  - One job failing leaves its siblings running.
  - Order is asserted: rotating page before move recovery.
  - Mock the four minute tasks that are not mocked today. They throw on `{}`, so the current
    error assertion can never fail (lesson "A grep gate that cannot fail is not a gate…").
- **Wrangler guard:** a guard through `__BACKGROUND_WRANGLER_CONFIG__` checks that every
  configured cron has a branch and that `* * * * *` is gone.
- **Re-point hard-coded crons:**
  - `editor-folder-move-cron`, `editor-folder-move` → `0 * * * *`;
  - `edited-arrival`, `object-crc-sweep` → `*/30`;
  - update pinned caps.
- **Integration tests:**
  - a 200-row outbox recovery page (bind fix);
  - a 250-row deadline page, where row 251 waits for the next tick;
  - the F2 behaviour as decided.
- Run `npm run verify`.

## Docs

- Update `docs/maps/notifications.md` (Crons) and `docs/maps/queues.md`.
- Update `Editor-Dropbox-Rollout.md:54` ("within minutes").
- Update the "minute cron" comments: `attention.ts:15`, `embedded-display-recovery.ts:12`,
  `video-upload-sweep.ts:13`, shared `renditions.ts:41`, app `embedded-media-upload.ts:115`,
  `index.ts`.
- Update the 1,000-budget comments in `edited-arrival.ts:15` and `reconcile-awaiting-raw.ts:19`.
- Add a lessons entry (Tags: queues-workflows, scheduling).

## Rollout

- No migration. The merge deploys from CI.
- `wrangler rollback` may not revert cron triggers. Opus has not verified this; check it before
  merge. An old version receiving `*/30` would log "Ignored unknown Cron trigger" and silently
  stop reminders. Add to `CI-Deploy.md`: on rollback, restore `["0 * * * *","* * * * *"]` first.
- **Confirm in production:**
  - the Triggers tab shows exactly the two crons;
  - the three scans plus outbox recovery log at :00 and :30, and the recovery tier logs at :00;
  - no "Ignored unknown Cron trigger" or "Too many subrequests" in the logs;
  - "Project Deadline in-app latency" stays at or under 35 min.
