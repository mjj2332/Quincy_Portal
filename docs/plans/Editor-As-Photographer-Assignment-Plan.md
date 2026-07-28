# Editor-as-Photographer Assignment — Plan

**Status: APPROVED by Terra (round 3, 2026-07-28). Ready to build whenever the user authorizes it — not yet built.**

User request: some staff are both photographer and editor in practice; editors should be
assignable to a project's *photographer* slot, not just the editor slot.

## Current state (verified against the code, not assumed)

- **The backend already allows this — it's a frontend-only restriction.**
  `addMembers`/`syncMembers` (`workers/app/src/routes/projects.ts:85-100`) insert
  `project_members` rows for whatever user IDs the client sends, tagged with the *slot*
  (`roleOnProject: "photographer" | "editor"`) — nothing there checks the user's own global
  `role` column. `hasProjectAccess` (`middleware/capability.ts:18-23`) checks `viewAllProjects`
  *first*, before ever looking at `project_members` — corrected after Terra round 2, which noted
  the original wording implied an editor's access comes from the photographer-slot membership
  row, when it actually comes from `viewAllProjects` (which every editor already has) regardless
  of that row. The membership row still matters — it's what makes this person *appear* as a
  project member (name, slot) in the UI and in `project_members`-based queries elsewhere — just
  not for this person's own access grant, which was never in question. So the data model already
  supports an editor being a project's photographer-slot member; only the **picker UI** stops it
  today.
- **The actual restriction**: `ProjectFields.tsx:74-75` —
  ```ts
  const photographers = users.filter((user) => (user.role === "photographer" || user.role === "admin") && (user.active || form.photographerUserIds.includes(user.id)));
  const editors = users.filter((user) => (user.role === "editor" || user.role === "admin") && (user.active || form.editorUserIds.includes(user.id)));
  ```
  A user whose global `role` is `"editor"` never appears in the photographer checklist
  (`ProjectFields.tsx:107`) at all — not blocked at submit time, simply never offered as a
  candidate.
- **A related, already-known consequence, not a new one** — corrected after Terra round 1, which
  found the original wording overstated what `Multi-Role-Staff-Identity-Plan.md` itself commits
  to: that doc's "Context" section explicitly names only **two** accepted tradeoffs of its
  set-`role`-to-`"editor"` workaround — blanket `viewAllProjects` access, and
  `routes/review.ts:81`'s photographer-only `recommended`-only restriction no longer applying
  (`Multi-Role-Staff-Identity-Plan.md:26-32`). `routes/media.ts:31`'s matching RAW-only-viewing
  check is mentioned in that same doc, but only in its later §4 as a call site that will need
  updating *when* the full multi-role model is built (`:166-174`) — not as a tradeoff the doc's
  Context section already accepted today. Stated correctly here: both `review.ts:81` and
  `media.ts:31` hardcode `user.role === "photographer"`/role-array checks keyed off the user's
  **global** role, not their `roleOnProject` slot — so an editor assigned into a project's
  photographer slot keeps their full editor capabilities (star ratings, color labels, decisions,
  viewing Edited assets) everywhere, including on that project. That specific media.ts
  consequence isn't a new inconsistency this plan introduces — it's the same shape of bleed the
  other doc already accepts for `review.ts:81` — but it's this plan's own observation, not a
  tradeoff `Multi-Role-Staff-Identity-Plan.md` itself has already signed off on.

## Design

- **`ProjectFields.tsx:74`**: broaden the photographer candidate filter to also include editors:
  ```ts
  const photographers = users.filter((user) => (user.role === "photographer" || user.role === "editor" || user.role === "admin") && (user.active || form.photographerUserIds.includes(user.id)));
  ```
  Leave the `editors` filter (`:75`) unchanged — the request is one-directional (editors can be
  assigned as photographer; nothing suggests photographers should be assignable as editor, and
  `photographer`'s capability set is a strict subset of `editor`'s per
  `Multi-Role-Staff-Identity-Plan.md`, so that direction wouldn't make sense the same way).
- **Label clarity**: the photographer checklist already shows a `· admin` suffix badge for admin
  users mixed into that list (`ProjectFields.tsx:107`: `user.role === "admin" && " · admin"`).
  Extend the same inline badge to show `· editor` for editor-role users appearing in the
  photographer list, so whoever's assigning staff can see at a glance that this candidate's
  primary role is editor, not photographer — avoids the picker silently blending two different
  kinds of staff with no visual distinction.
- No schema change, no new capability, no new route — this is a UI-only filter/label change.

## Explicitly out of scope

- The general many-to-many role model (`Multi-Role-Staff-Identity-Plan.md`) — that remains the
  proper long-term fix if the accepted capability-bleed tradeoff above ever becomes a real
  problem; this plan doesn't replace or block it.
- Restricting an editor-assigned-as-photographer's capabilities down to photographer-only on
  that specific project (a per-project capability override) — not requested, and would require
  the `roleOnProject`-aware authorization work explicitly deferred in
  `Multi-Role-Staff-Identity-Plan.md`'s §3 decision.

## Testing requirements for the build

1. `apps/web`: an editor-role user appears in the photographer checklist (with the `· editor`
   badge) and remains selectable/deselectable identically to a photographer-role candidate; the
   editor checklist's candidate set is unchanged (no photographer-role users appear there).
2. `workers/app`: no backend change is planned, but existing coverage does **not** actually
   prove this today — Terra round 1 confirmed `test/api.test.ts:803-829` only exercises
   photographer IDs in the photographer slot and editor IDs in the editor slot, never an
   editor-role ID in `photographerUserIds`. Add a new, explicit regression test with **two
   separate assertions, kept distinct per Terra round 2**: (a) an editor-role user's ID is
   accepted in `photographerUserIds` on `POST`/`PATCH /projects` and produces a `project_members`
   row with `roleOnProject: "photographer"` for that user (a data-correctness check); (b)
   separately, that this person can access the project — which for an editor passes via
   `viewAllProjects` regardless of the membership row's existence, not *because of* it. Don't
   conflate the two into one assertion implying the membership row is what grants their access.
   This is expected to pass against the *current*, unmodified backend (confirming the "no backend
   change needed" claim), not a new capability being added.

## Verification (per CLAUDE.md / Subagent-Orchestration.md §5, once built)

- `npm run typecheck` (all six workspaces) and `npm run build -w @quincy/web`.
- `npm run test --workspaces`.
- Manual smoke: create/edit a project, confirm an editor-role staff member is selectable in the
  Photographers checklist with the `· editor` badge, save, and confirm they gain project access
  via the photographer slot (visible on their dashboard).

## Rollout

Frontend-only, single component (`ProjectFields.tsx`) — one deploy, no migration, no API change.

## Routing (per Subagent-Orchestration.md §2 routing table)

Small, frontend-only, single-component change — Terra plan review, then (when the user
authorizes a build) Terra build, Terra diff review, Opus final read, §5 gate.
