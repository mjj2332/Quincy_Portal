# Admin Impersonation

An Admin can act as a real Photographer or Editor — full session, full permissions, real audit
trail — without that person signing in. Built 2026-08-26 specifically to remove sign-in friction
from testing: before this, exercising a role's behavior meant a separate authenticated browser
session per role. Now one Admin sign-in covers every role. (Full build/review history lived in
a plan under `docs/plans/`, retired 2026-09-04 — see `git log` for that history if needed.)

## Using it

1. Admin → Users → toggle **Enable user impersonation (testing)** on. Runtime D1 flag, no deploy
   needed; OFF by default and after every session (step 5).
2. Click **Act as** next to an active Photographer or Editor row. Never shown for Admin rows or
   your own row — enforced server-side by the plugin's permission map, not just hidden in the UI.
3. Confirm the modal. A sitewide banner ("Acting as {name} ({role}) · Exit") now marks every
   screen; the session is genuinely that user's — same identity, same capabilities, same
   author-only ownership — until Exit.
4. Click **Exit** to return to your own Admin session.
5. Toggle the flag back off. Confirm with:
   ```sql
   SELECT enabled FROM feature_flags WHERE key = 'user_impersonation';
   SELECT COUNT(*) AS live FROM session WHERE impersonated_by IS NOT NULL;
   ```
   Both must read `0` before the session is truly closed out.

No Google sign-in happens for the target — impersonation is a server-side session swap the
already-authenticated Admin performs. This is what lets one human sign-in cover every role.

If Exit ever fails (the original or target session was invalidated out-of-band — rare, and only
possible if someone else deactivates the target or revokes the admin session mid-test): sign out
completely and sign back in as Admin. There is no automatic recovery path; this was a deliberate
simplification over a more complex auto-recovery design, accepted because the tool is
single-operator and toggle-gated.

## The QA test account

`QA Impersonation Target (do not remove)` (`qa-impersonation-target@quincy.internal.test`,
Photographer role) exists specifically for this. It has **zero project memberships** — the safety
property that matters: acting as it can never reach a real client's project, because the server
denies access to anyone without membership, impersonated or not. Default to this account for any
impersonation-based test; only use a real staff account when the test specifically requires
existing project access.

## What it does and doesn't bypass

- **Bypasses author-only checks.** Acting as X, you can edit/delete X's own annotations, comments,
  and notice-board posts even though a normal Admin session cannot — deliberate, not a bug (see the
  caveat on this rule in `CLAUDE.md`). It does **not** extend to records owned by anyone other than
  the user you're acting as.
- **Cannot reach another Admin.** The plugin's permission map grants only `impersonate`, never
  `impersonate-admins` — enforced by better-auth itself, independent of the UI.
- **Fails closed continuously, not just at start.** Every request re-checks the target's current
  role and the original Admin's active/capability state. Promote the target to Admin mid-session,
  deactivate the original Admin, or turn the flag off, and the very next request is denied.
- **Every action is audited with real provenance.** `metaJson.impersonatedBy` on every mutation
  names the real Admin; nothing in the request body can override it. Start/stop are separately
  logged as `user.impersonate_start`/`user.impersonate_stop`.

## Before any write while impersonating: check for real email

Some events send real email to real staff regardless of whose identity triggered them — the
provenance lives only in the audit log, never in the email itself. Before creating, editing, or
otherwise triggering any of these, either pick a different action or get it explicitly authorized:

`raw_ready`, `edited_landed`, `sent_to_editing`, `autohdr_stalled`, `delivered`, `comment_added`,
`assigned_to_project`, `mentioned`, `subtask_assigned`, `subtask_due_today`
(`packages/db/src/notifications.ts`).

Annotation create/edit/delete triggers none of these — it's the safe path for exercising the
author-only bypass live.

## Reference

| | |
|---|---|
| Settings routes | `GET`/`PATCH /api/users/impersonation-settings` (`manageUsers`-gated) |
| Start / stop | `POST /api/auth/admin/impersonate-user`, `POST /api/auth/admin/stop-impersonating` |
| Runtime gate | `workers/app/src/lib/impersonation.ts` |
| Plugin config | `workers/app/src/auth.ts` |
| Banner / Act-as UI | `apps/web/src/components/ImpersonationBanner.tsx`, `apps/web/src/screens/Admin.tsx` |
| Feature flag table | `feature_flags` (key `user_impersonation`), migration `0032` |
