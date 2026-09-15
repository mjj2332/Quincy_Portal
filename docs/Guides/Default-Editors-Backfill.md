# Default editors: rollout and one-off backfill (#135)

Default editors are added to Projects **created after** the release. Existing non-archived Projects
get them from a one-off backfill that an operator runs by hand, only with the owner's approval.
The backfill is silent: no notifications, no activity events, one `project.default_editors.backfilled`
audit row per Project it touched.

## Order

1. Deploy the release (migration `0044_user_default_editor` adds `user.default_editor`, default 0).
   Nothing is backfilled by the migration.
2. On **Admin → Users**, tick **Default editor** for each user (2026-09-15 decision: Mark, global
   role editor, and Megan, admin). The box is disabled for Photographers and inactive users.
   From this point every new Project gets them, with the normal assignment notification.
3. Back up D1:
   `npx wrangler d1 export quincy-portal --remote --output ~/quincy-d1-backups/quincy-portal-<date>-pre-default-editors.sql`
4. Dry run (SELECT only), from `portal/`:
   `npx wrangler d1 execute quincy-portal --remote --json --file scripts/default-editors-backfill-dryrun.sql --config workers/app/wrangler.jsonc > <scratch>/default-editors-dryrun.json`
   Review the pairs (Project, street, user email) with the owner. Projects where a default editor is
   already a member, was removed by hand, or was backfilled before do not appear.
5. Generate the apply file from that exact reviewed manifest:
   `node scripts/default-editors-backfill.mjs --manifest <scratch>/default-editors-dryrun.json --out <scratch>/default-editors-apply.sql`
6. With owner approval, apply:
   `npx wrangler d1 execute quincy-portal --remote --file <scratch>/default-editors-apply.sql --config workers/app/wrangler.jsonc`
7. Re-run step 4: it must return no rows.

## Safety properties

- Every membership INSERT re-checks, at apply time, that the Project is still non-archived, the user
  is still an active, editor-eligible default editor, the pair was not removed by hand, and it was not
  backfilled before; conflicts on the existing unique index do nothing.
- If the apply is interrupted, re-run **the same apply file**. Do not regenerate it mid-run: the
  membership ids in the file are what ties each Project's audit row to the rows it inserted.
- Membership ids are UUIDs, so backfilled editors can be removed in the Project team UI like any other.
- `created_at` is the real run time, so the backfilled editors receive Project activity notifications
  from then on and nothing from before.

## Limits

- Default editors are applied only at creation. Marking a user later does not add them to existing
  Projects; unmarking or deactivating never removes memberships.
- Deactivating a user or changing their role to one that cannot be an Editor clears the flag.
- Default editors do not satisfy the Editor Dropbox folder prerequisite, which still needs an active
  Photographer.
