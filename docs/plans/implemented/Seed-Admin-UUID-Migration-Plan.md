# Seed Admin UUID Migration — Plan

**Status: built, tested, and fully reviewed; ready for the production rollout runbook below — not
yet applied to production.** Cleared the full `docs/Subagent-Orchestration.md` §2 policy 1
sequence: Terra draft → 2 Terra review rounds → Opus plan-tier review (spent 1 of its 2 Terra
reverts adding the **Failure and recovery** section, the drained-window procedure, and the exact
preflight/postflight SQL; made two direct operator-safety edits itself) → Terra build → fresh Terra
diff review (found and the builder fixed two gaps: a non-reproducible local-D1 verification, and an
incomplete reopen-durability check) → final focused Terra pass (approved) → Opus final-draft review
of the built diff. That last pass found one **Medium** issue in the runbook text (not the code):
the original "consequence" analysis claimed any racing write aborts the migration, but re-derived
live against the exact shipped `0022` file, the four `ON DELETE CASCADE` tables (`session`,
`account`, `project_members`, `notifications`) behave differently — a race there completes silently
via cascade-delete rather than aborting, undetectable by the original count-only postflight. The
rollout section below has been corrected accordingly and a window-scoped postflight probe added;
this was a documentation correction, not a code or SQL change — the migration file itself was
independently re-verified correct with no unsafe interleaving. No production database writes,
Worker deployment, or commit have been performed. The migration test, the local-D1 verification
script (`portal/packages/db/verify-0022-local-d1.sh`), and the full repo verify sequence all pass.

**User decision:** repair the inconsistent production identity rather than weakening input
validation. The existing strict UUID validation for project photographer/editor assignment remains
the contract.

## Current state — code inspection and drafting-time snapshot, 2026-07-29

The source-code statements in this section were re-inspected for this round. By contrast, the
production row, reference counts, and live FK-definition values below are **drafting-time snapshot
evidence**, not facts a plan review can certify indefinitely. The named operator preflight is the
authoritative, immediately-before-apply confirmation; it must re-run and record every such query
before this migration is used.

`projects.ts` validates both `photographerUserIds` and `editorUserIds` as
`z.array(z.string().uuid())` at
[`portal/workers/app/src/routes/projects.ts:21`](../../portal/workers/app/src/routes/projects.ts#L21).
The route passes accepted values directly to `insertProjectMembers()` for project creation at
[`projects.ts:147-163`](../../portal/workers/app/src/routes/projects.ts#L147-L163) and through
`syncMembers()` on PATCH at
[`projects.ts:211-265`](../../portal/workers/app/src/routes/projects.ts#L211-L265). There is no
validation bug to relax.

The shared schema deliberately makes IDs application-supplied text primary keys, not database-
generated values: `id()` is `text("id").primaryKey()` at
[`portal/packages/db/src/schema.ts:9`](../../portal/packages/db/src/schema.ts#L9). `user.email` is
unique at [`schema.ts:20-33`](../../portal/packages/db/src/schema.ts#L20-L33). The checked-in seed
is the source of the bad convention: it inserts literal `seed-admin` for the Quincy Admin at
[`portal/packages/db/seed/0001_seed.sql:10-23`](../../portal/packages/db/seed/0001_seed.sql#L10-L23).

### Drafting-time production snapshot — mandatory preflight re-confirmation

The drafting-time read-only `wrangler d1 execute quincy-portal --remote` snapshot against database
`1d36b42e-f1e6-4659-8c9e-70afe822b6fa` recorded one Quincy Admin row:

| `user.id` | email | role | active |
|---|---|---|---|
| `seed-admin` | `mjj2332@gmail.com` | `admin` | `1` |

That snapshot's UUID-shape query returned only that row as non-UUID. This supports the supplied
diagnosis, but the operator must re-confirm it rather than treating the draft as a live query result.

Every source-level `.references(() => user.id)` occurrence was re-derived from
[`schema.ts:45`](../../portal/packages/db/src/schema.ts#L45),
[`60`](../../portal/packages/db/src/schema.ts#L60),
[`161`](../../portal/packages/db/src/schema.ts#L161),
[`182`](../../portal/packages/db/src/schema.ts#L182),
[`240`](../../portal/packages/db/src/schema.ts#L240),
[`293`](../../portal/packages/db/src/schema.ts#L293),
[`396`](../../portal/packages/db/src/schema.ts#L396),
[`418`](../../portal/packages/db/src/schema.ts#L418),
[`673`](../../portal/packages/db/src/schema.ts#L673),
[`687`](../../portal/packages/db/src/schema.ts#L687),
[`704`](../../portal/packages/db/src/schema.ts#L704),
[`726`](../../portal/packages/db/src/schema.ts#L726),
[`829`](../../portal/packages/db/src/schema.ts#L829), and
[`843`](../../portal/packages/db/src/schema.ts#L843). The drafting snapshot recorded matching
`sqlite_master` definitions: all fourteen used `ON UPDATE NO ACTION`, and only the four shown below
as `cascade` had an explicit `ON DELETE CASCADE`. The operator must re-run the `sqlite_master`
inspection in preflight; the source schema alone is not proof of the deployed definitions.

| Table | column | `seed-admin` rows, drafting snapshot 2026-07-29 | delete action |
|---|---|---:|---|
| `session` | `user_id` | 12 | cascade |
| `account` | `user_id` | 1 | cascade |
| `projects` | `archived_by` | 0 | no action |
| `project_members` | `user_id` | 0 | cascade |
| `document_uploads` | `created_by` | 0 | no action |
| `upload_manifests` | `created_by` | 3 | no action |
| `selections` | `selected_by` | 32 | no action |
| `autohdr_handoffs` | `initiated_by` | 6 | no action |
| `asset_review_state` | `updated_by` | 11 | no action |
| `annotations` | `author_id` | 3 | no action |
| `notice_board_posts` | `author_id` | 1 | no action |
| `publishes` | `published_by` | 0 | no action |
| `audit_log` | `actor_id` | 799 | no action |
| `notifications` | `user_id` | 3 | cascade |

Treat these counts as expected snapshot values, not as a waiver of preflight. A changed value, an
additional FK, or a changed deployed delete action stops the rollout for a revised review. The
checked-in schema has no other references to `user.id`.

One short-lived non-D1 reference also exists. Starting a Dropbox OAuth connection stores the
current user ID as `SESSIONS` KV value `dropbox_oauth_state:<nonce>` with `expirationTtl: 600` at
[`portal/workers/app/src/routes/integrations.ts:49-61`](../../portal/workers/app/src/routes/integrations.ts#L49-L61).
The callback compares that value to the current session user ID, so an in-flight legacy value would
fail after this migration. The drafting-time KV check used exactly:

```sh
npx wrangler kv key list --namespace-id 1344f43c2da84b28bc8729ac15c36925 --remote --prefix dropbox_oauth_state:
```

and returned `[]`. The rollout must run that exact command and record its immediately-before-apply
output; it must not rely on this short-lived snapshot. Drafting-time searches recorded zero
`seed-admin` occurrences in `audit_log.meta_json`, `jobs.payload_json`,
`webhook_events.payload_json`, and `verification` values/identifiers. Re-run those production
searches in the same preflight window; no other persistent runtime user-ID carrier was found by the
source audit.

### Auth/session continuity is preservable

The application configures Better Auth with the Drizzle schema at
[`portal/workers/app/src/auth.ts:8-33`](../../portal/workers/app/src/auth.ts#L8-L33), and all
route authentication calls its `auth.api.getSession()` wrapper at
[`auth.ts:36-40`](../../portal/workers/app/src/auth.ts#L36-L40). In installed better-auth 1.6.23,
the session endpoint calls `findSession(sessionCookieToken)`
([`node_modules/better-auth/dist/api/routes/session.mjs:178-180`](../../portal/node_modules/better-auth/dist/api/routes/session.mjs#L178-L180));
that adapter finds `session` by **token** and joins its `user`
([`internal-adapter.mjs:246-260`](../../portal/node_modules/better-auth/dist/db/internal-adapter.mjs#L246-L260)).
The optional cookie-cache branch is only entered when `session.cookieCache.enabled` is true
([`session.mjs:85-86`](../../portal/node_modules/better-auth/dist/api/routes/session.mjs#L85-L86));
this app does not configure it.

Consequently, preserving each `session.token` and repointing its `session.user_id` preserves an
already-issued session. Its next lookup returns the new UUID as both `session.userId` and
`user.id`; the signed cookie itself does not contain the user ID. Repointing the single `account`
row likewise preserves the pre-provisioned Google identity link.

### Staging and migration state

All three checked-in Workers bind exactly the same production D1 ID:
[`app/wrangler.jsonc:15-17`](../../portal/workers/app/wrang.jsonc#L15-L17),
[`background/wrangler.jsonc:18-20`](../../portal/workers/background/wrang.jsonc#L18-L20), and
[`webhook-ingress/wrangler.jsonc:9-11`](../../portal/workers/webhook-ingress/wrang.jsonc#L9-L11).
There is no `[env.staging]`/`env.staging` override in any Worker config. A read-only
`wrangler d1 list` for the account returned only this one `quincy-portal` D1 database. Therefore
the staging hostname cannot have a separate D1 database in this account/configuration; it shares
this database. **Apply this data operation once, to `quincy-portal` remote; do not run a second
staging operation.**

The drafting-time migration-list snapshot ended at `0021`, which agrees with
[`AGENTS.md:79-80`](../../AGENTS.md#L79-L80), so `0022` is the planned next number. The operator
must confirm that ledger immediately before apply. The older migration summary in
[`docs/todo.md:35-49`](../todo.md#L35-L49) only discusses `0020` and is stale as a full migration
ledger; it must not determine numbering.

## Design

### Target ID and permanent seed correction

Use the UUID v4 generated for this operation:

```text
6b851dc8-14cf-4f90-bd29-ce6c27f86385
```

It is intentionally a fixed, recorded server-owned identifier, rather than generating a value at
deploy time. Reusing it in the seed and migration makes every environment and every audit query
unambiguous. The implementation changes `0001_seed.sql` to use this UUID in place of
`seed-admin`; it keeps `INSERT OR IGNORE` and the unique real email. Thus a fresh database is born
consistent, and re-running the seed after the production migration no-ops on the real email rather
than recreating an admin.

This is in scope, not cosmetic: leaving the seed literal would reproduce the same invalid data in
the next fresh environment. It is safe for the migrated environment because the migrated UUID row
retains `mjj2332@gmail.com`, so the seed's unique-email conflict remains a no-op.

### Ship a numbered custom migration

Ship `portal/packages/db/migrations/0022_seed_admin_uuid.sql`, created with the repository's
Drizzle custom-migration flow (from `portal/packages/db`,
`npx drizzle-kit generate --custom --name seed_admin_uuid`) so it creates the numbered SQL file
and `_journal.json` entry. Replace the generated empty SQL with the reviewed data statements below.
Do **not** hand-add a bare `.sql` file without the journal entry: the next generated migration
could otherwise reuse `0022`. Do **not** add or require a schema snapshot change: `schema.ts` is
unchanged, and the existing data-only custom migrations `0009` and `0010` have journal entries but
no matching snapshot files.

This belongs in `d1_migrations`, despite being data-only, because it is a one-time, production
integrity repair whose exact versioned SQL, failure rollback, and applied-state ledger matter more
than avoiding a no-schema migration. Cloudflare's migration system records each applied file, and
its current documentation says a failed migration rolls back rather than marking the file applied.
No schema or Drizzle table definition changes.

Do not add `BEGIN`, `COMMIT`, `PRAGMA foreign_keys=OFF`, or `PRAGMA defer_foreign_keys` to this
file. D1 migration/import execution owns the transaction boundary; the documented nested-
transaction error is a reason not to issue `BEGIN` manually. More importantly, every statement
below is individually FK-valid under the expected deployed `ON UPDATE NO ACTION` constraints, to
be confirmed in preflight, so the repair does not rely on a connection-scoped PRAGMA persisting —
the exact failure mode documented at
[`docs/lessons.md:3-26`](../lessons.md#L3-L26).

### Exact migration SQL and order

Let these constants be literal values in `0022_seed_admin_uuid.sql`:

```text
OLD_ID       = seed-admin
NEW_ID       = 6b851dc8-14cf-4f90-bd29-ce6c27f86385
REAL_EMAIL   = mjj2332@gmail.com
PARKED_EMAIL = seed-admin-legacy-6b851dc8@invalid
```

The first statement clones every persisted user attribute, except that it uses the parked unique
email. It must be exactly an `INSERT ... SELECT`, not a new default-profile row:

```sql
INSERT INTO user (id, name, email, email_verified, image, role, active, created_at, updated_at)
SELECT '6b851dc8-14cf-4f90-bd29-ce6c27f86385', name,
       'seed-admin-legacy-6b851dc8@invalid', email_verified, image, role, active,
       created_at, updated_at
FROM user
WHERE id = 'seed-admin';
```

Then run these fourteen statements in this order. The order is intentionally explicit even for
the four currently zero-row tables, so the migration remains correct if a local fixture or a later
environment has data there:

```sql
UPDATE session            SET user_id      = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id      = 'seed-admin';
UPDATE account            SET user_id      = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id      = 'seed-admin';
UPDATE projects           SET archived_by  = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE archived_by  = 'seed-admin';
UPDATE project_members    SET user_id      = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id      = 'seed-admin';
UPDATE document_uploads   SET created_by   = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE created_by   = 'seed-admin';
UPDATE upload_manifests   SET created_by   = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE created_by   = 'seed-admin';
UPDATE selections         SET selected_by  = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE selected_by  = 'seed-admin';
UPDATE autohdr_handoffs   SET initiated_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE initiated_by = 'seed-admin';
UPDATE asset_review_state SET updated_by    = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE updated_by    = 'seed-admin';
UPDATE annotations        SET author_id    = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE author_id    = 'seed-admin';
UPDATE notice_board_posts SET author_id    = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE author_id    = 'seed-admin';
UPDATE publishes          SET published_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE published_by = 'seed-admin';
UPDATE audit_log          SET actor_id     = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE actor_id     = 'seed-admin';
UPDATE notifications      SET user_id      = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id      = 'seed-admin';
```

Finally remove the now-unreferenced legacy parent, then give the replacement the real email:

```sql
DELETE FROM user WHERE id = 'seed-admin';

UPDATE user
SET email = 'mjj2332@gmail.com'
WHERE id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385';
```

This sequencing is safe under immediate FK enforcement: the UUID parent exists before any child
points at it; the old parent remains until every reference has moved; and deleting it frees the
unique real email for the replacement. The parked email is solely the collision-avoidance value for
the clone `INSERT`; the old row is never updated to it. It never issues the impossible parent-first
`UPDATE user SET id = ...`, and it never points a child to a non-existent parent. The usual
migration transaction additionally makes the whole sequence atomic/rolled back on an error, but
correctness does not depend on toggling foreign keys.

Before applying, the operator must run and record these exact **read-only** preflight commands
from `portal/workers/app`. The first result must be exactly one active `admin` row at `seed-admin`
with the real email; the second must be empty; the third must match the fourteen counts and table
definitions documented above; and the fourth must end at `0021`.

```sh
npx wrangler d1 execute quincy-portal --remote --command "SELECT id, email, role, active FROM user WHERE id = 'seed-admin' OR email = 'mjj2332@gmail.com' ORDER BY id;"

npx wrangler d1 execute quincy-portal --remote --command "SELECT id, email, role, active FROM user WHERE id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' OR email = 'seed-admin-legacy-6b851dc8@invalid' ORDER BY id;"

npx wrangler d1 execute quincy-portal --remote --command "SELECT 'session.user_id' AS ref, COUNT(*) AS old_id_count FROM session WHERE user_id = 'seed-admin'; SELECT 'account.user_id', COUNT(*) FROM account WHERE user_id = 'seed-admin'; SELECT 'projects.archived_by', COUNT(*) FROM projects WHERE archived_by = 'seed-admin'; SELECT 'project_members.user_id', COUNT(*) FROM project_members WHERE user_id = 'seed-admin'; SELECT 'document_uploads.created_by', COUNT(*) FROM document_uploads WHERE created_by = 'seed-admin'; SELECT 'upload_manifests.created_by', COUNT(*) FROM upload_manifests WHERE created_by = 'seed-admin'; SELECT 'selections.selected_by', COUNT(*) FROM selections WHERE selected_by = 'seed-admin'; SELECT 'autohdr_handoffs.initiated_by', COUNT(*) FROM autohdr_handoffs WHERE initiated_by = 'seed-admin'; SELECT 'asset_review_state.updated_by', COUNT(*) FROM asset_review_state WHERE updated_by = 'seed-admin'; SELECT 'annotations.author_id', COUNT(*) FROM annotations WHERE author_id = 'seed-admin'; SELECT 'notice_board_posts.author_id', COUNT(*) FROM notice_board_posts WHERE author_id = 'seed-admin'; SELECT 'publishes.published_by', COUNT(*) FROM publishes WHERE published_by = 'seed-admin'; SELECT 'audit_log.actor_id', COUNT(*) FROM audit_log WHERE actor_id = 'seed-admin'; SELECT 'notifications.user_id', COUNT(*) FROM notifications WHERE user_id = 'seed-admin'; SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'account', 'projects', 'project_members', 'document_uploads', 'upload_manifests', 'selections', 'autohdr_handoffs', 'asset_review_state', 'annotations', 'notice_board_posts', 'publishes', 'audit_log', 'notifications') ORDER BY name;"

npx wrangler d1 execute quincy-portal --remote --command "SELECT * FROM d1_migrations ORDER BY id DESC LIMIT 5;"
```

If any assertion differs, stop rather than adapting the SQL interactively. The migration has no
runtime parameter binding, and a changed production shape deserves a revised reviewed plan.

### Test-fixture updates

The repository-wide literal search confirms there is no production application hardcode outside
the seed. The three test files do rely on the seeded literal:

- `portal/workers/app/test/api.test.ts` uses it for the seeded admin session, fixtures and the
  Better Auth pre-provisioned-user assertions at `:139`, `:171`, `:929-934`, and other direct FK
  fixture inserts.
- `portal/workers/app/test/asset-deletion.test.ts` uses it for the admin session and annotation/
  selection fixtures at `:66`, `:76-77`.
- `portal/workers/app/test/integrations.test.ts` uses it for the admin session and the expected
  KV OAuth-state value at `:35`, `:51`.

Those assertions must change to a named `seedAdminId` constant equal to `NEW_ID`, not merely be
deleted. The OAuth test should positively assert that Better Auth links the existing UUID-keyed
admin and creates its account/session with that UUID. Test-created non-UUID identities such as
`test-photographer` are unrelated isolated fixtures and are not part of this production data
repair; do not expand scope into a wholesale fixture-ID rewrite.

## What is explicitly not changing

- The strict `.uuid()` validation at `projects.ts:21`, or any other API input contract.
- Project-picker behavior, membership behavior, assignment notifications, or any code from the
  shipped `bc3c18f` assignment-alert work.
- User role, active state, name, image, timestamps, Google account identity/token fields, session
  token, notification content/status, project membership role, or media/R2 data. In `audit_log`,
  the `action`, target fields, `meta_json`, and timestamp are unchanged; only the `actor_id`
  foreign key is rekeyed from `seed-admin` to `NEW_ID`, as for every other child FK.
- Any schema column, FK definition, or `schema.ts` model. This is a data repair plus the future
  seed/test convention.
- A separate staging migration, Worker configuration change, or mutation/termination of an
  existing Workflow instance. The rollout gate below prevents an old frozen Workflow input from
  surviving the parent-row deletion.

## Verification requirements before production

The builder must prove the actual generated `0022` SQL, rather than a hand-transcribed equivalent,
on both SQLite and D1-shaped local execution. The round-2 disposable SQLite proof above validates
the corrected order only; it is not a substitute for these exact-file tests.

1. Add a focused `packages/db` migration test adjacent to
   [`portal/packages/db/test/migration-0020.test.ts`](../../portal/packages/db/test/migration-0020.test.ts).
   Apply only migrations `0000`–`0021` to a fresh database with `PRAGMA foreign_keys = ON`, insert
   a legacy Quincy Admin plus at least one valid row in **each** of the fourteen child tables, then
   apply the exact generated `0022` file. This must include valid dependency chains for assets,
   projects, collections, jobs, connections, etc.; no FK disabling and no mocked SQL.
2. Assert after that exact migration: one user exists at `NEW_ID` with the original profile values
   and real email; no `seed-admin` user/reference remains; every old count has moved unchanged to
   `NEW_ID`; `account` identity fields and all `session.token` values are byte-for-byte unchanged;
   `PRAGMA foreign_key_check` returns no rows; and the former values remain valid after reopening
   the database. Deliberately include nonzero rows in the currently-zero production tables so all
   fourteen SQL statements are exercised.
3. Run the same legacy fixture and exact SQL using a fresh persistent **local D1** via
   an isolated `--persist-to` directory: load the concatenated `0000`–`0021` SQL with
   `wrangler d1 execute --local --file`, load the representative legacy fixture, then apply the
   **exact** `0022_seed_admin_uuid.sql` using a second `wrangler d1 execute --local --file` call.
   Run the same assertions through `wrangler d1 execute --local`; separately run standard
   `wrangler d1 migrations apply ... --local` against a clean persistence directory to verify the
   generated custom migration is discovered and ledgered. This avoids the invalid test order of
   applying `0022` before the legacy rows exist, while still exercising D1 statement parsing and
   FK behavior. Preserve the command output as the change's verification artifact. Do not treat
   Miniflare/local success as proof of remote behavior; that limitation is the documented 0020
   lesson. In this same local-D1 run, explicitly confirm that `PRAGMA foreign_key_check` and
   `PRAGMA quick_check` execute successfully through `wrangler d1 execute` — rather than erroring as
   unsupported PRAGMAs — instead of assuming they behave as they do in bare SQLite. Expect
   `foreign_key_check` to return no rows on a clean database and `quick_check` to return `ok`; the
   point is to prove the statements run at all. Both the postflight acceptance assertions and the
   **Failure and recovery** detection commands depend on them, so an unsupported PRAGMA must be
   discovered here and replaced with an equivalent explicit orphan-detection query *before*
   rollout, not mid-window.
4. Extend the real Miniflare app suite with two request-level cases using the migrated UUID seed:
   an existing signed admin session still returns 200 from `/api/session` and shows `NEW_ID`; and
   an admin POST/PATCH can put `NEW_ID` into both `photographerUserIds` and `editorUserIds`, receiving
   successful membership rows instead of the former 400 `Invalid input`. Use distinct projects or
   roles as needed to respect the unique `(project_id, user_id, role_on_project)` key.
5. Run the standing full verification from `portal/`: `npm run typecheck`,
   `npm run build -w @quincy/web`, `npm run test --workspaces`, and
   `npx vitest run --config packages/shared/vitest.config.ts`.

## Production rollout and acceptance

### AutoHDR frozen-input safety gate

`AutoHdrSend` persists `initiatedBy` in its Workflow event input
([`autohdr.ts:18-26`](../../portal/workers/background/src/workflows/autohdr.ts#L18-L26)); the
handoff creator passes the database value when it creates the instance
([`index.ts:162-173`](../../portal/workers/background/src/index.ts#L162-L173)). On a retry,
`confirmAutoHdrHandoff()` can use that frozen value in a new `audit_log.actor_id` insert
([`claims.ts:115-125`](../../portal/workers/background/src/autohdr/claims.ts#L115-L125)). The
Workflow marks its job `failed` and then rethrows
([`autohdr.ts:397-399`](../../portal/workers/background/src/workflows/autohdr.ts#L397-L399)), so a
terminal-looking D1 job status is not evidence that the Workflow cannot retry.

Immediately before the migration, query and record every explicit AutoHDR handoff with the old
frozen initiator, including its paired job and exact Workflow instance ID:

```sql
SELECT h.id AS handoff_id, h.job_id, h.workflow_id, h.state AS handoff_state,
       j.status AS job_status, j.error AS job_error
FROM autohdr_handoffs AS h
JOIN jobs AS j ON j.id = h.job_id
WHERE h.initiated_by = 'seed-admin'
ORDER BY h.created_at, h.id;
```

For those exact `workflow_id` values, record the complete output of both remote commands (paginate
until all queued/running instances have been considered) and intersect the returned IDs with the
query result:

```sh
npx wrangler workflows instances list quincy-autohdr-roundtrip --status queued
npx wrangler workflows instances list quincy-autohdr-roundtrip --status running
```

Also run and record `npx wrangler workflows instances describe quincy-autohdr-roundtrip
<workflow-id>` for every matched or otherwise ambiguous ID. The migration may proceed only if none
of the old-initiator IDs is queued or running. If any is alive, do not apply: wait for its natural
termination and repeat the D1 query and Workflow checks. A termination is an operational action,
not an implied part of this migration; it requires explicit approval, an identified instance, and a
recorded outcome (for example, the approved operator may run `npx wrangler workflows instances
terminate quincy-autohdr-roundtrip <workflow-id>`, then re-run the checks). Do not substitute a
`jobs.status = 'failed'` result for this gate.

1. **Drain, rather than merely announce, the maintenance window.** `requireSession` resolves the
   session and stores `user.id` in request context at the beginning of the request
   ([`session.ts:6-13`](../../portal/workers/app/src/middleware/session.ts#L6-L13)); handlers can
   write that captured ID later, for example `audit()` inserts it as `audit_log.actor_id`
   ([`audit.ts:5-17`](../../portal/workers/app/src/lib/audit.ts#L5-L17)). Close every browser tab
   and authenticated client for the Quincy Admin, ask staff to stop app activity, and then wait a
   full **60 seconds** before the preflight. This is deliberately two 30-second windows: the paid
   app Worker has no `limits.cpu_ms` override, so its default CPU ceiling is 30 seconds, and
   `waitUntil()` can keep work alive for up to 30 seconds after an HTTP response/client disconnect.
   Cloudflare has no hard wall-clock limit for a still-connected HTTP request, so this is a bounded
   drain only after the operator has actually closed the clients; it is not a magic fence against a
   deliberately held connection. The app's only current `waitUntil()` starts a background Tonomo
   drain, not an app-context child-FK write. Run the preflight immediately after the 60 seconds and
   apply immediately after a clean preflight; do not resume staff work until postflight completes.

   **The consequence of a racing write is bimodal, and differs by table** — verified directly by
   racing writes against the exact implemented `0022` file, not assumed. Live `PRAGMA
   foreign_key_list` confirms only `session`, `account`, `project_members`, and `notifications`
   carry `ON DELETE CASCADE`; the other ten child tables are `NO ACTION`.

   - **`NO ACTION` tables** (`projects`, `document_uploads`, `upload_manifests`, `selections`,
     `autohdr_handoffs`, `asset_review_state`, `annotations`, `notice_board_posts`, `publishes`,
     `audit_log`): a write carrying `OLD_ID` that lands after that table's rekey `UPDATE` but before
     `DELETE FROM user WHERE id = 'seed-admin'` recreates an old-parent reference, so the `DELETE`
     itself fails its FK check and the whole migration aborts — confirmed directly. This is
     recoverable and is handled by **Failure and recovery** below.
   - **`CASCADE` tables** (`session`, `account`, `project_members`, `notifications`): the same race
     does **not** abort anything. The child insert succeeds normally; then `DELETE FROM user WHERE
     id = 'seed-admin'` cascades and silently deletes that just-inserted child row along with the
     old parent — confirmed directly by racing inserts against the real file. The migration
     completes cleanly, `PRAGMA foreign_key_check` stays empty, and the standard postflight count
     comparison cannot see it: a row that was inserted then cascade-deleted nets to the same
     preflight-equals-postflight count as no race at all. This is a **silent-loss** risk, not an
     abort, for exactly the two writer paths below that hit `notifications`/`project_members`. A
     race on `session`/`account` is harmless (a mid-window admin login simply needs to re-login).

   The actual writers are broader than the admin's own activity:

   - Only the Quincy Admin's sessions carry `OLD_ID` in their own request context, so exactly one
     human identity can make a session-derived old-ID write (a `session`/`account` race — harmless
     per above).
   - A different staff member can nevertheless cross the boundary through `notifyProject()` or
     `notifyProjectAssignments()`: each reads recipient user IDs from D1, then inserts
     `notifications.user_id` ([`notifications.ts:12-75`](../../portal/workers/app/src/lib/notifications.ts#L12-L75)).
     `notifications` is a **CASCADE** table: a race here does not abort — it silently and
     irrecoverably drops the notification row, with no error and no postflight signal.
   - An inbound Tonomo webhook is outside any staff quiet window. `assignPhotographers()` reads
     active users by lowercased email and inserts `project_members.user_id`
     ([`process.ts:133-151`](../../portal/workers/background/src/tonomo/process.ts#L133-L151)).
     `project_members` is also **CASCADE**: a racing insert succeeds, then is silently cascade-
     deleted by the migration — the queue consumer will **not** retry, since its insert did not
     error. A photographer/editor assignment from an in-flight Tonomo order could vanish without
     any visible failure. Treat this, not an abort, as the operative risk from this specific writer.
   - The hourly cron's `audit_log` write is **not** an old-ID risk: its automatic stage audit uses
     `actor_id = NULL` ([`reconcile-awaiting-raw.ts:55-68`](../../portal/workers/background/src/reconcile-awaiting-raw.ts#L55-L68)).
     However, the cron itself is not wholly irrelevant: `scheduled()` also calls notification
     fan-out ([`background/index.ts:49-57`](../../portal/workers/background/src/index.ts#L49-L57)),
     and notification recipients include every active admin
     ([`db/notifications.ts:46-72`](../../portal/packages/db/src/notifications.ts#L46-L72)). It can
     therefore create an old-ID `notifications.user_id` row if it already read recipients before
     the rekey — the same CASCADE silent-loss as above, on the same table. Avoid starting the
     window near the hourly trigger; a WAF cordon does not stop this background writer.

   Because a `notifications`/`project_members` race is silent rather than abort-and-recover, the
   postflight in step 4 below adds a window-scoped probe on `created_at` for exactly these two
   tables — a normal count comparison cannot catch a row that both appeared and vanished within
   the window.

   The default is this documented 60-second drain plus the recovery runbook; its worst case for the
   ten `NO ACTION` tables is an aborted, recoverable migration, and for the four `CASCADE` tables
   (bounded to `session`/`account` harmlessness plus a low-probability, silent
   `notifications`/`project_members` drop within a 60-second window) is not an orphan and not
   migration failure, but is not detectable by the count-based postflight alone — hence the added
   window-scoped probe. Choose one of the following escalations only if the operator needs a
   stronger cordon:

   - **Option A — edge cordon (optional):** before the drain, add a zone-level Cloudflare WAF
     custom rule which blocks `/api/*` except the operator's fixed public IP; remove it after
     postflight. Cloudflare documents zone-level custom rules on Free, Pro, Business, and Enterprise
     plans, but this plan did not inspect the account: the operator must confirm the zone has an
     available custom-rule slot and that their dashboard role can create it before relying on this
     option. It is edge configuration, not a Worker deployment, and it still does not fence the
     external Tonomo/cron background paths.
   - **Option B — data cordon (optional):** before the drain, run `UPDATE user SET active = 0
     WHERE id = 'seed-admin';` through the normal remote D1 operator procedure. `requireSession`
     then fences new requests from the only identity with a session-derived `OLD_ID`; it does not
     drain already admitted requests, so the 60-second wait remains mandatory. The reviewed clone
     intentionally copies `active` from the old row, so immediately after the drain and immediately
     before the read-only preflight/apply, restore it with `UPDATE user SET active = 1 WHERE id =
     'seed-admin';`. Do not change the reviewed clone to hardcode `1`. This leaves a short reopened
     interval, which is why Option B is an additional drain aid rather than a complete cordon; the
     operator must keep all admin clients closed. The existing profile-preservation assertion stays
     correct because the final value is restored to its recorded `1` before cloning. **If the
     rollout is abandoned at any point after `active = 0` is set, restoring `active = 1` is
     mandatory before standing down** — an aborted Option B otherwise leaves the studio admin
     locked out of the live app. It is recoverable through the same remote D1 path that set the
     flag, but nothing in the UI explains a disabled admin, so an unrestored `active = 0` reads as
     a total production auth outage until someone remembers this step.
   - **Option C — rejected:** do not deploy a temporary maintenance-gate Worker. That is a larger,
     riskier production change than this data repair for a failure mode bounded by FK enforcement,
     postflight integrity checks, and state-specific recovery.

   Run and record the exact KV command from the drafting-time snapshot section immediately before
   applying; it must return `[]`. If it does not, let the fixed 600-second TTL elapse (or let the
   user complete/cancel the OAuth flow), then repeat the command. Do not rewrite KV values
   independently: D1 and KV have no shared atomic transaction. Complete the AutoHDR frozen-input
   safety gate above in this same drained window.
2. From `portal/workers/app`, record the exact read-only preflight commands above, including the
   fourteen counts, deployed FK/delete-action definitions, target-ID collision check, user profile,
   migration ledger, current session token count, and the AutoHDR/Workflow evidence. Confirm the
   working tree contains the reviewed custom migration SQL, `_journal.json` entry, seed, and tests;
   no schema snapshot change is expected.
3. Apply only the versioned migration to the one remote database with
   `npx wrangler d1 migrations apply quincy-portal --remote`. Do not use an ad hoc sequence of
   pasted updates, and do not rerun the seed against production as part of the repair.
4. Immediately run and record these exact **read-only** postflight commands. Require one UUID row
   with the real email and no old user; every old count is zero and every new count equals the
   corresponding preflight old count; `foreign_key_check` is empty; `quick_check` is `ok`; and the
   ledger includes `0022_seed_admin_uuid.sql`.

   ```sh
   npx wrangler d1 execute quincy-portal --remote --command "SELECT id, email, role, active FROM user WHERE id IN ('seed-admin', '6b851dc8-14cf-4f90-bd29-ce6c27f86385') OR email IN ('mjj2332@gmail.com', 'seed-admin-legacy-6b851dc8@invalid') ORDER BY id;"

   npx wrangler d1 execute quincy-portal --remote --command "SELECT 'session.user_id' AS ref, COUNT(CASE WHEN user_id = 'seed-admin' THEN 1 END) AS old_id_count, COUNT(CASE WHEN user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) AS new_id_count FROM session; SELECT 'account.user_id', COUNT(CASE WHEN user_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM account; SELECT 'projects.archived_by', COUNT(CASE WHEN archived_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN archived_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM projects; SELECT 'project_members.user_id', COUNT(CASE WHEN user_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM project_members; SELECT 'document_uploads.created_by', COUNT(CASE WHEN created_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN created_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM document_uploads; SELECT 'upload_manifests.created_by', COUNT(CASE WHEN created_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN created_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM upload_manifests; SELECT 'selections.selected_by', COUNT(CASE WHEN selected_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN selected_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM selections; SELECT 'autohdr_handoffs.initiated_by', COUNT(CASE WHEN initiated_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN initiated_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM autohdr_handoffs; SELECT 'asset_review_state.updated_by', COUNT(CASE WHEN updated_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN updated_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM asset_review_state; SELECT 'annotations.author_id', COUNT(CASE WHEN author_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN author_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM annotations; SELECT 'notice_board_posts.author_id', COUNT(CASE WHEN author_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN author_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM notice_board_posts; SELECT 'publishes.published_by', COUNT(CASE WHEN published_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN published_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM publishes; SELECT 'audit_log.actor_id', COUNT(CASE WHEN actor_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN actor_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM audit_log; SELECT 'notifications.user_id', COUNT(CASE WHEN user_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM notifications;"

   npx wrangler d1 execute quincy-portal --remote --command "PRAGMA foreign_key_check; PRAGMA quick_check;"

   npx wrangler d1 execute quincy-portal --remote --command "SELECT * FROM d1_migrations ORDER BY id DESC LIMIT 5;"
   ```

   Because a race on `notifications`/`project_members` (both `CASCADE`) is silently swallowed
   rather than aborted — see the corrected consequence analysis above — the standard count
   comparison cannot detect it. Also run and record this window-scoped probe, using the wall-clock
   timestamp (ms) at which the drain began as `<window_start_ms>`:

   ```sh
   npx wrangler d1 execute quincy-portal --remote --command "SELECT 'notifications' AS t, COUNT(*) AS rows_in_window FROM notifications WHERE created_at >= <window_start_ms>; SELECT 'project_members', COUNT(*) FROM project_members WHERE created_at >= <window_start_ms>;"
   ```

   Both must be explainable by ordinary post-migration activity (for example, this migration's own
   admin-assignment test in step 6 below) — an unexplained nonzero row here is the signature of a
   silently cascade-dropped write; treat it as a real incident (a lost notification, or a lost
   Tonomo photographer/editor assignment) to investigate and manually repair, not as a reason to
   distrust or rerun the migration itself, which the detection commands above already prove
   completed correctly. Separately, note that a **higher** postflight count than the recorded
   preflight count for any table is the *benign* direction — an ordinary write that legitimately
   landed before that table's rekey — and is not itself a stop-the-rollout signal; only a
   `foreign_key_check` failure, a wrong final email/role/active value, or an unexplained
   window-probe row indicate a real problem.

   Record that the immediately-before-apply AutoHDR gate found no queued/running old-initiator
   instance; do not treat job status alone as acceptance evidence.
5. In a browser that held a session before the operation, load `/api/session` and then an ordinary
   authenticated page/API request. It must remain authenticated as Quincy Admin and now expose
   `NEW_ID`. If this fails despite the DB assertions, stop further changes, preserve the browser/
   request evidence, and use a normal Google re-login only as a contingency—not an accepted silent
   side effect.
6. As Quincy Admin, create or PATCH a harmless controlled project with `NEW_ID` in photographer
   and editor arrays, then confirm both API responses are successful and the corresponding
   `project_members` rows exist. Clean up the controlled project through the normal, approved
   workflow if it is not wanted operationally.

No Worker redeploy is required for the production ID repair itself: the deployed validator already
accepts UUIDs, and the live Worker reads the updated D1 data. This remains true for every
recommended cordon: Option A changes only edge WAF configuration and Option B changes only D1
data. The seed/test source changes are for future environments and CI; they do not require a
production Worker deployment to make this repair effective. A later normal code deployment may
carry them, but it is not a rollout prerequisite. The standard background → webhook-ingress → app
deploy order therefore does not apply to this standalone D1 migration.

## Failure and recovery

**After any failed, timed-out, or otherwise ambiguous apply, do not run `npx wrangler d1
migrations apply quincy-portal --remote` again until the detection commands below have been run and
recorded.** The 0020 production lesson is explicit: even though D1 reports that a failed migration
rolls back and does not mark the file applied, always first confirm that production was left clean;
do not assume it ([`docs/lessons.md:3-26`](../lessons.md#L3-L26)). This is especially important
here: the clone is a bare primary-key `INSERT`, and rerunning it after a clone was retained fails;
after the old row was removed, its real-email tail can instead fail the unique-email constraint.
Rerunning blindly can therefore fail differently and obscure the recoverable state.

### Detect first; classify second

Run all of these **read-only** commands from `portal/workers/app`. They are deliberately the same
user, reference, integrity, and ledger facts used in postflight, but the reference query reports
both IDs so it also identifies a partial rekey.

```sh
npx wrangler d1 execute quincy-portal --remote --command "SELECT id, email, role, active FROM user WHERE id IN ('seed-admin', '6b851dc8-14cf-4f90-bd29-ce6c27f86385') OR email IN ('mjj2332@gmail.com', 'seed-admin-legacy-6b851dc8@invalid') ORDER BY id;"

npx wrangler d1 execute quincy-portal --remote --command "SELECT 'session.user_id' AS ref, COUNT(CASE WHEN user_id = 'seed-admin' THEN 1 END) AS old_id_count, COUNT(CASE WHEN user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) AS new_id_count FROM session; SELECT 'account.user_id', COUNT(CASE WHEN user_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM account; SELECT 'projects.archived_by', COUNT(CASE WHEN archived_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN archived_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM projects; SELECT 'project_members.user_id', COUNT(CASE WHEN user_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM project_members; SELECT 'document_uploads.created_by', COUNT(CASE WHEN created_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN created_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM document_uploads; SELECT 'upload_manifests.created_by', COUNT(CASE WHEN created_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN created_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM upload_manifests; SELECT 'selections.selected_by', COUNT(CASE WHEN selected_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN selected_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM selections; SELECT 'autohdr_handoffs.initiated_by', COUNT(CASE WHEN initiated_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN initiated_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM autohdr_handoffs; SELECT 'asset_review_state.updated_by', COUNT(CASE WHEN updated_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN updated_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM asset_review_state; SELECT 'annotations.author_id', COUNT(CASE WHEN author_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN author_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM annotations; SELECT 'notice_board_posts.author_id', COUNT(CASE WHEN author_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN author_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM notice_board_posts; SELECT 'publishes.published_by', COUNT(CASE WHEN published_by = 'seed-admin' THEN 1 END), COUNT(CASE WHEN published_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM publishes; SELECT 'audit_log.actor_id', COUNT(CASE WHEN actor_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN actor_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM audit_log; SELECT 'notifications.user_id', COUNT(CASE WHEN user_id = 'seed-admin' THEN 1 END), COUNT(CASE WHEN user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' THEN 1 END) FROM notifications;"

npx wrangler d1 execute quincy-portal --remote --command "PRAGMA foreign_key_check; PRAGMA quick_check;"

npx wrangler d1 execute quincy-portal --remote --command "SELECT * FROM d1_migrations ORDER BY id DESC LIMIT 5;"
```

These queries distinguish the following states. D1's documented migration execution is expected
to make the file and its `d1_migrations` entry atomic, so a clean failed D1 apply should yield S0;
S1–S4 are not expected from that ideal single transaction. They remain operationally relevant
states after an interrupted/ambiguous executor, an implementation divergence, or an operator's
past manual action. The 0020 lesson means this plan treats that expectation as a hypothesis to
test, not as sufficient assurance: run detection in every case.

| State | Detection result | Reachability and disposition |
|---|---|---|
| S0 — fully rolled back | Neither `NEW_ID` nor any new-ID child reference exists; old user has the real email; all references remain old; ledger ends at `0021`. | Expected clean failed-migration outcome under D1 transaction semantics. |
| S1 — clone only | Both users exist: old has `REAL_EMAIL`, new has `PARKED_EMAIL`; every child new-ID count is zero and every child remains old; ledger ends at `0021`. | Not expected from an atomic D1 migration, but recoverable if an executor stopped after the clone. |
| S2 — partial rekey | Both users exist with those same emails; one or more, but not all, child references moved to `NEW_ID`; ledger ends at `0021`. | Not expected atomically. It includes the race where a new old-ID child write causes the final delete to fail. |
| S3 — delete complete, email tail missing | Old user and all old references are absent; all expected references are at `NEW_ID`; new user still has `PARKED_EMAIL`; ledger normally still ends at `0021`. | Not expected atomically, but treat it as an urgent forward-only repair if detected. |
| S4 — data/ledger divergence | Postflight data is fully correct (new user has `REAL_EMAIL`, all old counts are zero, integrity checks pass), but the ledger does not list `0022_seed_admin_uuid.sql`. | Not expected because the ledger belongs to migration application, but it is explicitly detectable and reconciled below rather than retried. |

S3 is deceptively user-visible but quiet. The rekeyed `account` row still lets the admin sign in:
Better Auth finds the account by provider/subject and session token, rather than requiring the user
email. Yet `assignPhotographers()` compares incoming Tonomo photographer emails with lowercased
emails of active users; while the UUID user has `seed-admin-legacy-6b851dc8@invalid`, an order for
`mjj2332@gmail.com` silently returns `No active user matches photographers` instead of assigning
the admin. Notification delivery also uses the active user's current email and would go to the
`@invalid` address. The postflight user-email assertion is therefore mandatory even if sign-in
works.

### State-specific action

Do not improvise a hybrid fix. If the output does not exactly match one state, if either integrity
check fails, or if a new-ID count cannot be reconciled to the recorded preflight count, stop,
preserve the outputs, and obtain a revised recovery review.

- **S0 — start over only after a fresh drain and full preflight.** No recovery SQL is needed. The
  first apply did not alter data or the ledger; repeat the complete rollout from step 1, then use
  the single versioned `migrations apply` command once.
- **S1 — revert the harmless clone, then start over.** Only after the reference query proves zero
  `NEW_ID` children and the old row is intact, run exactly:

  ```sh
  npx wrangler d1 execute quincy-portal --remote --command "DELETE FROM user WHERE id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385';"
  ```

  Re-run the detection commands and require S0, then repeat the full drain/preflight/apply. Do not
  use this revert in S2: it would violate new child FKs.
- **S2 — finish forward; do not rerun the migration file or reverse a partially live identity.**
  Re-establish the drain, confirm the old row still has `REAL_EMAIL` and the new row has
  `PARKED_EMAIL`, then resume at the fourteen child statements (all are safe to repeat because
  each only moves residual `OLD_ID` rows), followed by the reviewed delete and email tail:

  ```sh
  npx wrangler d1 execute quincy-portal --remote --command "UPDATE session SET user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id = 'seed-admin'; UPDATE account SET user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id = 'seed-admin'; UPDATE projects SET archived_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE archived_by = 'seed-admin'; UPDATE project_members SET user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id = 'seed-admin'; UPDATE document_uploads SET created_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE created_by = 'seed-admin'; UPDATE upload_manifests SET created_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE created_by = 'seed-admin'; UPDATE selections SET selected_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE selected_by = 'seed-admin'; UPDATE autohdr_handoffs SET initiated_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE initiated_by = 'seed-admin'; UPDATE asset_review_state SET updated_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE updated_by = 'seed-admin'; UPDATE annotations SET author_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE author_id = 'seed-admin'; UPDATE notice_board_posts SET author_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE author_id = 'seed-admin'; UPDATE publishes SET published_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE published_by = 'seed-admin'; UPDATE audit_log SET actor_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE actor_id = 'seed-admin'; UPDATE notifications SET user_id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id = 'seed-admin'; DELETE FROM user WHERE id = 'seed-admin'; UPDATE user SET email = 'mjj2332@gmail.com' WHERE id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385';"
  ```

  Run the detection/postflight commands again. If data is fully correct but the ledger remains at
  `0021`, it is now S4; follow S4 rather than executing `migrations apply`.
- **S3 — finish only the email tail, then reconcile the ledger if necessary.** After the query
  proves there is no old row/reference and all expected new counts are present, run exactly:

  ```sh
  npx wrangler d1 execute quincy-portal --remote --command "UPDATE user SET email = 'mjj2332@gmail.com' WHERE id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385';"
  ```

  Repeat all detection/postflight checks. If the ledger lacks `0022_seed_admin_uuid.sql`, the
  result is S4; do not rerun the SQL file.
- **S4 — reconcile only the proven missing ledger entry.** This is allowed only after all normal
  postflight checks prove complete data, real email, zero old references, and clean integrity. The
  local D1 ledger schema is `d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`. First confirm the remote ledger has
  that same shape, then add exactly the missing journaled filename, not a fabricated ID or
  timestamp:

  ```sh
  npx wrangler d1 execute quincy-portal --remote --command "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations';"
  ```

  ```sh
  npx wrangler d1 execute quincy-portal --remote --command "INSERT INTO d1_migrations (name) VALUES ('0022_seed_admin_uuid.sql');"
  ```

  Re-run the ledger and full postflight commands and record the result. This is a narrowly scoped
  ledger reconciliation after data has been proven complete; it is never a substitute for applying
  the migration and it must not be used in S0–S3.

## Routing

This is **Security, auth, payments, migrations** under the routing table in
[`docs/Subagent-Orchestration.md:132-142`](../Subagent-Orchestration.md#L132-L142): it changes the
primary key behind Better Auth `session`/`account` and fourteen production FK columns. Route the
build to Terra at maximum effort; require a separate fresh Terra maximum-effort plan review (up to
two rounds), then the required fresh Opus plan review/revert loop before implementation, per
[`Subagent-Orchestration.md:91-108`](../Subagent-Orchestration.md#L91-L108). The normal fresh Terra
diff review and final independent gate still apply after implementation.
