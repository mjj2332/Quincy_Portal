# Plan (deferred, reference-only): general-purpose multi-role staff identity

> **Status:** DRAFTED, NOT IMPLEMENTED, NOT SCHEDULED. Written 2026-07-25 in response to a
> real question ("can a photographer also be an editor without admin rights?"), but the
> immediate need is already solved with **zero code changes** — see "Immediate action" at the
> bottom. This document exists so the proper fix doesn't need to be re-derived if the
> workaround's tradeoffs ever become a real problem. Produced via Claude Explore + Plan
> subagents reading this repository directly, with file:line citations independently
> re-verified against the live source before being accepted.

## Context

A staff member at the studio sometimes acts as both a photographer and an editor on
different shoots. `portal`'s authorization model gives every `user` exactly **one** role
(`admin | photographer | editor`, a single column, `packages/db/src/schema.ts:27-29`), so
there was no way to grant that person both sets of capabilities without either (a) making
them a full admin — more access than needed — or (b) picking one role and losing the other's
capabilities.

**Finding that changes the urgency:** `editor`'s capability set
(`packages/shared/src/capabilities.ts:70-86`) is already a strict superset of `photographer`'s
(`capabilities.ts:87-93`) — every capability a photographer has, an editor also has. So the
immediate need is already resolved with zero code changes: set that staff member's `role` to
`"editor"` in the Admin panel. **Accepted as the answer for now.**

That workaround has two known tradeoffs, accepted for now:
- Editor has blanket `viewAllProjects`, so this person will see **all** projects, not just
  their assigned shoots (photographer is normally scoped to assigned-projects-only, per
  Decision-Sheet D-02).
- `routes/review.ts:81` has a hardcoded `user.role === "photographer"` restriction
  ("photographers may only set `recommended`") that no longer applies to this person once
  their role is `"editor"` — not a capability loss, just a removed restriction.

This plan is the proper fix for later: a general-purpose many-to-many role model so a user can
hold **any** combination of `admin`/`photographer`/`editor`, not just this one pairing —
chosen over a narrow "photographer+editor" special case because the schema change is the same
shape/effort but reusable for future role combinations.

All file:line citations below were verified directly against the repo (migrations 0000–0014
applied, next available **0015**, confirmed via `packages/db/migrations/meta/_journal.json`).

---

## 1. Data model

Add a `user_roles` join table to `portal/packages/db/src/schema.ts`, mirroring the existing
multi-role precedent already in the schema — `project_members` (`schema.ts:170-187`) already
proves the "same user, two rows, compound unique index" pattern, just scoped per-project
rather than globally:

```ts
export const userRoles = sqliteTable(
  "user_roles",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "photographer", "editor"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("user_roles_unique").on(t.userId, t.role),
    index("user_roles_user_idx").on(t.userId),
  ],
);
```

Do **not** reuse `project_members` itself — its `roleOnProject` enum answers "what does this
person do on this shoot" (a per-project assignment question), a different question from "what
is this person's global identity."

**Migration 0015** (`packages/db/migrations/`, generate via `npx drizzle-kit generate` from
`portal/packages/db`): create `user_roles` + its two indexes, then backfill one row per
existing user from their current `user.role` value. Check `0009_legacy_manual_edited_recovery.sql`
/ `0010_retire_legacy_manual_edited_recovery.sql` for this repo's house style of
data-migrating (not pure-DDL) migrations before finalizing the backfill SQL. **Do not drop
`user.role` in this migration** — it's purely additive and safe to apply to prod independent
of any code deploy.

**Keep `user.role` only as a short-lived bridge, not permanently.** This is a closed internal
staff system (one API, one frontend), not a public API with independent external consumers of
`role` — no need for a long dual-read/dual-write window. Ship the full application cutover
(schema → shared → API → frontend, §7) as one coordinated release that stops reading
`user.role` entirely. After a burn-in period, ship **migration 0016**:
`ALTER TABLE user DROP COLUMN role;` and remove `role` from `schema.ts`'s `user` table and
from better-auth's `additionalFields` (`workers/app/src/auth.ts:17`). Permanently keeping
`user.role` as an auto-synced "primary role" column was considered and rejected — it's a
second source of truth that must be kept in sync on every role change, for no benefit once
every call site reads `roles: Role[]`.

**`annotations.authorRole` / `comments.authorRole`** (`schema.ts:636`, `:659`) stay
single-valued by design — they snapshot "what role was this specific action taken under," a
historical fact, not current identity. Add a precedence helper in `@quincy/shared`:

```ts
const ROLE_PRECEDENCE: readonly Role[] = ["admin", "editor", "photographer"];
export function primaryRole(roles: readonly Role[]): Role {
  return ROLE_PRECEDENCE.find((r) => roles.includes(r)) ?? roles[0]!;
}
```

Use `primaryRole(c.get("user").roles)` at the two annotation/comment insert sites
(`workers/app/src/routes/annotations.ts:106,127`) in place of `c.get("user").role`. Never use
`primaryRole` for an actual authorization decision — only for this kind of historical
snapshot.

---

## 2. Capability resolution

In `packages/shared/src/capabilities.ts`, add set-based resolvers alongside the existing
single-role ones (keep `ROLES`, `Role`, `CAPABILITIES`, `Capability`, `ROLE_CAPABILITIES`,
`roleHasCapability` unchanged — still needed for the sole-role checks in §4):

```ts
export function capabilitiesForRoles(roles: readonly Role[]): Set<Capability> {
  const capabilities = new Set<Capability>();
  for (const role of roles) for (const capability of ROLE_CAPABILITIES[role]) capabilities.add(capability);
  return capabilities;
}

export function rolesHaveCapability(roles: readonly Role[], capability: Capability): boolean {
  return roles.some((role) => roleHasCapability(role, capability));
}
```

`rolesHaveCapability` replaces `roleHasCapability(user.role, cap)` at nearly every call site.
`capabilitiesForRoles` is for the two places that spread the whole capability array (`/api/me`
in `workers/app/src/index.ts:46`, and the frontend's `useCapabilities()`).

---

## 3. Project-scoping semantics — decision

`hasProjectAccess` (`workers/app/src/middleware/capability.ts:18-23`) currently returns `true`
outright if the role grants `viewAllProjects`, else checks `project_members` for a bare row.

**Decision: capability union wins.** If *any* held role grants `viewAllProjects`, the user
sees all projects — `if (rolesHaveCapability(user.roles, "viewAllProjects")) return true;`,
else fall through to the existing membership check unchanged. This is the only interpretation
consistent with "roles are additive, never subtractive": a photographer+editor person
legitimately needs `viewAllProjects` for the editor half of their job — that's not a bug to
work around, it's the same behavior editor grants editor-only staff today. If a future need
arises for "let this person edit but still restrict them to assigned projects," that's a
distinct, narrower feature (a per-project visibility override) — explicitly out of scope
here, not to be smuggled into the base multi-role model as a special case.

---

## 4. Call sites to update

Verified by grep across `workers/app/src` and `apps/web/src` for `.role` (excluding
`roleOnProject`/`authorRole`, out of scope per §1/§3). This list is larger than the handful of
routes originally suspected — flagging that up front since it changes the size of the change.

**Most sites are a straightforward swap:** `roleHasCapability(user.role, cap)` /
`ROLE_CAPABILITIES[user.role].includes(cap)` → `rolesHaveCapability(user.roles, cap)`:
- `workers/app/src/routes/review.ts` (lines 28-30, 84)
- `workers/app/src/routes/media.ts` (line 103)
- `workers/app/src/routes/projects.ts` (lines 123, 147, 200, 219, 341, 407, 436, 481, 483)
- `workers/app/src/routes/uploads.ts` (lines 36, 55, 65)
- `workers/app/src/routes/collections.ts` (lines 35-38, 148)
- `workers/app/src/routes/admin.ts` (line 24)
- `workers/app/src/routes/annotations.ts` (lines 45, 52)
- `workers/app/src/middleware/capability.ts` (`requireCapability`, and `hasProjectAccess` per §3)

**Sites needing a genuinely different rule** (hardcoded restrictions, not capability grants —
apply the restriction only when the role in question is the person's *sole* held role, so a
photographer+editor person is correctly *not* restricted, matching what `role="editor"`
already does for them today but without losing the restriction for genuinely photographer-only
staff):
- `routes/review.ts:81` — `user.role === "photographer"` → `user.roles.length === 1 && user.roles[0] === "photographer"`.
- `routes/review.ts:83` — `!["admin","editor"].includes(user.role)` → `!user.roles.some((r) => r === "admin" || r === "editor")`.
- `routes/media.ts:31` — same sole-role rule for the "photographers may only view RAW" check, and the same `admin`/`editor` array-includes swap.
- `routes/projects.ts:126,131,496` — `user.role === "photographer"` (dashboard filtering / RAW-only cover visibility, a display concern) → same sole-role rule for consistency.

**Signature changes** (functions that take a single role purely to check `adminBackend`):
- `routes/stages.ts:8` `isAdminBackend(role)` → takes `roles: Role[]`, body becomes `rolesHaveCapability(roles, "adminBackend")`.
- `routes/stages.ts:26,33` `projectStageForRole`/`stagesForRole` → param renamed to `roles: Role[]`; update call sites in `projects.ts:110,141,194` and `stages.ts:48`.

**API contract** — `routes/users.ts:12-13`: `role: z.enum(ROLES)` → `roles: z.array(z.enum(ROLES)).min(1)` on both create and (via `.partial()`) patch schemas. `POST /users` inserts the `user` row, then bulk-inserts `user_roles` rows in the same batch; audit payload becomes `{ email, roles }`. `PATCH /users/:id` replaces `user_roles` rows (delete-then-insert) when `roles` is present. `GET /users` needs a second query (or `group_concat`) to attach each user's `roles: Role[]` — given this list is staff-only and small, an in-memory group-by after two queries is simplest and matches this codebase's existing preference (e.g. tie-breaking done in JS in `projects.ts` rather than SQL).

**`env.ts`**: `SessionUser` becomes `{ id, email, name, roles: Role[], active }` (drop scalar `role`).

**`middleware/session.ts`** (`requireSession`): validate `roles` is a non-empty array of valid `Role` values instead of a single string.

**`Lightbox.tsx`** (`apps/web/src/components/`) — reads `author.role` from annotation/comment API responses. **No change needed**: this is the `authorRole` historical snapshot (§1), which stays a single string by design. Flagged only because it superficially matches a `.role` grep.

---

## 5. Auth/session shape

better-auth's `additionalFields` (`auth.ts:17`, currently used for `role`) maps 1:1 onto
scalar `user` columns — it cannot represent a value from a separate join table. Use
better-auth's **`customSession` plugin** instead (confirmed available:
`better-auth@1.6.23`, `node_modules/better-auth/dist/plugins/custom-session`):

```ts
plugins: [
  customSession(async ({ user, session }) => {
    const roleRows = await db.select({ role: schema.userRoles.role }).from(schema.userRoles).where(eq(schema.userRoles.userId, user.id)).all();
    return { user: { ...user, roles: roleRows.map((r) => r.role) }, session };
  }),
],
```

This single change enriches both `auth.api.getSession()` (server-side, used by
`getSession()`/`requireSession`) **and** the frontend's `authClient.useSession()` — both hit
the same `/api/auth/get-session` endpoint this plugin overrides. Note: `/api/me`
(`index.ts:46`) is currently **unused by the frontend** (no references under `apps/web/src`)
— the session object itself already drives `useCapabilities()`, so fixing the session at the
source fixes everything without a second round trip.

Drop `role` from `additionalFields` once this lands. Skip better-auth's `customSessionClient`
typing plugin — it'd require a new cross-package type import from `workers/app` into
`apps/web` that doesn't exist today; keep the existing pattern of a manually-declared,
runtime-validated session-user type in `apps/web/src/lib/capabilities.ts` (extend the current
`isRole` guard to `isRoleArray`).

---

## 6. Frontend

- **`apps/web/src/lib/capabilities.ts`**: rewrite `useCapabilities()` to read
  `session.data.user.roles` (validated via `isRoleArray`) and compute capabilities via
  `capabilitiesForRoles(roles)`. None of the current call sites destructure a singular
  `role` from this hook's return — safe to drop it entirely.
- **`apps/web/src/screens/Admin.tsx`**: `User.role: Role` → `User.roles: Role[]`. Replace the
  single `<select>` at both the create-user form (~line 300) and the per-user row (~line 310)
  with a **checkbox group** over `ROLES` — reuse the existing
  `.create-project__checklist`/`.create-project__check` CSS classes already used for the
  photographer/editor staff-picker in `components/ProjectFields.tsx:107`, rather than
  introducing a new multi-select widget. `updateUser`/create-submit send `{ roles }`.
- **`apps/web/src/components/ProjectFields.tsx`**: `User.role: Role` → `User.roles: Role[]`.
  The photographer/editor staff-picker filters (line ~74-75:
  `user.role === "photographer" || user.role === "admin"`, etc.) become
  `user.roles.includes("photographer") || user.roles.includes("admin")` (and similarly for
  editor). The inline admin badge (~line 107) becomes `user.roles.includes("admin")`.

---

## 7. Rollout order

1. **Migration 0015** (additive: `user_roles` + backfill) — safe to apply to prod immediately,
   independent of any code deploy.
2. **`@quincy/shared`**: add `capabilitiesForRoles`, `rolesHaveCapability`, `primaryRole`,
   keeping old exports. Zero consumers yet — safe alone. Verify with
   `npx tsc -p packages/shared/tsconfig.json` and
   `npx vitest run --config packages/shared/vitest.config.ts`.
3. **`workers/app`**: `auth.ts` (customSession plugin), `env.ts`, `middleware/session.ts`,
   `middleware/capability.ts`, all routes in §4, `routes/users.ts` contract change — one
   coordinated deploy (a partial cutover would leave some routes reading `user.roles` while
   others still expect `user.role`). Verify with `npx tsc -p workers/app/tsconfig.json` and
   `npx vitest run --config workers/app/vitest.config.ts`.
4. **`apps/web`**: `lib/capabilities.ts`, `Admin.tsx`, `ProjectFields.tsx` — depends on step 3
   being live (session payload must already contain `roles`). In practice this repo already
   deploys `workers/app` serving the built SPA via its `ASSETS` binding, so steps 3–4 are
   naturally one deploy; confirm via `npm run build -w @quincy/web` before treating them as
   separable. Verify with `npx tsc -p apps/web/tsconfig.json` and
   `npm run build -w @quincy/web`.
5. **Burn-in period** in production (spot-check `audit_log` for `user.update`/`user.provision`
   entries with the new `roles` shape).
6. **Migration 0016** (only after burn-in, deliberately last since it's the one irreversible
   step): `ALTER TABLE user DROP COLUMN role;`, remove `role` from `schema.ts`'s `user` table.

---

## 8. Verification plan (when this is eventually built)

Per this repo's standard build/verify bar (`CLAUDE.md`), run from `portal/`:

- **Typecheck** every touched workspace: `packages/shared`, `packages/db`, `workers/app`, `apps/web`.
- **Tests** — extend `packages/shared/test/capabilities.test.ts` with:
  - `capabilitiesForRoles(["photographer","editor"])` equals `new Set(ROLE_CAPABILITIES.editor)` (documents/guards the superset relationship this whole workaround-vs-proper-fix analysis depends on).
  - `capabilitiesForRoles(["photographer","admin"])` includes `adminBackend` plus all of photographer's.
  - `rolesHaveCapability(["photographer"], "viewAllProjects")` is `false`; with `["photographer","editor"]` it's `true`.
  - `primaryRole(["photographer","editor"])` → `"editor"`; `primaryRole(["admin","editor","photographer"])` → `"admin"`.
  - Extend `workers/app/test/api.test.ts` (which seeds users via raw SQL, e.g. `api.test.ts:141,155-156,168,758`) with a `seedUserRoles(db, userId, roles)` helper and cases: a `["photographer","editor"]` user gets `viewAllProjects`-equivalent access to a project they're not a `project_members` row on (§3); the same user is *not* restricted to `recommended`-only on review PATCH while a photographer-only user still is (§4); `GET/POST/PATCH /api/users` round-trip `roles: Role[]` correctly including the `min(1)` empty-array rejection; annotations/comments still write a single `authorRole` via `primaryRole`.
- **Build:** `npm run build -w @quincy/web`.

---

### Critical files

- `portal/packages/db/src/schema.ts` — new `user_roles` table; eventual removal of `user.role`
- `portal/packages/shared/src/capabilities.ts` — `capabilitiesForRoles`, `rolesHaveCapability`, `primaryRole`
- `portal/workers/app/src/auth.ts` — `customSession` plugin wiring
- `portal/workers/app/src/middleware/capability.ts` — union-based `requireCapability`/`hasProjectAccess`
- `portal/workers/app/src/routes/projects.ts` — largest concentration of call sites (14 locations)
- `portal/apps/web/src/screens/Admin.tsx`, `portal/apps/web/src/components/ProjectFields.tsx` — UI

---

## Immediate action (already taken care of, not part of this plan's build)

No code changes now. In the Admin panel, set the dual-role staff member's `role` to
`"editor"`. Accept the two tradeoffs noted in Context until/unless they become a real
problem, at which point this plan is ready to execute.
