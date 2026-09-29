# Subtask ranges: one-off backfill (#341)

Every Subtask that is not already a range (unscheduled, due-only, legacy unresolved or invalid) is
converted once to a range, computed by the shared `defaultSubtaskRange` (ADR 0011). This is an
operator-run backfill, **not a D1 migration**. It touches live data: **get the owner's explicit
approval before applying.**

The backfill is silent: no "schedule changed" notifications, no activity events, no outbox rows. Each
converted row bumps its `schedule_version` and gets one system `project_subtask.update` audit row
(`actor_id` NULL, `meta.actor` `"system"`, `meta.source` `"subtask_range_backfill"`).

Files, all under `portal/scripts/`:

- `subtask-range-backfill-dryrun.sql`: SELECT only. Returns **every** Subtask with its Project's inputs.
- `subtask-range-backfill.ts`: `prepare` classifies the rows and writes the manifest and review;
  `apply` turns an approved manifest into `apply.sql`. It does no database IO.
- `subtask-range-backfill-verify.sql`: SELECT only. Counts Subtasks without a complete range.

Run the `.ts` under `npx --no-install tsx`, not `node`: plain node cannot resolve `@quincy/shared`'s
extensionless TypeScript imports.

## Order

Run every command from `portal/`. Keep the scratch files (dry run, manifest, review, apply) **outside
the repository**, because they hold Subtask titles and street names.

1. **Preconditions.** All three must hold:
   - #340 is deployed, so no API path still writes unscheduled or due-only Subtasks. A row written by an
     older path after the dry run would be missed.
   - #343 (the range-only constraint) is **not** merged yet. It lands after this backfill verifies clean.
   - The owner has agreed to run the backfill.
2. Back up D1:
   `npx wrangler d1 export quincy-portal --remote --output ~/quincy-d1-backups/quincy-portal-<date>-pre-subtask-ranges.sql`
3. Dry run (SELECT only):
   `npx wrangler d1 execute quincy-portal --remote --json --config workers/app/wrangler.jsonc --command "$(grep -v '^--' scripts/subtask-range-backfill-dryrun.sql)" > <scratch>/subtask-ranges-dryrun.json`
   Use `--command`, not `--file`: a remote `--file` run goes through D1's import endpoint and returns
   query counts rather than rows, and `prepare` refuses that output. The `grep` strips the header
   comments so they are not sent as statements.
4. Prepare the manifest and the review:
   `npx --no-install tsx scripts/subtask-range-backfill.ts prepare --dryrun <scratch>/subtask-ranges-dryrun.json --manifest <scratch>/subtask-ranges-manifest.json --review <scratch>/subtask-ranges-review.md`
   Each row is classified by the shared `serializeChecklistSchedule`, not by SQL, which cannot see DST
   resolution mismatches, non-calendar dates or cleared versioned rows. `review.md` lists only the rows to
   convert: street, title, old state and literal, old version, the Project inputs, the new range, the new
   version, and what happens to the due reminder.
5. **The owner reads `review.md` and approves it in chat.** Do not go further without that approval.
6. Generate the apply file from that approved manifest, **on the same Sydney day as step 4**:
   `npx --no-install tsx scripts/subtask-range-backfill.ts apply --manifest <scratch>/subtask-ranges-manifest.json --out <scratch>/subtask-ranges-apply.sql`
   `apply` recomputes every value from the manifest's stored snapshot with the shared functions, and
   refuses the whole file if any value disagrees with what the owner reviewed. It also refuses a
   manifest prepared on another Sydney day, because the reminder cut-off is that day. If it refuses,
   go back to step 3.
7. Rehearsal on production-shaped data is **not available as-is**. A `wrangler d1 export` file does not
   re-import into a fresh local D1: with wrangler 4.112, a local export failed with
   `no such table: main.user`, even with `PRAGMA foreign_keys=OFF` prepended. The export interleaves
   each table's rows with the alphabetical `CREATE TABLE`s, so a table's rows can arrive before the
   `user` table they reference. The generated SQL was rehearsed on a seeded, migrated local D1 for the
   #341 PR: applied twice, the second run changed nothing, and verify returned 0. If you want a rehearsal
   on the export, first prove that a converted export imports into
   `--local --persist-to <scratch>/rehearsal`. Do not rely on this step until then.
8. Apply:
   `npx wrangler d1 execute quincy-portal --remote --file <scratch>/subtask-ranges-apply.sql --config workers/app/wrangler.jsonc`
   If it is interrupted, re-run **the same file**. Never regenerate it mid-run.
9. Verify, and paste both outputs into the #341 PR:
   - `npx wrangler d1 execute quincy-portal --remote --json --config workers/app/wrangler.jsonc --command "$(grep -v '^--' scripts/subtask-range-backfill-verify.sql)"`
     must return `without_complete_range: 0`.
   - Repeat steps 3 and 4. `prepare` must report `converting 0`. The SQL check alone cannot catch a
     DST resolution mismatch; the shared serializer can.

   If either check reports rows, those Subtasks were edited after the dry run and skipped. Start a new
   cycle from step 3 for them, with a new review and approval.

## What the conversion does

- **Due-only** rows keep their due as the range's end, including its time and its DST fold. The start is
  the Project's shoot date, or its creation date (Sydney) when the shoot date is not a canonical date. A
  start after the due collapses to one day on the due.
- **Unscheduled, legacy-unresolved and invalid** rows take the Project default: shoot date (or creation
  date) to the Deadline, or one day when there is no Deadline. An unreadable old due is dropped, and
  `review.md` shows the dropped literal, so the owner can ask for a hand fix afterwards.
- The Deadline counts only while `deadline_at` is set (`effectiveDeadlineLocalCivil`, shared with the
  Worker). A leftover `deadline_local_civil` on a Project without a Deadline is ignored.
- Done Subtasks and Subtasks on archived Projects are converted too, because #343's constraint covers
  the whole table.

## Due reminders

The 08:00 scan emails every assigned, open Subtask on an active Project whose due date is today or
earlier and whose `due_reminder_sent_at` is NULL. Rows that gain their first readable end would
otherwise get a "due today" email for work that ended weeks ago. So, per row:

- **Due-only:** the Worker's rule. The end is unchanged, so `due_reminder_sent_at` is left alone
  (`unchanged`).
- **Other states, new end before the Sydney date of step 4:** `due_reminder_sent_at =
  COALESCE(due_reminder_sent_at, <apply time>)`, so no stale email fires (`suppressed`). An existing
  stamp is kept, because notification joins read it as a claim key.
- **Other states, new end on or after that date:** cleared to NULL, as the Worker does whenever an end
  changes, so the real reminder fires on the due date (`armed`).

## Safety properties

- Each UPDATE is guarded by the Subtask's id and Project, its full old schedule (every schedule column
  and `due_date`, compared with `IS`) and its old `schedule_version`, plus the Project inputs the range
  was computed from (shoot date, creation time, Deadline). A row or Project edited after the dry run is
  skipped rather than overwritten.
- Each audit INSERT has a fixed UUID baked into the file and is guarded by `NOT EXISTS` on that id. It
  is written only when the Subtask holds exactly its new schedule and version. This ties it to the
  winning UPDATE, as `changes() = 1` does in the Worker, but it also completes the audit when a run
  that stopped between an UPDATE and its INSERT is re-run.
- A second run matches nothing: every converted row has moved to its new version.
- Free text (titles, streets) never appears in `apply.sql`. Stored values outside a small safe alphabet
  are written as hex literals.
- `updated_at`, and any reminder stamp, are computed by D1 when the file runs, not when it was generated.

## Limits

- The range is a snapshot (ADR 0011): later changes to the shoot date or the Deadline do not move it.
- A converted row can be overdue on arrival. That is correct: its end is in the past.
- Rollback is the step 2 export. There is no down script.
