# Confirmation Modal and Admin Impersonation Plan

> **Status: Deployed to production, 2026-08-26.** Commits `f2d3700` (build), `3b9632a`/`de17a59`
> (two Sol diff-review fix passes), `320959b` (Opus final-draft fix pass). App Worker version
> `58fe2088-605a-46ca-a5e8-67e196715058`, rollback target `2fb292aa-f042-4982-96f9-1b64991922cf`.
> Migration `0032` applied cleanly (preflight, recovery export, and postflight all recorded).
> Authenticated production smoke test performed live by the human operator in the Claude Browser
> pane: flag toggle, "Act as", banner, identity switch, Exit-restore, and the full audit trail
> (`user.impersonation_toggle` / `user.impersonate_start` / `user.impersonate_stop`, all with the
> correct real-admin actor and target metadata) all verified directly against production D1. Flag
> disabled after the smoke window; zero live `session.impersonated_by IS NOT NULL` rows confirmed
> remaining. This is one combined plan/build/deploy unit that shipped as intended — ad hoc tooling
> and developer-experience work, not a numbered revamp tracer bullet.

## Authority and outcome

Authority order for this plan is:

1. The settled product and architecture decisions supplied for this combined feature.
2. [`Decision-Sheet.md`](../Decision-Sheet.md), [`Implementation-Plan.md`](../Implementation-Plan.md),
   and the current-state rules in [`todo.md`](../todo.md).
3. The auth, Hono-routing, review-lightbox, and D1 lessons in [`lessons.md`](../lessons.md).
4. The execution and production-automation boundaries in
   [`Subagent-Orchestration.md`](../Subagent-Orchestration.md).
5. The shipped app, schema, tests, and Better Auth 1.6.23 package installed in `portal/`.
6. This repository-native execution plan.

The combined user outcome is:

- every existing native `window.confirm()` guard becomes an accessible, real-DOM Quincy modal
  that humans and browser automation can reliably operate; and
- an Admin can deliberately enable a runtime testing gate, start a short-lived official Better
  Auth impersonation session for an active Photographer or Editor, see an unmissable sitewide
  identity banner, perform the target user's real actions with complete audit provenance, exit
  back to the original Admin session, and disable the gate without a deploy.

These features ship together. The new Admin “Act as” action is itself guarded by the new
confirmation modal, so neither feature is considered complete, deployable, or independently
releasable before the other.

### Implementation precondition

Implementation begins from a fresh branch off then-current `main`, records the base commit, and
rechecks `docs/todo.md`, the worktree, installed Better Auth API, and the remote D1 ledger before
editing. Migration `0032` is the next number at plan-draft time: the actual
`portal/packages/db/migrations/meta/_journal.json` was inspected on 2026-08-26 and ends at index 31,
tag `0031_notification_outbox_and_delivery_ledger`. If another migration lands before build work
starts, the builder must renumber this plan's migration file, snapshot, journal entry, test name,
and deployment commands together; the SQL and semantics do not change.

This plan authorizes no change in `prototype/`, no dependency installation, no new confirmation
guards beyond the existing sixteen plus the explicitly approved “Act as” integration, and no
implementation split into separate branches or deploys.

## Verified current state

### Native confirmations and modal precedent

There are exactly sixteen `window.confirm(...)` calls and zero `window.alert(...)` calls below
`portal/apps/web/src`. The sixteen calls are the only existing guards to migrate. The styles
`.scrim`, `.modal`, `.modal--wide`, `.modal__head`, `.modal__body`, and `.modal__foot` already exist
under `/* Modals + toasts */` in `apps/web/src/styles/app.css`, but no production React component
uses them. They are the ported visual contract of `prototype/app/ui.jsx`'s `QP.Modal`.

`@floating-ui/react` is already installed and `components/AnchoredPopover.tsx` demonstrates
`FloatingPortal` and `FloatingFocusManager`. No React modal/context dependency is needed. The
closest existing notification pattern, toasts, is screen-local and is not a shared provider.

### Auth, roles, and session enforcement

`better-auth@1.6.23` is installed. Its official Admin plugin supplies
`POST /admin/impersonate-user`, `POST /admin/stop-impersonating`, a matching `adminClient()`, the
separate `impersonate` and `impersonate-admins` actions, and `session.impersonatedBy`. Neither the
server plugin nor client plugin is currently configured.

Quincy's `user.role` is exactly `admin | photographer | editor`. Clients authenticate only through
hashed `client_links` tokens and have no `user` row or staff session. Impersonation targets can
therefore only be real Photographer or Editor users. The planned assignment-scoped
`external_editor` role is not live and is not invented here.

`requireSession` validates Better Auth's session, reloads the user row, rejects inactive users, and
stores a `SessionUser` in Hono context. `requireCapability()` then evaluates the effective user's
role using `@quincy/shared`. The authenticated `/api/users` router is already scoped to
`manageUsers`. Deactivation deletes all target sessions immediately.

The current Hono order matters: exact sign-in handling and then `app.all('/api/auth/*', handler)`
appear before the authenticated `/api` router. The impersonation-start gate must therefore be an
exact path-scoped route registered before that wildcard. It must not be implemented as
`router.use('*', ...)` on a root-mounted router.

### Better Auth schema compatibility

The official Admin plugin's adapter schema reads these fields even though Quincy will not expose
the plugin's user-management operations:

- `user.role` — already present;
- `user.banned`, `user.banReason`, and `user.banExpires` — absent today; and
- `session.impersonatedBy` — absent today.

Migration 0032 therefore adds all four compatibility columns. Quincy continues to use `active` as
its login/deactivation authority; the new moderation columns exist only so the installed plugin's
adapter queries are schema-complete. The custom plugin access-control role grants no ban, role,
password, email, create, delete, list, or session-management operation.

### Settings and audit storage

There is no generic application-settings or feature-flags table. A minimal generic
`feature_flags` table is introduced and seeded with one fail-closed row.

`audit_log` already stores `actor_id`, action, target, and JSON metadata. The current `audit()`
helper accepts a bare actor ID, and several transaction/batch paths insert audit rows directly.
That interface cannot make impersonation provenance mandatory. This plan replaces the request-side
actor argument with an `AuditPrincipal` and routes every request-owned direct audit insert through
one metadata merger. System/background audit rows may continue to use a null principal.

## Scope and hard non-goals

### In scope

1. A generic accessible `Modal`, a confirmation dialog and singleton promise API, one global host,
   stable automation selectors, shared destructive button styling, and migration of the sixteen
   existing calls.
2. Official Better Auth Admin-plugin impersonation with a custom least-privilege permission map,
   one-hour target sessions, a runtime D1 gate, continuous target/original-principal revalidation,
   and the stock official Exit path with a documented manual fallback.
3. A settings switch and per-row “Act as” action in the existing Admin user directory, plus a
   fixed sitewide impersonation banner.
4. Lifecycle audit events and automatic `impersonatedBy` metadata on every request-owned audit row
   created during impersonation, including batched/direct audit inserts.
5. Migration 0032, schema mappings, tests, local QA, safe production rollout, and rollback gates for
   the combined unit.

### Prominent accepted risk: author-only identity is the impersonated identity

**This feature deliberately lets the real Admin exercise the full power of the selected user's
identity. While acting as user X, the server sees X as the actor, so the Admin can edit or delete
annotations and other author-only records owned by X even though a normal Admin session has no
author-only exemption. This is intentional, including for the repository's strict annotation
author-only invariant. Do not add an `impersonatedBy` denial or special case to annotations,
project comments, Notice Board posts, or any other author check.**

The bounded mitigations are the runtime-off-by-default master gate, one-hour impersonated session,
original-Admin revalidation, visible banner, dedicated lifecycle records, and mandatory
`metaJson.impersonatedBy`. Acting as X does not authorize records owned by unrelated user Y. This
policy exception is reversible by turning the gate off and is not a future bug to “fix” unless the
user changes the policy explicitly.

### Accepted limitation: out-of-band session invalidation requires manual recovery

If the original Admin session or the target session is invalidated out-of-band while
impersonating, the official Exit may fail. Recovery is a manual full sign-out/sign-in, not an
automatic recovery path. This is accepted for a single-operator, toggle-gated, short-duration
testing tool. The banner must make that fallback explicit when Exit fails; this plan adds no custom
session-restoration endpoint, recovery cookie parser, or parallel session ledger.

### Hard non-goals

- No read-only or UI-only “view as” skin; this is real full session impersonation.
- No impersonation of an Admin, including self or another Admin. The plugin permission model must
  enforce this server-side; UI hiding is only defense in depth.
- No client impersonation. Clients are token-backed `client_links`, not user accounts.
- No invented `external_editor` account or early delivery of the future role.
- No change to `Subagent-Orchestration.md` §2.9. Its standing passive-only production policy for
  danger-mode Luna remains in force; the runtime gate does not grant an agent new authority.
- No new author-only enforcement or exception-reversal logic.
- No new confirmation audit of unrelated destructive flows and no conversion of non-confirming
  actions to confirmations.
- No React Context/provider plumbing, no modal library, no dependency upgrade, and no loading state
  inside a confirmation dialog.
- No use of the plugin's user creation, listing, role, ban, password, email, deletion, or session
  administration endpoints.

## 1. Generic Modal and confirmation seam

### 1.1 `components/Modal.tsx`

Add the reusable visual/accessibility primitive with this public contract:

```ts
export type ModalProps = {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  testId?: string;
  initialFocus?: React.MutableRefObject<HTMLElement | null> | number;
};

export function Modal(props: ModalProps): JSX.Element;
```

Implementation requirements:

- render through `FloatingPortal`, not inline in the screen's stacking context;
- use `FloatingFocusManager` with a modal focus trap and return focus to the invoking element;
- render `.scrim > .modal`, adding `.modal--wide` only for `wide`;
- give the panel `role="dialog"`, `aria-modal="true"`, a generated title ID, and
  `aria-labelledby=<title-id>`;
- render the prototype-compatible eyebrow/head/body/footer shape and omit empty optional regions;
- close on scrim click and Escape; stop propagation from the panel;
- on Escape, call both `preventDefault()` and `stopPropagation()` before `onClose()` so the same key
  cannot also reach Lightbox's document/window shortcut handler; and
- expose `testId` only on the role-dialog panel. Confirmation supplies the stable value; generic
  modal consumers do not invent confirm selectors.

Backdrop or Escape close is semantically Cancel. There is no close “×” in the generic primitive;
specialized consumers supply their explicit actions.

### 1.2 `lib/confirm.ts`

Add the small, framework-independent singleton interface:

```ts
export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export function confirm(options: ConfirmOptions): Promise<boolean>;
```

Defaults are `confirmLabel: "Confirm"`, `cancelLabel: "Cancel"`, and `danger: false`. `title` and
`message` are required so a call cannot silently fall back to browser-like “OK” copy.

The module owns a FIFO queue and a minimal `subscribe/getSnapshot` external-store seam consumed by
the host. Each request captures one resolver. Only the active request renders; resolving it with
`true` or `false` removes it, settles its promise exactly once, and activates the next request.
Queueing, rather than replacing an active resolver, prevents simultaneous leaf actions from
orphaning promises. `confirm()` does not reject.

Keep the renderer bridge deliberately narrow and export it only for `ConfirmModalHost` and focused
tests:

```ts
export type ActiveConfirm = Readonly<{ id: number; options: ConfirmOptions }>;

export const confirmStore: {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ActiveConfirm | null;
  resolve(value: boolean): void;
};
```

Resolvers stay private inside the module; neither the component nor a caller can settle an
arbitrary queued request by ID.

### 1.3 `components/ConfirmDialog.tsx`

Add:

```ts
export type ConfirmDialogProps = ConfirmOptions & {
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element;
export function ConfirmModalHost(): JSX.Element | null;
```

`ConfirmModalHost` uses `useSyncExternalStore` against `lib/confirm.ts` and renders the active
request. `ConfirmDialog` composes `Modal`, places the message in `.modal__body`, and renders Cancel
then Confirm in `.modal__foot`. It must provide exactly:

- `data-testid="confirm-modal"` on the dialog panel;
- `data-testid="confirm-modal-cancel"` on Cancel; and
- `data-testid="confirm-modal-confirm"` on Confirm.

Initial focus is Cancel. Cancel, Escape, and backdrop resolve false; Confirm resolves true. Confirm
uses `.button` plus `.button--danger` when `danger` and the normal primary `.button` treatment
otherwise. A choice closes the modal immediately, returns focus, and only then lets the caller's
existing asynchronous operation continue. There is no pending state, disabled-in-flight state, or
API error rendering inside the dialog.

Mount one `<ConfirmModalHost />` beside `<App />` under `StrictMode` in
`apps/web/src/main.tsx`. It is not a provider and must remain mounted across sign-in, route, and
effective-session changes.

### 1.4 Styles and popover interoperation

In `styles/app.css`:

- retain and use the existing modal classes;
- add only the accessibility/layout refinements the production component requires;
- add `.button--danger` alongside `.button--secondary` and `.button--text`, using
  `--signal-critical` for border/text and a clear critical hover/focus treatment consistent with
  `.danger-zone__button`; and
- do not repurpose the danger-zone-specific class as the shared button modifier.

The existing `.scrim { z-index: 90 }` ordering is load-bearing and must remain unchanged: it keeps
the confirm panel above `.viewer` (80), including its `.viewer--compare` mode on that same element,
and the impersonation banner (76). The authorized modal refinements must not lower or normalize
this value, because five Lightbox guards need a visible, operable confirmation while the
full-screen viewer is mounted.

`SubtaskChecklist` launches confirmation from inside `AnchoredPopover`. The current shared
`outside()` detector drives both window `pointerdown` and `focusin` listeners; either event would
otherwise close the popover when the user interacts with the portalled dialog. Give the confirm
portal root `data-confirm-modal-root` and make `outside()` return false for every descendant of
that root before either listener's focus-specific logic. This one exemption must therefore cover
both pointer-down and focus-in, not only focus. After Cancel, focus returns to the popover's Delete
action and the popover stays open; after Confirm, the existing delete success path closes/removes
it.

A full `apps/web/src` usage search confirms `AnchoredPopover`/`useAnchoredPopover` are consumed only
by the three owner/assignee/actions popovers in `SubtaskChecklist.tsx`. The shared outside-detector
change is consequently narrow to that checklist module; its tests must still exercise both
pointer-down and focus-in while the confirm portal is open.

## 2. Exact confirmation-call migration

Import `confirm` from the relative `lib/confirm` path at every affected file. Preserve each action's
existing side effects and ordering; only the guard mechanism and required async boundary change.

| # | File and action | Exact `ConfirmOptions` decision |
|---:|---|---|
| 1 | `screens/EditProject.tsx` `archiveProject()` | title `Archive project?`; existing message verbatim; label `Archive`; not danger |
| 2 | same, `restoreProject()` | title `Restore project?`; existing message verbatim; label `Restore`; not danger |
| 3 | same, `deleteProject()` | title `Delete project permanently?`; existing message verbatim; label `Delete permanently`; danger |
| 4 | `screens/Admin.tsx` `toggleActive(user)` | title `Deactivate user?` or `Reactivate user?`; preserve the existing dynamic message; matching `Deactivate`/`Reactivate` label; danger only for deactivate |
| 5 | same, notification delivery discard | title `Discard delivery?`; existing message verbatim; label `Discard`; danger |
| 6 | same, unknown-email replay | title `Replay email?`; existing message verbatim; label `Replay email`; danger |
| 7 | `components/SubtaskChecklist.tsx` row delete | title `Delete subtask?`; message `Delete this subtask?`; label `Delete`; danger |
| 8 | `components/ProjectCollaborationPanel.tsx` comment remove | title `Delete comment?`; message `Delete this comment?`; label `Delete`; danger |
| 9 | `components/CollectionPanel.tsx` version delete | title `Delete version ${document.version}?`; existing dynamic message verbatim; label `Delete`; danger |
| 10 | `components/PhotoGrid.tsx` single delete | title `Delete ${asset.originalFilename}?`; existing dynamic message verbatim; label `Delete`; danger |
| 11 | same, selected delete | title `Delete ${ids.length} selected asset${ids.length === 1 ? "" : "s"}?`; existing dynamic message verbatim; label `Delete selected`; danger |
| 12 | `components/Lightbox.tsx` previous/next `move(change)` | title `Discard unsaved markup?`; existing message verbatim; label `Discard`; danger |
| 13 | same, `drawDown(event)` note-edit guard | title `Discard note edit?`; existing message verbatim; label `Discard`; danger |
| 14 | same, annotation delete | title `Delete annotation?`; preserve the existing markup/no-markup conditional message; label `Delete`; danger |
| 15 | same, viewer close button | title `Discard unsaved markup?`; existing message verbatim; label `Discard`; danger |
| 16 | same, filmstrip selection | title `Discard unsaved markup?`; existing message verbatim; label `Discard`; danger |

The permanent project delete retains both guards: the existing exact-street-name danger-zone input
and the new in-app confirmation. Archive/restore remain reversible/non-danger operations.

Make or retain all enclosing handlers as `async`. Event callbacks which cannot return a promise to
React call the async handler with `void`. For Lightbox keyboard, swipe, close, and thumbnail
callbacks, await the choice before changing state and consume the original event so no second
navigation/close occurs.

Pointer capture cannot be resumed safely after an asynchronous modal choice. For Lightbox
`drawDown`, accepting “Discard note edit” cancels the edit and consumes that pointer gesture; the
user starts drawing with the next fresh pointer-down. Do not synthesize a stale point or call
`setPointerCapture()` after the pointer may already have ended. This is the sole intentional
interaction difference from native synchronous confirm and must be covered by a component test.

After implementation, full-tree searches must find zero production references to
`window.confirm`, bare global `confirm`, or `window.alert` under `apps/web/src`.

## 3. Migration 0032 and Drizzle schema

### 3.1 Exact migration file and SQL

Create `portal/packages/db/migrations/0032_admin_impersonation.sql` with this SQL (renumber only if
the ledger advances before implementation):

```sql
ALTER TABLE user ADD COLUMN banned integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE user ADD COLUMN ban_reason text;
--> statement-breakpoint
ALTER TABLE user ADD COLUMN ban_expires integer;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN impersonated_by text;
--> statement-breakpoint
CREATE TABLE feature_flags (
  key text PRIMARY KEY NOT NULL,
  enabled integer NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_by text REFERENCES user(id) ON DELETE set null,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX feature_flags_updated_by_idx ON feature_flags (updated_by);
--> statement-breakpoint
INSERT INTO feature_flags (key, enabled, updated_by, updated_at)
VALUES ('user_impersonation', 0, NULL, unixepoch('now') * 1000);
```

These are additive `ALTER TABLE ADD COLUMN` statements. Do not accept a Drizzle-generated table
rebuild, `PRAGMA foreign_keys=OFF`, a CHECK on `session.impersonated_by`, or a foreign key on that
session compatibility column. Existing user rows backfill `banned = 0`; existing sessions receive
`impersonated_by = NULL`; the feature is OFF immediately after migration.

### 3.2 Schema and ledger artifacts

Update `packages/db/src/schema.ts`:

- map `user.banned` as boolean, not null, default false;
- map nullable `user.banReason` and timestamp-ms `user.banExpires`;
- map nullable `session.impersonatedBy`;
- export `featureFlags` with the exact columns, CHECK, FK, and
  `feature_flags_updated_by_idx` above.

Generate and hand-review the migration in this exact order:

1. update `packages/db/src/schema.ts` with all mappings above;
2. run `drizzle-kit generate --name admin_impersonation`, producing the initial SQL file,
   `packages/db/migrations/meta/0032_snapshot.json`, and the journal entry with index 32/tag
   `0032_admin_impersonation` (renumber together if the ledger advanced before implementation);
3. replace only the generated SQL file's body with the exact reviewed additive SQL from §3.1,
   retaining the generated snapshot and journal entry unchanged; and
4. run `drizzle-kit generate` a second time and require an empty diff/no additional migration file,
   proving `schema.ts` matches the committed snapshot while the reviewed SQL implements that same
   schema without a table rebuild.

No second SQL file may remain.

The plugin compatibility fields are not returned by Quincy's user-directory API. Change
`GET /api/users` from an unbounded `select()` to an explicit projection of exactly `id`, `name`,
`email`, `role`, `active`, and `createdAt`.

Better Auth will include `banned`, `banReason`, and `banExpires` in the signed-in user's own
`/api/auth/get-session` and successful impersonate-response payloads. That is expected self-data,
not a cross-user disclosure; only the cross-user `GET /api/users` directory projection must exclude
those compatibility fields.

## 4. Better Auth plugin and least-privilege policy

### 4.1 Server configuration

In `workers/app/src/auth.ts`, import `admin` and `createAccessControl` from
`better-auth/plugins`. Deliberately mirror the complete default Admin-plugin statement vocabulary
installed in 1.6.23 so the local permission map is explicit and future reviews can see every action
that is withheld; `createAccessControl` itself would also accept a smaller map. Then create Quincy
roles with these exact grants:

```ts
const adminStatements = {
  user: [
    "create",
    "list",
    "set-role",
    "ban",
    "impersonate",
    "impersonate-admins",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
  ],
  session: ["list", "revoke", "delete"],
} as const;

const ac = createAccessControl(adminStatements);
const adminRole = ac.newRole({ user: ["impersonate"], session: [] });
const photographerRole = ac.newRole({ user: [], session: [] });
const editorRole = ac.newRole({ user: [], session: [] });
```

The Admin grant must not contain `impersonate-admins`. It must also omit `create`, `list`,
`set-role`, `ban`, `delete`, `set-password`, `set-email`, `get`, and `update`, plus every session
action. Configure:

```ts
admin({
  ac,
  roles: { admin: adminRole, photographer: photographerRole, editor: editorRole },
  defaultRole: "photographer",
  adminRoles: ["admin"],
  impersonationSessionDuration: 60 * 60,
})
```

One hour bounds stale testing identity while leaving enough time for a focused QA pass. The plugin
retains the original Admin session in its signed `admin_session` cookie and creates a separate
target session carrying `impersonatedBy`. Its stock official Exit deletes that target and restores
the original while both sessions still resolve. Quincy does not parse or extend that cookie/session
mechanism.

Keep `active`, not `banned`, as Quincy's account status. Extend the existing session-create hook so
both ordinary and impersonated target sessions reject inactive target users. The plugin's custom
access control and Quincy's route gate are independent defenses: direct requests cannot gain the
omitted actions even if their UI is hidden.

### 4.2 Client configuration

In `apps/web/src/lib/auth.ts`, add `adminClient()` from `better-auth/client/plugins` to the existing
client and export normalized wrappers:

```ts
export async function impersonateUser(userId: string): Promise<void>;
export async function stopImpersonating(): Promise<void>;
```

`impersonateUser` calls the official client with `{ userId }`; `stopImpersonating` calls the
official stop method. Each throws the server/client error message on failure and returns only after
the auth client has accepted the stock session-cookie transition. UI code does not call raw auth
URLs or retain a parallel recovery marker.

## 5. Runtime gate and API contracts

### 5.1 One settings seam

Add `workers/app/src/lib/impersonation.ts` with:

```ts
export const USER_IMPERSONATION_FLAG = "user_impersonation" as const;

export async function isUserImpersonationEnabled(env: Env): Promise<boolean>;
export async function assertImpersonationSessionAllowed(
  env: Env,
  targetUserId: string,
  impersonatedBy: string,
): Promise<void>;
export const requireImpersonationEnabled: MiddlewareHandler<AppEnv>;
```

`assertImpersonationSessionAllowed` performs one fail-closed validation module on every request:

1. require the feature row to exist and be ON;
2. reload the target user by `targetUserId`, require `active = true`, and require its **current**
   role to be exactly `photographer` or `editor`; and
3. reload the original user by `impersonatedBy` and require `active = true` plus
   `roleHasCapability(role, 'manageUsers')`.

The original-side liveness rule is intentionally principal-level, not session-level: “the original
Admin is still a valid, active Admin somewhere” is sufficient. The check does not require the
literal original session token/row saved by Better Auth to still exist or remain unexpired. This is
an accepted, deliberate simplification for a single human operator using short, explicitly enabled
testing windows—not an omitted security check. Original-user deactivation/demotion, target
promotion to Admin, target deactivation, the flag turning OFF, or any required D1 read failure still
fail closed.

Extend `SessionUser` in `workers/app/src/env.ts` with
`impersonatedBy: string | null`. `requireSession` reads `session.session.impersonatedBy`; when
present it passes the effective user ID and original user ID to
`assertImpersonationSessionAllowed` before storing the effective user. This check runs for every
normal authenticated `/api` and `/media` request, so turning the flag OFF or either principal
becoming invalid immediately makes an already-open impersonated session inert. Return status 403
and:

```json
{ "error": "User impersonation is disabled.", "code": "impersonation_disabled" }
```

for every failed ongoing rule, including current target role or original-principal liveness. Keep
the same generic code/message and do not reveal which principal failed.

Session inspection and the stock stop-impersonating route remain reachable outside this gate so the
flag itself does not block Exit. If Better Auth can no longer resolve either session needed by its
official stop handler, automatic Exit can fail; §7.2 owns the explicit manual sign-out/sign-in
fallback.

### 5.2 Settings routes

Add these routes to the existing `usersRoutes`; its path-scoped `manageUsers` middleware remains
the authority:

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /api/users/impersonation-settings` | none | `200 { "enabled": boolean }` | existing 401/403; missing row returns `enabled: false` |
| `PATCH /api/users/impersonation-settings` | exact JSON `{ "enabled": boolean }` | `200 { "enabled": boolean }` | 400 for any non-boolean, missing, or unknown field; existing 401/403 |

Register both static `/users/impersonation-settings` routes before the existing
`PATCH /users/:id` route. Hono's registration-order matching must never capture
`impersonation-settings` as the dynamic `:id` value.

PATCH uses one D1 batch/transaction boundary to update `enabled`, `updated_by`, and `updated_at`
and insert `user.impersonation_toggle` with actor = current Admin, target type `feature_flag`, target
ID `user_impersonation`, and metadata `{ enabled }`. It must reject rather than silently inserting
a missing singleton row; a missing row means migration/integrity failure and remains fail closed.

### 5.3 Official impersonation routes and ordering

The auth contracts under Quincy's Better Auth prefix are:

| Method and path | Request | Success semantics | Quincy gate |
|---|---|---|---|
| `POST /api/auth/admin/impersonate-user` | `{ "userId": string }` | plugin creates target session/cookies and returns target session payload | current `requireSession`, `manageUsers`, runtime flag, plugin `impersonate`; active non-Admin target only |
| `POST /api/auth/admin/stop-impersonating` | official empty body | stock plugin deletes the target session and restores the original Admin cookie/session | stock Better Auth validation; reachable while the runtime flag is OFF |

Register an exact start route in `workers/app/src/index.ts` before
`app.all('/api/auth/*', handler)`, applying `requireSession`,
`requireCapability('manageUsers')`, and `requireImpersonationEnabled`, then forwarding the unmodified
request to `createAuth(env).handler`. Do not register a Quincy wrapper for stop: the existing
`app.all('/api/auth/*', handler)` wildcard serves the stock stop route unchanged, without the start
gate or Quincy's normal `requireSession`. The same wildcard continues to serve all other Better
Auth routes; custom plugin permissions deny the other Admin-plugin operations. There is no custom
stop preflight, cookie parser, restoration hook, or recovery endpoint.

The plugin rejects Admin targets because the configured role lacks `impersonate-admins`. It also
rejects attempts to chain impersonation: the effective Photographer/Editor has an empty plugin role
and no `manageUsers`. UI filtering is not the security boundary.

## 6. Audit provenance and lifecycle

### 6.1 Structurally mandatory request provenance

Replace the bare-ID audit API in `workers/app/src/lib/audit.ts` with:

```ts
export type AuditPrincipal = Pick<SessionUser, "id" | "impersonatedBy"> | null;

export function auditMeta(
  principal: AuditPrincipal,
  meta?: Record<string, unknown>,
): string | null;

export async function audit(
  env: Env,
  principal: AuditPrincipal,
  action: string,
  targetType: string,
  targetId: string | null,
  meta?: Record<string, unknown>,
): Promise<void>;
```

`audit()` writes `actorId = principal?.id ?? null`. `auditMeta()` preserves current behavior for a
normal principal (`undefined` becomes SQL NULL; supplied metadata stays the same), but for an
impersonated principal serializes `{ ...meta, impersonatedBy: principal.impersonatedBy }`.
Provenance is merged last so a caller cannot overwrite or omit it.

Every request-side `audit(env, user.id, ...)` call becomes `audit(env, user, ...)`. Refactor all
request-owned direct `audit_log` insertions to use `auditMeta()` as well; a helper call alone is not
enough because D1 batches must remain atomic. The required source audit includes:

- routes: `admin.ts`, `annotations.ts`, `assets.ts`, `collections.ts`, `integrations.ts`,
  `notice-board.ts`, `notifications.ts`, `project-subtasks.ts`, `projects.ts`, `review.ts`,
  `uploads.ts`, and `users.ts`;
- libraries: `ingest.ts` and `project-comments.ts`; and
- any additional direct request-owned `INSERT INTO audit_log` raw-SQL insertion or
  `schema.auditLog` Drizzle insertion found by the mandatory full-tree audit before completion.

The broadened search also finds the raw `audit_log` insertion in
`packages/db/src/stage-transition.ts`; it has zero current callers and is therefore out of scope,
not a new missed request-owned audit site. If it gains a caller before implementation, classify
that caller during the source audit rather than relying on this plan-time exemption.

Where a library currently receives only `actorId`, change its request contract to receive an
`AuditPrincipal` while retaining the effective ID for ownership/domain columns. In particular,
`finalizeIngest` receives the full audit principal from uploads, and project-comment mutation
inputs carry the audit principal separately from their effective author ID. Background/system
events keep `null`; scheduled or service operations must not fabricate impersonation provenance.

Completion requires a source search proving that every request-owned audit row uses either
`audit()` or `auditMeta()`. This central seam makes forgetting the provenance key structurally
difficult and keeps batched mutations atomic.

`workers/app/src/routes/projects.ts` already declares an unrelated local `const auditMeta`; in that
file, rename the local or alias the new import so the two names do not collide.

### 6.2 Lifecycle records at the session boundary

Use Better Auth database session hooks in `workers/app/src/auth.ts` so normal request-bound
lifecycle records do not depend on the UI or route wrapper:

- in `session.create.before`, when `session.impersonatedBy` is present, re-check the runtime flag,
  original Admin active/capability state, and active non-Admin target; then write
  `user.impersonate_start` before allowing the target session to be created;
- in `session.delete.before`, only when the request path is the official
  `/admin/stop-impersonating` operation and the deleted session has `impersonatedBy`, write
  `user.impersonate_stop` before allowing deletion/restoration.

Both records use actor = original Admin ID, target type `user`, target ID = effective target user,
and metadata exactly `{ targetEmail, targetRole }`. Hook failure aborts the associated transition;
do not create an unaudited impersonation session or silently stop without the lifecycle record.
Automatic expiry/session cleanup and a failed official Exit are not mislabeled as an explicit stop.

The stop hook obtains the original ID directly from the target session's `impersonatedBy`; it does
not infer identity by querying a previous audit row. Dedicated lifecycle metadata does not need a
second `impersonatedBy` key because its `actor_id` is already the real Admin, while all domain
mutations during the target session use actor = target and metadata = real Admin.

Better Auth resolves hook endpoint context with a nullable lookup. If that context is null, the
stop hook cannot prove that `context.path` is the official stop endpoint, so it writes no
`user.impersonate_stop` lifecycle row and allows the stock deletion to continue. Treat that rare
missing lifecycle breadcrumb as part of the best-effort limitation below, not as evidence that the
session transition did not occur.

**Achievable consistency guarantee:** Better Auth 1.6.23 runs `session.create.before` and
`session.delete.before` before the adapter's actual insert/delete, and these hook writes are not in
one D1 transaction with the adapter mutation. A later adapter/cookie failure can therefore leave a
start audit for a target session that was never delivered, or a stop audit preceding a
delete/restore that failed; racing stop requests can also produce duplicate stop records. This
small best-effort inconsistency window is accepted. Lifecycle audit rows are provenance
breadcrumbs rather than a correctness ledger. The security-relevant invariant remains the mandatory
`metaJson.impersonatedBy` on every domain mutation that actually commits. Do not add a distributed
transaction or reconciliation subsystem for these lifecycle breadcrumbs.

## 7. Admin controls and sitewide banner

### 7.1 Admin user-directory controls

Extend `screens/Admin.tsx` without a parallel user-list API:

- load `GET /api/users` and `GET /api/users/impersonation-settings` for the Users section;
- render a labelled switch, `Enable user impersonation (testing)`, near the user table;
- PATCH the setting, reconcile to the returned server value, and show the screen's existing error
  treatment on failure;
- when OFF, render no per-row “Act as” trigger;
- when ON, render “Act as” only for active Photographer/Editor rows that are not the acting Admin;
  never render it for any Admin or inactive row; and
- preserve all existing edit/role/active controls.

Clicking “Act as” invokes the new modal with:

```ts
{
  title: `Act as ${user.name}?`,
  message: "You'll gain their exact permissions, including bypassing author-only restrictions, until you exit.",
  confirmLabel: "Act as user",
  danger: true,
}
```

Decline does nothing. Accept calls `impersonateUser(user.id)`, then
`locationStore().replace('/')`. The auth client/session signal must refetch so `App` becomes the
target identity; `QueryProvider`'s existing `${user.id}:${user.role}` key then discards Admin-scoped
client caches. API failure stays in the Admin screen and does not navigate.

### 7.2 Effective session shape and banner

Extend the web's authenticated session typing to expose
`session.impersonatedBy: string | null | undefined`. Add:

```ts
export type ImpersonationBannerProps = {
  user: { name: string; role: "admin" | "photographer" | "editor" };
  invalidated: boolean;
};

export function ImpersonationBanner(props: ImpersonationBannerProps): JSX.Element;
```

`App.tsx` renders the banner above normal staff chrome whenever the current Better Auth session has
`impersonatedBy`, on every staff route. Copy is:

`Acting as {name} ({Admin|Photographer|Editor}) · Exit`

Treat `impersonatedBy` plus a current role other than `photographer` or `editor` as an explicit
**invalidated impersonation** state. Detect it before constructing `QuincyQueryProvider`, deriving
capabilities, or rendering `Shell`. Keep `ImpersonationBanner` and its Exit button visible with
`invalidated: true`, but replace all normal screen content with one standalone `main`/`role="alert"`
surface containing exactly:

`This impersonated session is no longer valid — exit to restore your Admin session.`

Render no topbar, rail, workspace, route content, or Admin navigation in that state. A promoted
target therefore cannot acquire Admin-looking UI, and the user never loses the stock Exit action
needed to restore the original Admin session.

Because this standalone surface is rendered outside `Shell`, give it its own
`.impersonation-invalidated { padding-top: 42px; }` rule so its message begins below the fixed
banner instead of relying on Shell's `.app--impersonating` descendant offsets.

“Exit” calls the stock `stopImpersonating()` and prevents repeat clicks while that call is in
flight. On success, refetch auth and replace the route with `/` so the restored Admin cannot remain
on a target-only deep link. On failure, keep the banner visible and render this exact persistent,
`role="alert"` message:

`Could not automatically exit. Sign out completely and sign back in as Admin to restore your session.`

Do not call another endpoint, parse auth cookies, synthesize a session, or silently dismiss the
banner. The human uses the existing full Sign out action and then Google sign-in. If target-session
invalidation has already made App render `SignIn`, signing in again as Admin is the same documented
manual fallback. The runtime flag may be OFF while the banner remains visible; it blocks target API
work but does not block the stock Exit attempt.

In `app.css`, use a fixed 42px-high banner above the existing topbar with z-index 76 (topbar is 75).
Add `.app--impersonating` offsets rather than changing ordinary layout:

- topbar `top: 42px` and application content top padding/space for the fixed banner;
- desktop rail/worktools sticky tops and max-heights gain 42px;
- the live `--project-collaboration-top` and `--project-collaboration-max-height` offset variables
  gain 42px; and
- mobile topbar/menu/worktools offsets gain the same 42px.

Extend the local `Shell` props in `App.tsx` with `impersonating: boolean`, pass
`Boolean(session.data.session.impersonatedBy)` from `App`, and render its root as
`className={impersonating ? "app app--impersonating" : "app"}` so every descendant offset below
has the required DOM anchor. Note that `session` in `App.tsx` is the `useSession()` result, so the
Better Auth session object is `session.data.session` — the same shape `requireSession` reads as
`session.session.impersonatedBy` on the server. Elsewhere in this document `session.impersonatedBy`
is shorthand for that field.

The full-screen viewer uses `.viewer { position: fixed; inset: 0; z-index: 80; }`; production
comparison mode is the `.viewer--compare` modifier on that same element, not a separate overlay.
Preserve its internal z-index/layout and add this exact impersonation-only offset:

```css
.app--impersonating .viewer { inset: 42px 0 0; }
```

The fixed viewer then reflows below the banner in both ordinary and `.viewer--compare` modes,
preserving its internal 16px controls while leaving the entire 42px identity/Exit strip
unobstructed. Ordinary non-impersonated viewer layout remains unchanged.

The banner cannot be dismissed except through a successful official Exit or the existing full
sign-out flow. It must remain legible at mobile width, expose a normal button for Exit, and not
cover modal, toast, topbar, rail, or workspace controls.

## 8. Exact file-by-file change inventory

### New files

| File | Required content |
|---|---|
| `portal/apps/web/src/lib/confirm.ts` | singleton FIFO promise API and external-store seam |
| `portal/apps/web/src/components/Modal.tsx` | portalled, trapped, accessible generic modal |
| `portal/apps/web/src/components/ConfirmDialog.tsx` | confirm specialization and global host |
| `portal/apps/web/src/components/ConfirmDialog.dom.test.tsx` | real modal/store accessibility and selector tests |
| `portal/apps/web/src/components/ImpersonationBanner.tsx` | fixed identity/invalidated-state banner, stock Exit, and manual-fallback error |
| `portal/apps/web/src/components/ImpersonationBanner.dom.test.tsx` | banner identity/state, stop, failure, and navigation tests |
| `portal/workers/app/src/lib/impersonation.ts` | flag lookup, live target/original-principal validation, start middleware |
| `portal/workers/app/test/impersonation.test.ts` | API/plugin/gate/audit/author-only integration coverage |
| `portal/packages/db/migrations/0032_admin_impersonation.sql` | exact additive SQL in §3.1 |
| `portal/packages/db/migrations/meta/0032_snapshot.json` | generated schema snapshot |
| `portal/packages/db/test/migration-0032.test.ts` | migration integrity and compatibility coverage |

If repository test naming/layout at implementation time requires colocating an app test beside a
different existing suite, keep the named behavioral coverage but do not create redundant suites.

### Changed web files

| File | Change |
|---|---|
| `apps/web/src/main.tsx` | mount the one global confirm host |
| `apps/web/src/lib/auth.ts` | configure `adminClient()` and export stock start/stop wrappers |
| `apps/web/src/App.tsx` | recognize valid/invalidated impersonation before capabilities, render banner or isolated invalid state, and apply `app--impersonating` to the Shell root |
| `apps/web/src/styles/app.css` | modal refinements, `.button--danger`, confirm/banner/chrome and viewer offset including comparison mode |
| `apps/web/src/components/AnchoredPopover.tsx` | exempt confirm portal from both pointer-down and focus-in outside detection |
| `apps/web/src/screens/EditProject.tsx` | migrate archive/restore/permanent-delete guards |
| `apps/web/src/screens/Admin.tsx` | migrate three existing guards; settings switch and Act-as flow |
| `apps/web/src/components/SubtaskChecklist.tsx` | migrate subtask delete guard |
| `apps/web/src/components/ProjectCollaborationPanel.tsx` | migrate comment delete guard |
| `apps/web/src/components/CollectionPanel.tsx` | migrate version delete guard |
| `apps/web/src/components/PhotoGrid.tsx` | migrate single/bulk asset delete guards |
| `apps/web/src/components/Lightbox.tsx` | migrate all five markup/navigation/delete guard sites and async gesture handling |
| `apps/web/src/screens/Admin.dom.test.tsx` | module-mock confirm; test setting/filter/Act-as integration |
| `apps/web/src/components/SubtaskChecklist.dom.test.tsx` | module-mock confirm; preserve decline/accept and popover coverage |
| `apps/web/src/components/CollectionPanel.dom.test.tsx` | module-mock confirm; preserve accept path |
| `apps/web/src/components/PhotoGrid.dom.test.tsx` | module-mock confirm; preserve exact option copy and decline/accept |
| `apps/web/src/components/Lightbox.dom.test.tsx` | module-mock confirm; preserve all existing call/choice coverage and new pointer rule |
| `apps/web/src/screens/ProjectWorkspace.dom.test.tsx` | replace defensive global confirm stubs with module mock |
| `apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx` | add consistent module mock; direct new delete assertions remain optional |
| `apps/web/src/App.dom.test.tsx` | valid/invalidated impersonation, banner/Exit isolation, and identity cache-boundary coverage |

There is no `EditProject.dom.test.tsx`; `App.dom.test.tsx` mocks that screen. This is a pre-existing
coverage gap and this plan does not create a new EditProject suite.

### Changed server/database files

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | plugin compatibility columns and `featureFlags` mapping |
| `packages/db/migrations/meta/_journal.json` | append the single 0032 entry |
| `workers/app/src/auth.ts` | custom Admin permission map, duration, active checks, lifecycle hooks |
| `workers/app/src/index.ts` | exact pre-wildcard start gate; leave stock stop on the existing auth wildcard |
| `workers/app/src/env.ts` | `SessionUser.impersonatedBy` |
| `workers/app/src/middleware/session.ts` | extract provenance and fail-close ongoing impersonation |
| `workers/app/src/lib/audit.ts` | `AuditPrincipal`, `auditMeta`, principal-aware audit writes |
| `workers/app/src/routes/users.ts` | explicit user projection, settings contracts, toggle audit |
| request audit call sites listed in §6.1 | pass principal and merge provenance in direct batches |
| affected server test fixtures/suites | map new columns/session shape and preserve existing auth behavior |

Implementation may update an already-existing test helper/fixture directly required by the new
schema or session type. It must not broaden product scope or change unrelated APIs.

## 9. Test plan

### 9.1 Confirmation tests

Affected component tests mock `confirm()` at module scope, not `window.confirm` and not the real
modal DOM. Use a hoisted `vi.fn(() => Promise.resolve(true))`, reset it between tests, and make
decline cases resolve false once. Preserve each suite's current accepted/declined side-effect and
call-count assertions. Where an old assertion checked a string, update it to the exact options
object in §2, including dynamic message, label, and danger.

`ConfirmDialog.dom.test.tsx` is the focused real-DOM suite. It must prove:

- all three stable `data-testid` selectors exist;
- title/message/custom/default labels render;
- initial focus is Cancel, Tab/Shift-Tab remain trapped, and focus returns to the trigger;
- Confirm resolves true; Cancel, Escape, and scrim resolve false exactly once;
- a panel click does not close;
- Escape does not also trigger an underlying document handler;
- danger applies `.button--danger`, non-danger does not; and
- two concurrent requests are shown and resolved FIFO without orphaned promises.

The existing affected suites retain their current scope. `ProjectCollaborationPanel` receives the
module mock for consistency; new delete-flow assertions are optional. The Lightbox suite must add
the accepted note-edit pointer rule from §2. While its module-mocked confirm promise is held
pending, `SubtaskChecklist.dom.test.tsx` must attach a synthetic `[data-confirm-modal-root]` portal
fixture, dispatch both `pointerdown` and `focusin` inside it, prove neither closes the action
popover, then settle false/true to prove Cancel preserves it and Confirm performs the existing
close/delete path.

### 9.2 Migration tests

`migration-0032.test.ts` applies the real migration chain from baseline and verifies:

- user columns, names, defaults, nullability, and existing-row `banned = 0` backfill;
- nullable `session.impersonated_by` and existing-row NULL behavior;
- exact `feature_flags` columns, boolean CHECK, FK action, index, singleton key, and OFF seed;
- invalid `enabled` values fail; deleting an updater sets `updated_by` NULL;
- foreign-key and quick-integrity checks pass; and
- Drizzle generation is empty after the committed migration/snapshot.

### 9.3 Auth, API, and audit integration tests

`workers/app/test/impersonation.test.ts`, using real migrated Miniflare D1 and Better Auth request
handling, must prove:

1. the setting defaults OFF and only `manageUsers` can read/change it;
2. malformed toggle bodies fail and each successful toggle has the exact audit row;
3. OFF returns the exact 403 contract before plugin session creation;
4. with the flag OFF and no impersonation in play, an active user's ordinary Google sign-in creates
   a session normally, while an inactive user's ordinary sign-in remains rejected; this proves the
   impersonation-only create-hook branch cannot gate normal authentication;
5. ON lets an active Admin impersonate an active Photographer and Editor;
6. inactive targets, self/Admin targets, and unknown targets fail;
7. `impersonate-admins` and every unrelated Admin-plugin action remain unauthorized;
8. target session storage has the original Admin ID in `impersonated_by` and expiry no later than
   one hour plus a small clock tolerance;
9. the signed-in user's own `/api/auth/get-session` and impersonate response may contain
   `banned`/`banReason`/`banExpires`, while `GET /api/users` excludes them from every cross-user
   directory row;
10. current-user/capability responses are the target's exact identity and role, and chained start
   is forbidden;
11. promoting the target from Photographer/Editor to Admin during impersonation makes the very next
   `/api` and `/media` requests fail closed; no Admin capability becomes usable through that
   target session;
12. turning OFF, deactivating, or demoting the original Admin blocks an existing impersonated
    session on both representative `/api` and `/media` requests;
13. revoking or deleting only the specific original session row — while the original Admin user
    itself remains active and capable — does NOT block the impersonated session, demonstrating the
    deliberate principal-level (not session-level) liveness design from §5.1. Calling stock
    stop-impersonating in that exact state must fail because Better Auth cannot resolve the saved
    original session; the failed attempt must leave the target session row intact and must not
    return or fabricate a success response;
14. deactivating the target mid-impersonation deletes its D1 session; a subsequent call to official
    stop-impersonating surfaces whatever error the stock plugin returns rather than crashing or
    fabricating a success response;
15. ordinary official stop-impersonating succeeds while the runtime flag is OFF, deleting the
    target session and restoring the original session normally;
16. start and official-stop lifecycle records have exact actor, target, action, and metadata; the
    documented best-effort consistency window from §6.2 is not represented as atomic in test
    expectations;
17. ordinary non-impersonated audit JSON/NULL behavior remains unchanged;
18. representative helper and direct-batch mutations always include
    `metaJson.impersonatedBy`, with the server value winning over caller metadata; and
19. the accepted author-only policy is explicit in executable coverage: normal Admin cannot edit
    the target author's annotation, acting as that author can, its audit actor is the target and
    metadata names the real Admin, while an unrelated author's record remains forbidden.

Existing auth tests must continue to prove inactive ordinary users cannot create or retain a
session. Existing users-route response tests must prove moderation compatibility columns are absent
from cross-user directory rows while accepting them as expected self-data in the session/impersonate
responses covered by item 9.

### 9.4 Web impersonation tests

`Admin.dom.test.tsx` covers OFF/ON switch rendering, PATCH reconciliation/failure, hidden controls
for Admin/self/inactive rows, visible controls for active Photographer/Editor rows, exact Act-as
confirmation options, decline, accept, API failure, and successful route replacement.

`ImpersonationBanner.dom.test.tsx` covers exact name/role copy, in-flight Exit disablement,
official stop success/navigation, the exact persistent manual-fallback message when official stop
fails, and ability to exit when other impersonated API calls are disabled. `App.dom.test.tsx`
proves the banner appears on multiple staff routes only when `session.impersonatedBy` is present
and the effective target identity changes the query-provider key. It must also mock a mid-session
target promotion so the session response is `{ impersonatedBy: <admin-id>, user.role: "admin" }`,
then prove the banner and Exit remain present, the exact invalidated-session message renders, and no
topbar, rail, ordinary route content, or Admin content/navigation is rendered.

## 10. Verification gates

From `portal/`, all of these are mandatory before the branch passes its acceptance gate:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Also run the focused migration, impersonation, modal, and all migrated component suites directly so
their output is visible rather than inferred from workspace aggregation. Run:

- execute the four-step §3.2 generation/replacement sequence and prove the second
  `drizzle-kit generate` produces no additional migration;
- `PRAGMA foreign_key_check;` and `PRAGMA quick_check;` after a full local migration replay;
- a source search proving sixteen old calls and all global-confirm test stubs are gone;
- a source search proving zero `window.alert` calls remain;
- a source search for both `INSERT INTO audit_log` and `schema.auditLog`, enumerating every raw-SQL
  or Drizzle direct insertion and confirming each request-owned path uses `auditMeta`;
- a source search proving `impersonate-admins` appears only in the denied/configuration/test
  vocabulary and is never granted; and
- `git diff --check` plus a review that no generated cache, local secret, recovery export, or
  unrelated file is included.

The implementation then follows the repository pipeline: Sol review (maximum two passes), Opus
plan/diff review where scheduled by `Subagent-Orchestration.md`, Luna build, independent diff
review, human checkpoint, and deploy. Use one branch, one combined acceptance gate, and one deploy.
The branch may contain either one commit or two sequential commits—confirmation modal first, then
impersonation. With two commits, run the Sol diff review as two scoped passes on the same branch,
first over the modal commit and then over the impersonation commit, so the security-critical diff
is not buried in the mechanical call-site migration. A reviewer must reject an implementation that
replaces the official session mechanism, relies only on UI hiding, leaves an audit side path without
provenance, or separates the features into different branches, acceptance gates, or deployments;
the permitted sequential commit boundary is not such a split.

## 11. Manual QA

### 11.1 Local modal QA

At `http://localhost:8787` with the human-signed-in seeded Admin:

1. Exercise every reachable migrated guard; verify copy, button label, danger treatment, Cancel,
   Confirm, Escape, backdrop, focus return, and unchanged side effects. Verify Tab and Shift-Tab
   cycle only between Cancel and Confirm (this specific property is a real-browser check — jsdom
   cannot simulate native Tab-key focus traversal, so it isn't covered by an automated DOM test).
2. Specifically verify the Subtask popover remains open after Cancel.
3. Verify Lightbox Escape closes only the modal, not the viewer; accepted note-edit discard requires
   a fresh drawing gesture.
4. With Lightbox open, exercise one migrated confirm in ordinary viewer mode and one while
   `.viewer--compare` mode is active; verify the scrim and panel render above the viewer and
   impersonation banner, and both confirmation buttons remain visible and clickable.
5. Use browser automation to locate and click the three exact test IDs, proving the original
   automation problem is removed.
6. Verify there is no native browser confirmation UI.

### 11.2 Local impersonation QA

1. Confirm the setting is OFF and no Act-as actions show.
2. Enable it; verify only active Photographer/Editor targets appear.
3. Cancel one Act-as modal, then accept one.
4. Verify target route visibility/capabilities, fixed banner, author-owned action behavior, audit
   actor/provenance, and lack of Admin navigation.
5. Turn the flag OFF from another authenticated Admin browser profile/session; verify target API
   actions fail while banner Exit succeeds.
6. While impersonating, open Lightbox and then activate `.viewer--compare` mode in a second visual
   check. Verify the same fixed `.viewer` starts below the complete 42px banner in both modes, its
   close/top controls remain correctly positioned, the identity text stays visible, and Exit
   remains clickable.
7. Re-enable and impersonate again, then use a separate human-authenticated Admin browser profile
   to deactivate the target before clicking Exit. Verify stock Exit shows exactly `Could not
   automatically exit. Sign out completely and sign back in as Admin to restore your session.`
   Complete the existing full Sign out flow, sign back in through Google as Admin, and verify normal
   Admin identity/capabilities are restored. If invalidation has already rendered `SignIn`, complete
   the same sign-in fallback there and verify the same result.
8. Reactivate the target if needed, complete one normal official Exit, verify there is no identity
   chain, and turn the feature flag OFF.

Do not ask Luna to sign in with Google. Follow the existing browser-QA handoff rule if the required
authenticated session is absent.

## 12. Production rollout, policy, and rollback

### 12.1 Rollout

This combined unit changes D1 and the app Worker only. Background and webhook-ingress have no code
or binding change. Nevertheless record their unchanged state and follow the repository's deploy
discipline.

1. Human checkpoint: approve migration, exact production target, documented manual fallback, and a
   narrowly defined impersonation smoke window. The approved smoke action list must be chosen with
   the outbound-notification side effect below in view.
2. Record current app Worker version and Git commit.
3. Run the remote migration preflight and save a fresh D1 recovery export in the parent
   `db-recovery/` workspace; do not add it to this repo.
4. Apply migration 0032 remotely and verify migration ledger, columns, feature row OFF,
   `foreign_key_check`, and representative row counts.
5. Deploy the app Worker only after migration success.
6. While the flag remains OFF, first complete this blocking auth check: verify an active,
   non-impersonating user can complete ordinary Google sign-in and receive a normal session. Then
   smoke the Admin directory, representative mutations, audit rows, client links, and several
   real-DOM confirmation Cancel paths.
7. Under explicit human authorization, enable the flag, impersonate one approved active non-Admin,
   perform only the pre-approved reversible/full-write smoke actions, inspect lifecycle/domain audit
   provenance, Exit, and immediately disable the flag.
8. Prove `feature_flags.enabled = 0` and no live `session.impersonated_by IS NOT NULL` rows remain.

**Notification side effects are real and are not reversible.** `EMAIL_ENABLED_EVENTS` in
`packages/db/src/notifications.ts` covers `raw_ready`, `edited_landed`, `sent_to_editing`,
`autohdr_stalled`, `delivered`, `comment_added`, `assigned_to_project`, `mentioned`,
`subtask_assigned`, and `subtask_due_today`, so most impersonated full-write actions send real staff
email: `routes/annotations.ts` (`comment_added`), `routes/notice-board.ts` (`mentioned`),
`routes/project-subtasks.ts` (`subtask_assigned`), `routes/projects.ts` (`assigned_to_project`,
`delivered`), and `lib/project-comments.ts`'s TB4 `notification_outbox` rows. Those notifications
carry `actor_id` = the impersonated target and no impersonation marker; provenance lives only in
`audit_log`. The step-1 human checkpoint must therefore either pick smoke actions that emit no
notification, or explicitly pre-authorize the resulting real email and name its recipients. This
plan adds no impersonation awareness to notification emission.

If Exit fails during step 7, immediately turn the flag OFF, retry the stock Exit once, and use the
documented full sign-out/sign-in fallback if it still fails. Before continuing or declaring the
smoke complete, rerun the live-session query in §12.2 and prove no live impersonated row remains.

`Subagent-Orchestration.md` §2.9 is unchanged: danger-mode Luna's standing production work remains
passive verification only. This feature removes identity/session coordination friction but does not
authorize an agent to mutate production. A human may explicitly authorize a bounded testing window;
within such authorization, full impersonation mutations are intentionally real. The code-level
security boundary is the runtime gate, not an automation-agent detector.

### 12.2 Rollback

The immediate kill switch is `feature_flags.user_impersonation = 0`. Before rolling the app Worker
back to a version that does not understand impersonation, verify:

```sql
SELECT enabled FROM feature_flags WHERE key = 'user_impersonation';
SELECT COUNT(*) AS live_impersonated_sessions
FROM session
WHERE impersonated_by IS NOT NULL
  AND expires_at > unixepoch('now') * 1000;
SELECT COUNT(*) AS expired_impersonated_sessions
FROM session
WHERE impersonated_by IS NOT NULL
  AND expires_at <= unixepoch('now') * 1000;
```

The flag and live-session count must both be 0. The expired count is informational and does not
block rollback. If live sessions remain, use Exit while the new app is live, or fall back to the
documented manual sign-out/sign-in plus a directly approved targeted session-row deletion; do not
roll back first and leave a live target session looking ordinary to old code. Then restore the
recorded app Worker version.

Because both features deploy together, a regression traced to either confirmation handling or
impersonation requires rolling back the whole combined unit, including the feature that remains
healthy. This is the accepted operational cost of the one-deploy decision.

Migration 0032 is additive and stays applied during code rollback. Do not edit the migration ledger,
drop compatibility columns/tables, or rebuild D1 during an incident. Restore from the recorded
recovery export only for confirmed data corruption under a separate human-approved recovery plan.

## 13. Acceptance checklist

### Confirmation modal

- [x] One global, provider-free, FIFO promise host is mounted once and no promise can be orphaned.
- [x] Generic Modal uses existing Quincy classes, portal rendering, dialog semantics, focus trap,
      safe initial focus, focus return, Escape/backdrop close, and event isolation.
- [x] Confirm panel and both buttons expose the three exact stable test IDs.
- [x] `.button--danger` uses the critical token and only approved destructive/discard actions use it.
- [x] All sixteen listed calls use the exact titles/messages/labels/danger choices in §2.
- [x] Permanent project deletion retains both street-name and modal guards.
- [x] Both pointer-down and focus-in inside the confirm portal preserve the Subtask popover until
      choice; Cancel preserves it and Confirm follows the existing close/delete path.
- [x] `.scrim` remains z-index 90, and a confirm panel is visible and operable above `.viewer`
      (including `.viewer--compare` mode) and the impersonation banner.
- [x] No production `window.confirm`, bare global confirm, or `window.alert` remains in web source.
- [x] Existing affected tests mock the module; focused real-DOM tests cover modal behavior.

### Impersonation schema and server

- [x] The actual build-start journal was rechecked; migration number/tag were adjusted only if
      necessary and remain unique/sequential.
- [x] Migration is additive, seeds OFF, passes integrity tests, and has matching schema/snapshot.
- [x] Migration generation follows schema update → named initial generation → reviewed SQL-body
      replacement → second empty-diff generation, with one snapshot/journal/SQL artifact set.
- [x] Plugin compatibility columns exist, while `active` remains Quincy's account-status authority.
- [x] The official server/client Admin plugin is used with a one-hour duration.
- [x] Admin grants exactly `impersonate`, never `impersonate-admins` or unrelated plugin actions.
- [x] Runtime OFF blocks start and all ongoing target `/api`/`/media` work but never blocks Exit.
- [x] With the runtime flag OFF, ordinary sign-in still creates a session for an active user and
      still rejects an inactive user; the impersonation create-hook branch does not gate normal auth.
- [x] Every target request revalidates the target's active/current Photographer-or-Editor role and
      the original Admin's active/capability state (principal-level, not session-level).
- [x] Target promotion to Admin fails closed before any Admin capability can be exercised.
- [x] Official stop-impersonating uses the stock Better Auth mechanism only; when it cannot resolve
      a required session, Exit fails visibly with the documented manual-recovery message rather than
      silently succeeding or crashing.
- [x] Exit failure shows the documented manual-recovery message; there is no automatic recovery
      path, cookie parser, recovery marker, or custom restoration endpoint.
- [x] Settings GET/PATCH are `manageUsers`-gated, strict, fail closed, and audit every change.
- [x] Both static settings routes are registered before `PATCH /users/:id` and are not captured as
      a dynamic user ID.
- [x] User-directory responses explicitly exclude plugin moderation fields.

### Audit and accepted policy exception

- [x] Start has its exact lifecycle record, and official stop has its exact record when endpoint
      context resolves, with real Admin actor and target metadata; the documented stop null-context
      omission and pre-hook phantom/duplicate window are treated as best-effort, not atomic.
- [x] Every request-owned audit path, including direct D1 batches, gets immutable
      `metaJson.impersonatedBy` while impersonating.
- [x] Normal/system audit semantics are unchanged and callers cannot spoof provenance.
- [x] No author-only guard is made impersonation-aware; acting as X can perform X's author actions,
      cannot perform unrelated Y's, and tests document both outcomes.
- [x] The author-only impersonation exception and manual-Exit limitation are recorded in the
      durable documents required by §14, and all three named enforcement modules carry the required
      one-line deliberate-bypass comment.

### UI, verification, and operations

- [x] Settings switch and Act-as filtering/copy work exactly as specified.
- [x] Fixed banner appears on every staff screen; Exit restores the live Admin session when
      possible, or shows the documented manual sign-out/sign-in fallback message when the stock
      mechanism cannot resolve it.
- [x] An impersonated session whose live role is no longer Photographer/Editor renders banner/Exit
      plus only the invalidated-session message—no ordinary or Admin navigation/content.
- [x] The standalone invalidated-session surface has its own 42px banner offset and never renders
      underneath the fixed banner.
- [x] During impersonation, `.viewer`—including its `.viewer--compare` mode—begins below the 42px
      banner; identity/Exit and the viewer's own top controls are simultaneously visible and usable.
- [x] Layout remains usable at desktop/mobile widths and modal/toast stacking remains correct.
- [x] Typecheck, web build, all workspace/shared/focused tests, migration replay, and searches pass.
- [x] Recovery export, migration evidence, Worker version, smoke evidence, and final OFF/no-live-
      impersonation checks are recorded.
- [x] The features share one branch, one acceptance gate, and one deploy; the branch has one commit
      or the permitted modal-then-impersonation pair with two scoped Sol diff-review passes.
- [x] The production smoke's approved action list accounted for real outbound notification email;
      no unannounced staff notification was sent from an impersonated identity.
- [x] Production smoke respects the unchanged agent-automation policy.

## 14. Completion and documentation handoff

After implementation, verification, one or two permitted commits, migration, deployment, and
accepted smoke testing:

1. update this status line with the one commit hash or both sequential commit hashes, app Worker
   version, migration result, smoke evidence, and rollback target;
2. update `docs/todo.md` with the delivered combined unit and an explicit durable line naming both
   accepted limitations: acting as X deliberately reaches X's author-only actions, and an
   out-of-band session invalidation has no automatic Exit recovery and may require full
   sign-out/sign-in. State that both alternatives were considered and deliberately rejected for
   this tool, and point to
   `docs/plans/implemented/Confirmation-Modal-And-Admin-Impersonation-Plan.md`;
3. update the root `CLAUDE.md` and its verbatim `AGENTS.md` mirror: advance the migration ledger from
   0031 to 0032, and amend the author-only annotation gotcha to name impersonation as the one
   deliberate exception and cite
   `docs/plans/implemented/Confirmation-Modal-And-Admin-Impersonation-Plan.md`. Add the same caveat
   and archived-plan pointer wherever `docs/PRD.md` and `docs/todo.md` restate the author-only rule;
4. add a one-line comment at each reached enforcement point—author-only guards in
   `workers/app/src/routes/annotations.ts`, author-only guards in
   `workers/app/src/routes/notice-board.ts`, and both the edit and delete guards in
   `workers/app/src/routes/project-comments.ts`—stating that an impersonated Admin intentionally
   acts as the effective author and pointing to the caveat in `CLAUDE.md`;
5. add a `docs/lessons.md` entry only for a new reusable auth/modal/D1 lesson actually discovered;
6. move this file with `git mv` to `docs/plans/implemented/`; and
7. keep the feature flag OFF after the authorized testing window unless the human explicitly opens
   another one.

All seven items above are now true: `docs/todo.md`, `CLAUDE.md`/`AGENTS.md` (migration ledger and
author-only caveat), `docs/PRD.md`'s restatement, and the three enforcement-point code comments are
all updated; a new `docs/lessons.md` entry captures the Hono trailing-slash gate-bypass finding
from final-draft review; this file has been moved to `docs/plans/implemented/`; and the feature
flag was disabled after the smoke window, confirmed by zero live `session.impersonated_by IS NOT
NULL` rows in production.
