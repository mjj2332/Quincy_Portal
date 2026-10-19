# Always-on Video and editable Services

Owner request (2026-10-20): upload videos and add video links even when a Project has no Video
service, and edit Services after a Project is created. Owner decision: **Video is a Collection on
every Project, like RAW**, with a backfill; Services are unlocked in Edit Details. Tonomo re-adding
a service it ordered on a later webhook is accepted for now (Tonomo owns the order).

Planned by Opus (deep-reasoner) and Codex blind, synthesized by the session. Base `origin/main`
at `eeaa526c`.

## Findings

- `POST /projects/:id/links` already creates a missing Collection through `ensureCollection`, so
  links never needed the Video service. Workspace tabs already list every kind.
- The only hard refusal is the video reserve (`RESERVE_SQL` joins `c.kind = 'video'`, then
  `reserveRefusal` answers `video_service_missing`).
- Nothing reads "a Video Collection exists" as "Video was ordered": stage logic, Board, Gantt,
  admin reports, DeliveryPage `films`, notifications all count real assets / delivered items.
- Visible changes: Video tab badge `0` instead of `—`; external DTO / MCP `services` always list
  `video`; `project.create` audit `orderedServices` always includes `video`.
- `PATCH /projects/:id` already adds/removes Collections atomically with race fences, audit and
  activity, and refuses removing a Collection holding media, links, manifests or active uploads.
  The lock was UI-only (45fc35fb).

## Build

1. `packages/shared/src/media.ts`: `ALWAYS_ON_COLLECTION_KINDS = ["raw", "video"]`,
   `OPTIONAL_SERVICE_KINDS = ["edited", "floorplan", "copy"]`, `type ServiceKind`. Keep
   `COLLECTION_KINDS`.
2. `workers/app/src/routes/projects.ts`: create seeds both always-on kinds; PATCH seeds
   `desiredServices` with both, excludes both from `removedCollections`, `removalSafe` and the
   guarded `DELETE` (`kind NOT IN ('raw','video')`); add `code: "services_blocked"` to both 409
   `blocked` bodies; delete the dead `addCollections`.
3. `workers/app/src/routes/video-uploads.ts`: idempotently ensure the Video Collection (non-archived
   Project, `ON CONFLICT(project_id, kind) DO NOTHING`) before `RESERVE_SQL`; drop the
   `video_service_missing` branch. Covers the apply→deploy gap and old fixtures.
4. `workers/background/src/tonomo/process.ts` `orderedKinds`: seed with the always-on kinds.
5. `workers/app/src/mcp/tools/writes.ts`: `orderedServices` described as "besides Raw and Video,
   which every Project has". Enum unchanged; `raw`/`video` accepted and ignored.
6. Migration `0081_video_collection_on_every_project.sql` (+ journal idx 81): data-only
   `INSERT … SELECT` minting a UUIDv4 per row in SQL (0053 idiom; lessons "A fan-out
   INSERT ... SELECT needs an id per row"), archived Projects included, `ON CONFLICT DO NOTHING`.
   No semicolons in comments; no triggers. No per-Project audit (structural, as at create).
7. Web `ProjectFields.tsx`: `SERVICES` drops `video`; a fixed Video tile like RAW ("Always
   included") in its current slot; `projectFieldsPolicy` drops `servicesReadOnly`, keeps
   `orderReadOnly`, `notesReadOnly`, `showInvoiceAndPayment`; the "fixed" note becomes "A service
   that already holds media can't be removed." Native checkbox markup kept.
8. Web `EditProject.tsx`: hydrate optional kinds only; real `onToggle`; payload adds
   `orderedServices` (still omits order, notes, invoice, payment); on 409 `services_blocked`, a
   named `Notice` and the blocked kinds re-checked, draft kept.
9. Docs: `packages/shared/GLOSSARY.md` (Collection, Service), `docs/Guides/CI-Deploy.md` 0081
   note, `packages/db/qa-seed/dataset.ts` services.

## Tests (red first)

- `packages/db/test/migration-0081.test.ts`: missing / archived / populated Projects end with one
  `video` row; existing ids and counts untouched; UUIDv4 ids; re-apply is a no-op; journal entry.
- `video-upload.test.ts`: a Project without a Video Collection now reserves (201) and gains it;
  archived still 409.
- `api.test.ts`: create → `edited, raw, video`; PATCH `[]` keeps raw+video; PATCH `["video"]` is a
  no-op with no audit; add floorplan → `servicesAdded`, `changedFields: services`; removing a
  populated `edited` → 409 `services_blocked`; archived → `details_project_archived`.
- `tonomo-process.test.ts`: a no-video order creates raw+video.
- Web: `ProjectFields.test.ts` / `.dom.test.tsx` policy and tiles; new
  `EditProject-services.dom.test.tsx` for payload and the blocked Notice.

## Deploy

Owner approves applying 0081 to production (CI-Deploy §"A PR that adds a D1 migration"), then the
merge deploys. The old Worker is compatible with extra Video rows; the reserve-route ensure covers
Projects created in between. Post-check: zero Projects without a Video Collection.

## Follow-up

Tonomo `ensureCollections` re-adds a service staff removed when the order is re-sent. Durable
manual suppression needs its own ownership model.
