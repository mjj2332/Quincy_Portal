# Photographer Stage-Visibility Restriction — Plan

**Status: BUILT and verified (2026-07-28).** Plan approved by Terra (round 4, max effort). Built
by Terra (max effort, security/auth routing); independent verification in this session found and
fixed two real bugs the build's own sandbox couldn't catch (Miniflare integration tests don't run
there) — a pre-existing 404-vs-403 inconsistency on `dropbox-sync` the new stage gate made
reachable for the first time, and a pre-existing test asserting the old, now-intentionally-changed
photographer-visibility behavior. Terra diff review (fresh context, max effort) **APPROVED**. Full
verify sequence green. §5's blanket-cutoff design was an explicit approval checkpoint the user
confirmed before this build, not inferred from silence. **Committed (`57f87a6`) and deployed to
production (2026-07-28)** — `workers/app` only (the only worker touching `hasProjectAccess`/the
dashboard query), no migration needed. Post-deploy smoke: site loads (200), unauthenticated API
route correctly 401. Full manual smoke (photographer account losing dashboard visibility/getting
403 on direct navigation once a project passes `raw_review`) not yet run against a real staff
account.

User request: double-confirm that photographers can only see their assigned projects while
those projects are in `awaiting_raw`/`raw_review`, and cannot see them once they've progressed
further — implement it if it's missing.

## Pre-build verification: this was NOT implemented — confirmed by direct read

- **Decision-Sheet D-02** (`docs/Decision-Sheet.md:18`) decided photographer access as "assigned
  projects only, **RAW-only**" — a restriction on *which media kind* they can view (RAW, never
  Edited), not on *which pipeline stage* their assigned project is currently in. This is enforced
  today at `media.ts:31` (`row.collectionKind !== "raw" && user.role === "photographer"` → 403)
  and `coverMaps`'s `photographersOnlySeeRaw` flag (`projects.ts:59-66,136`) — both are data-kind
  filters, confirmed by direct read, not a stage gate.
- **The dashboard project list applies no stage filter for photographers.**
  `GET /projects` (`projects.ts:126-138`):
  ```ts
  const rows = user.role === "photographer"
    ? await base.where(and(archivedFilter, exists(db.select({ id: schema.projectMembers.id }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, user.id)))))).orderBy(...).all()
    : await base.where(archivedFilter).orderBy(...).all();
  ```
  The `photographer` branch filters only by `project_members` membership and archived status —
  **no `stageKey` condition**. A photographer's assigned project remains visible in their
  dashboard at every stage — `awaiting_raw` through `delivered` — today.
- **`hasProjectAccess`** (`middleware/capability.ts:18-23`), the single universal access gate used
  by every project/asset/media/upload/collection/annotation/review route in this codebase
  (confirmed by grep across all six route files that call it — `projects.ts`, `media.ts`,
  `uploads.ts`, `collections.ts`, `annotations.ts`, and `review.ts:26,79,89,91`, missed in the
  original count and added per Terra round 1 — 40 calls total across those six files), checks
  only `viewAllProjects` capability or bare `project_members` membership — again, no stage
  condition. A photographer can open `/projects/:id` (`projects.ts:599-605`), view (RAW) assets,
  comment/annotate, and use `review.ts`'s recommend/select-for-editing actions on their assigned
  project regardless of its current stage, today.
- **Conclusion: this is a real gap against the request, not a misunderstanding of existing
  behavior** — building it is in scope, not just confirming it.

## Design

### 1. Shared constant (`packages/shared/src/stages.ts`)

```ts
/** Stages a photographer's assigned project remains visible in. Beyond this, they lose all
 *  access to that project — not just Edited-media visibility (see D-02), the project itself. */
export const PHOTOGRAPHER_VISIBLE_STAGES: readonly StageKey[] = ["awaiting_raw", "raw_review"];
```

Defined once, next to `STAGE_KEYS`/`STAGE_TRANSITIONS` (`stages.ts:8-38`) so both the backend
enforcement point and its tests reference the same list — not duplicated as inline string
literals at each call site.

### 2. Single enforcement point: `hasProjectAccess`

```ts
// middleware/capability.ts
export async function hasProjectAccess(c, projectId) {
  const user = c.get("user");
  if (roleHasCapability(user.role, "viewAllProjects")) return true;
  const db = createDb(c.env.DB);
  const member = await db.select({ id: schema.projectMembers.id }).from(schema.projectMembers)
    .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, user.id))).get();
  if (!member) return false;
  if (user.role === "photographer") {
    const project = await db.select({ stageKey: schema.projects.stageKey }).from(schema.projects)
      .where(eq(schema.projects.id, projectId)).get();
    return Boolean(project && (PHOTOGRAPHER_VISIBLE_STAGES as readonly string[]).includes(project.stageKey));
  }
  return true;
}
```

Because every route that gates on project access already calls this one function (confirmed
above), this single change automatically extends the restriction to every existing route — no
per-route edits needed anywhere else. This mirrors exactly how `Multi-Role-Staff-Identity-Plan.md`
already characterized `hasProjectAccess` as "the join to reuse," and the `Notifications-Plan.md`
recipient computation reuses the same reasoning.

The extra `projects` query only runs for `photographer`-role requests (admin/editor still return
on the first check via `viewAllProjects`), so no added cost for the two roles this doesn't apply
to.

### 3. Dashboard list filter (`GET /projects`, `projects.ts:126-138`)

The list route does its own inline membership check (not a call to `hasProjectAccess`, to avoid
an N+1 per-row access check) — needs the matching stage filter added directly:

```ts
const rows = user.role === "photographer"
  ? await base.where(and(
      archivedFilter,
      exists(db.select({ id: schema.projectMembers.id }).from(schema.projectMembers).where(and(eq(schema.projectMembers.projectId, schema.projects.id), eq(schema.projectMembers.userId, user.id)))),
      inArray(schema.projects.stageKey, PHOTOGRAPHER_VISIBLE_STAGES),
    )).orderBy(...dashboardProjectOrder).all()
  : await base.where(archivedFilter).orderBy(...dashboardProjectOrder).all();
```

Without this, a photographer's dashboard would still *list* a project that's progressed past
`raw_review` (from the unfiltered query) even though opening it would now 403 via
`hasProjectAccess` — a confusing dead-end card. Both changes are needed together.

### 4. Live re-evaluation, not a snapshot — confirmed correct by design

`hasProjectAccess` reads the project's *current* `stageKey` on every call, not a cached/snapshotted
value. This means: if an admin manually reverts a project's stage backward (stages.ts's own
comment notes "admin can also set any stage directly," `stages.ts:31`), photographer visibility
resumes automatically on the next request — no stale-state bug, no special-case code needed for
that direction.

### 5. What "cannot see" means here — the direct, literal reading

Once a project passes `raw_review`, the photographer loses **all** access to it through every
route `hasProjectAccess` gates — not just the dashboard listing, but opening the project directly,
viewing their own previously-uploaded RAW assets, and commenting/annotating on it. This is the
literal reading of "cannot see assigned projects that have progressed beyond raw review," and
follows directly from centralizing the fix in the one universal access gate rather than only the
dashboard list. **This is an explicit approval checkpoint, not a detail to nod past** (elevated
per Terra round 1's own framing of how consequential it is): a photographer who uploaded RAW
frames and left annotations on them loses the ability to even review their own prior annotations
once the project moves on. If photographers should retain read-only access to their own past
contributions after the cutoff, that's a materially different (and larger) design than a blanket
access cutoff. **Proceeding with the blanket cutoff as designed unless the user says otherwise
before this is built** — this needs an actual yes, not silence, given what it removes.

### 6. Two known limitations, accepted rather than solved — surfaced explicitly per Terra round 1
(both precision-corrected per Terra round 2)

- **`hasProjectAccess` is a request-admission-time gate, for both reads and writes** — corrected
  per Terra round 2, which found the original wording only discussed writers, when a **read**
  request racing a concurrent stage transition is exactly the same shape of gap (e.g.
  `review.ts:26,32-47` or `GET /projects/:id`, `projects.ts:602-604`, admitted a moment before the
  stage changes). **Also corrected the example**: photographers don't hold the `selectForEditing`
  capability at all (`capabilities.ts:87-93`; `review.ts:88-91` gates that route behind it), so
  `POST /assets/:id/select` was never a reachable example for this role — a photographer's actual
  race window is on annotation creation, RAW upload, or review recommendation
  (`annotations.ts:97-113`, `uploads.ts:53-88`, `review.ts:79-85`). **Accepted for v1, for both
  reads and writes**: this cutoff applies at request admission, not as a transactional fence
  across every concurrent read/write. Adding true fencing would mean guarding every route this
  touches with an in-transaction re-check — real work, disproportionate to a narrow, low-frequency
  race (admins don't advance stages every second) against a codebase that has no other
  transactional-fencing precedent for similar races. Revisit only if this narrow window turns out
  to matter in practice.
- **Previously issued media-transform URLs are not immediately revoked, and this is a pre-existing
  design property of this codebase, not something introduced by this plan.** `/media/...`
  (`media.ts:29`) checks `hasProjectAccess` on every request as expected, but
  `/__transform-source/*` (`index.ts:54-73`) does **more than bare HMAC verification** — corrected
  per Terra round 2, which found it also validates canonical query fields, a cache version, and
  expiry bounds alongside the key-bound HMAC itself (`index.ts:60-64`, `transform-source.ts:63-69`)
  — but none of those additional checks re-verify project access or stage, so the substantive gap
  stands: this token authorizes a source fetch without consulting `hasProjectAccess` at all. This
  is already explicitly documented in that file's own comment: "the browser-facing transform URL
  is a bearer URL whose effective lifetime is the Images cache lifetime (currently at least an
  hour), not five minutes or a revocation promise." **Corrected duration claim**: the 1-hour
  `TRANSFORM_SOURCE_TTL_SECONDS` bounds the *source* token's own validity, not how long Cloudflare
  may continue serving an already-cached transformed result from it — say **"Cloudflare
  cache-policy-dependent and not immediately revocable,"** not "up to roughly an hour," which
  overstated the guarantee in the other direction. This means a photographer who loaded a
  transformed image shortly before losing access could still have that already-issued URL (or
  Cloudflare's cached transformed result behind it) resolve for some further, cache-dependent
  period afterward — not bounded by the 1-hour source-token TTL in either direction. This isn't a
  gap this plan creates or needs to close — it's the same non-instant-revocation property every
  other access-sensitive use of this mechanism already lives with — but it means "cannot see"
  here means "cannot start a new session that fetches it," not an absolute, instant, cryptographic
  guarantee against a URL grabbed moments before the cutoff. Worth the user knowing, not worth new
  infrastructure to close.

## Explicitly out of scope

- Any change to editor/admin visibility (`viewAllProjects` short-circuits before the new check —
  untouched).
- Any change to the existing RAW-only media-kind restriction (D-02) — this plan is additive to
  it, not a replacement.
- A "read-only past contribution" carve-out (§5) — proceeding with the blanket cutoff unless the
  user says otherwise.

## Testing requirements for the build

1. `packages/shared/test`: `PHOTOGRAPHER_VISIBLE_STAGES` is exactly
   `["awaiting_raw", "raw_review"]`.
2. `workers/app/test`: a photographer with a `project_members` row on a project in each of the
   five stages — access is allowed for `awaiting_raw`/`raw_review` and 403 for
   `editing_autohdr`/`edited_review`/`delivered`, expanded per Terra round 1 to cover every
   `hasProjectAccess`-gated route family, not just the three originally listed: project details
   (`GET /projects/:id`), asset fetch (`media.ts`), annotation create/read/edit/delete
   (`annotations.ts`), upload endpoints (`uploads.ts`), collection endpoints (`collections.ts`),
   and `review.ts`'s asset listing/recommend/select-for-editing actions. Also: a **non-member**
   photographer (no `project_members` row at all) gets 403 regardless of stage, at every one of
   the above; an admin manually reverting stage from `editing_autohdr` back to `raw_review`
   restores access on the next request, no stale state; editor/admin access is completely
   unaffected at every stage (regression check).
3. `GET /projects`: a photographer's dashboard list excludes their assigned project once its
   stage passes `raw_review`, and re-includes it if reverted; editor/admin listing is unaffected.
4. Transform-token behavior (added per Terra round 1, §6 above; wording corrected per Terra round
   3): confirm `/__transform-source/*` continues to validate its existing canonical query shape,
   cache version, expiry bounds, and key-bound HMAC exactly as it does today — none of which
   re-verify project access or stage — this plan makes no change there, so the test is a
   documentation/regression check that the known limitation is accurately described, not a new
   enforcement to verify.

## Verification (per CLAUDE.md / Subagent-Orchestration.md §5, once built)

- `npm run typecheck` (all six workspaces) and `npm run build -w @quincy/web`.
- `npm run test --workspaces` **and**
  `npx vitest run --config packages/shared/vitest.config.ts` (silently skipped by the workspaces
  script otherwise, per this repo's own gotcha).
- Manual smoke: as a photographer test account, confirm a project disappears from the dashboard
  and returns a 403 on direct navigation once an admin advances it past `raw_review`.

## Rollout

Single coordinated deploy — `packages/shared` (new constant) and `workers/app`
(`capability.ts` + `projects.ts`) must ship together (a partial deploy would leave the dashboard
list and the access gate disagreeing). No migration, no frontend change (the dashboard already
handles a project disappearing from the list — no special UI needed for a 403 on direct
navigation to an already-open project; the relevant existing handling is
`ProjectWorkspace.tsx:123-137,295-296` — corrected per Terra round 1, which found the original
citation of `Dashboard.tsx` for this was wrong — its `error`/`isLoading` states already render a
"Project unavailable" fallback with a back-to-dashboard link on any fetch failure including a
403). Note also: a photographer with the project workspace **already open** in a browser tab
before the stage change won't see anything different until their next fetch (refresh or
navigation) — the SPA holds already-fetched data in memory regardless of this change, same as
every other access-sensitive screen in this codebase; not a regression this plan introduces.

## Routing (per Subagent-Orchestration.md §2 routing table)

Small, focused authorization change concentrated in one shared function plus one query — but
cross-cutting in effect (every access-gated route) and load-bearing for security — Terra plan
review, then (when the user authorizes a build) Terra build, Terra diff review, Opus final read,
§5 gate.
