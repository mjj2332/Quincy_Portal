#!/usr/bin/env node
// One-off bulk cleanup (late September 2026): archive-then-delete every project whose shoot date is
// before 2026-09-01 (shoot_date < '2026-09-01'), at ANY stage. Projects with a NULL shoot_date are
// deliberately NOT in scope (owner: "do not touch projects without shoot date"). Same mechanism as
// scripts/bulk-archive-delete-sep-2026.mjs: calls the existing single-project routes
// (workers/app/src/routes/projects.ts: POST /projects/:id/archive, DELETE /api/projects/:id) once per
// project so the audit row, active-job/upload guards, FK-ordered cascade and R2 purge all stay the
// route's, not this script's.
//
// Scope from a read-only remote D1 query on 2026-09-28: 79 projects, 11 with NULL shoot_date,
// 21 with shoot_date < 2026-09-01 (all stage delivered, none archived; every shoot_date canonical
// YYYY-MM-DD). The 21 own no assets and no R2 objects under projects/{id}/, so each delete is
// expected to report 0 R2 objects. No queued/running jobs and no active document uploads.
//
// Usage (owner's own terminal; the cookie is never shown to an agent):
//   QUINCY_SESSION_COOKIE='<cookie header value from an admin browser session>' \
//     node scripts/bulk-archive-delete-late-sep-2026.mjs --dry-run
//   QUINCY_SESSION_COOKIE='...' node scripts/bulk-archive-delete-late-sep-2026.mjs --live
//
// Before --live: D1 backup (wrangler d1 export quincy-portal --remote --output
// ~/quincy-d1-backups/quincy-portal-2026-09-28-pre-late-sep-cleanup.sql from portal/workers/app).
//
// Run record (2026-09-28, owner-run from their signed-in Admin session):
//   - D1 backup quincy-portal-2026-09-28-pre-late-sep-cleanup.sql (24,368,573 bytes, 79 project rows).
//   - 21/21 archived + deleted: audit_log holds 21 project.archive + 21 project.delete rows for them.
//     D1 afterwards: 79 -> 58 projects, 11 NULL shoot_date (untouched), 0 before 2026-09-01, 0 archived.
//   - Residue sweep (owner-approved), after a second backup quincy-portal-2026-09-28-pre-residue-sweep.sql
//     (23,738,274 bytes): the delete route does not clear tables without a cascading FK, so orphans
//     were removed by direct D1 batch — notification_delivery_ledger 349 and notification_outbox 322
//     (all completed/failed; the archive broadcasts raised most of them), rendition_dlq_events 527,
//     project_board_order_0037_rollback 62. R2: 7 orphan objects (5 synthetic QA images under
//     projects/738d1b93…/ with no project row; 2 annotation JSONs under a live project whose
//     annotations no longer exist). audit_log rows for deleted projects (1,565) kept by design.
//   - Proof: 59-check D1 orphan scan shows only audit_log; every R2 key under projects/ and
//     renditions/ (4,264) belongs to a live project/asset and is referenced (or is the
//     .preview.jpg of a referenced key); every referenced key exists.

const origin = process.env.QUINCY_ORIGIN ?? "https://quincy.flamingfire.my";
const cookie = process.env.QUINCY_SESSION_COOKIE;
const mode = process.argv.includes("--live") ? "live" : "dry-run";

if (!cookie) throw new Error("QUINCY_SESSION_COOKIE is required — copy the full Cookie header value from an admin's logged-in browser session (devtools > Network > any /api request > Request Headers > cookie).");

// street/suburb/shootDate are informational only (for the printed report). stageKey/archived are
// the sign-off snapshot: a project whose stage moved since sign-off is skipped, not deleted.
const PROJECTS = [
  { id: "6324cb67-0fb6-4999-a290-a9c031ee10c5", street: "238 Lawrence Street", suburb: "Alexandria", shootDate: "2026-07-31", stageKey: "delivered", archived: false },
  { id: "3436d3ee-9f06-4b4e-b79e-28f7491df2a3", street: "5/146 Boundary Street", suburb: "Paddington", shootDate: "2026-08-14", stageKey: "delivered", archived: false },
  { id: "3e45df5e-d44c-400e-8215-906ab494835d", street: "1/37 New Beach Road", suburb: "Darling Point", shootDate: "2026-08-17", stageKey: "delivered", archived: false },
  { id: "551e8a85-8ca9-416b-bcee-1c712e1f41a3", street: "8/85 Ocean Street", suburb: "Woollahra", shootDate: "2026-08-18", stageKey: "delivered", archived: false },
  { id: "fcd217df-cdd6-44ff-ba25-5b36922e5759", street: "10/2 Marathon Road", suburb: "Darling Point", shootDate: "2026-08-19", stageKey: "delivered", archived: false },
  { id: "0f6ca260-bf44-46be-bcb9-80fa7a0ec1d5", street: "2/20 Sutherland Crescent", suburb: "Darling Point", shootDate: "2026-08-19", stageKey: "delivered", archived: false },
  { id: "967bca04-7442-4b0b-9f5b-803dc9bb95b5", street: "25-27 John Street", suburb: "Woollahra", shootDate: "2026-08-19", stageKey: "delivered", archived: false },
  { id: "1bad8907-5008-41cc-bf20-0c3d06269dc1", street: "5 Alkoo Avenue", suburb: "Little Bay", shootDate: "2026-08-20", stageKey: "delivered", archived: false },
  { id: "cd82b9f3-bc76-4ce2-8af6-7b60a522b80e", street: "8/102 Alison Road", suburb: "Randwick", shootDate: "2026-08-21", stageKey: "delivered", archived: false },
  { id: "c2f68428-d393-48a3-af84-5397dd0c3b32", street: "1/21 Mount Street", suburb: "Coogee", shootDate: "2026-08-24", stageKey: "delivered", archived: false },
  { id: "5872fa80-12b6-4898-b78e-4081558a80e9", street: "2/7 Loftus Road", suburb: "Darling Point", shootDate: "2026-08-24", stageKey: "delivered", archived: false },
  { id: "0483b53c-e3bf-4866-9617-c59e5d9ee51a", street: "62 Edward Street", suburb: "Bondi", shootDate: "2026-08-24", stageKey: "delivered", archived: false },
  { id: "f8d59fc8-a721-45bb-9abb-e407f5f802e2", street: "10 Moncur Street", suburb: "Woollahra", shootDate: "2026-08-25", stageKey: "delivered", archived: false },
  { id: "86b972d8-ba9f-4e66-aa2a-e1051d15a5bd", street: "459 New South Head Road", suburb: "Double Bay", shootDate: "2026-08-25", stageKey: "delivered", archived: false },
  { id: "9dab4f5b-9c83-4090-9f65-78eaa1a982ce", street: "1/6 Holt Street", suburb: "Double Bay", shootDate: "2026-08-26", stageKey: "delivered", archived: false },
  { id: "5c71175d-5f1d-41f8-b5b5-49000582a356", street: "142 Forest Road", suburb: "Miranda", shootDate: "2026-08-26", stageKey: "delivered", archived: false },
  { id: "fb7cd6c1-0805-46d7-b395-1d0dd550536a", street: "27 Cabramatta Road", suburb: "Mosman", shootDate: "2026-08-26", stageKey: "delivered", archived: false },
  { id: "c82578bb-faa4-4f4c-9d2e-8b9b1b8f47df", street: "32 Read Street", suburb: "Bronte", shootDate: "2026-08-26", stageKey: "delivered", archived: false },
  { id: "12ccf2bc-c987-400a-8898-25b42c2b20bb", street: "9/2 Frances Street", suburb: "Randwick", shootDate: "2026-08-27", stageKey: "delivered", archived: false },
  { id: "ab891bd1-f4c6-4e06-9aba-c2313e32c04b", street: "117 O'Sullivan Road", suburb: "Bellevue Hill", shootDate: "2026-08-28", stageKey: "delivered", archived: false },
  { id: "3e4d9948-3ff4-4cf5-b30e-ad7e818f2431", street: "55 Bower Street", suburb: "Manly", shootDate: "2026-08-28", stageKey: "delivered", archived: false },
];

async function api(path, init) {
  const response = await fetch(`${origin}${path}`, { ...init, headers: { cookie, origin, "content-type": "application/json", ...init?.headers } });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { ok: response.ok, status: response.status, body };
}

async function main() {
  console.log(`Mode: ${mode}. Origin: ${origin}. Projects in scope: ${PROJECTS.length}.\n`);
  const results = [];
  for (const project of PROJECTS) {
    const label = `${project.street}, ${project.suburb} (shot ${project.shootDate}, ${project.stageKey}, ${project.id})`;
    const state = await api(`/api/projects/${project.id}`);
    if (state.status === 404) {
      console.log(`SKIP  ${label} — already deleted (404).`);
      results.push({ ...project, outcome: "already-deleted" });
      continue;
    }
    if (!state.ok) {
      console.error(`ABORT ${label} — GET failed (${state.status}): ${JSON.stringify(state.body)}`);
      results.push({ ...project, outcome: "get-failed" });
      break;
    }
    const current = state.body;
    const stageUnchanged = current.stageKey === project.stageKey;
    const archivedAsExpected = Boolean(current.archivedAt) === project.archived;
    if (!stageUnchanged || !archivedAsExpected) {
      console.log(`SKIP  ${label} — changed since sign-off (stageKey=${current.stageKey}, archivedAt=${current.archivedAt}). Not touching it.`);
      results.push({ ...project, outcome: "changed-since-signoff" });
      continue;
    }
    if (mode === "dry-run") {
      console.log(`WOULD ${project.archived ? "delete" : "archive+delete"}  ${label}`);
      results.push({ ...project, outcome: "would-delete" });
      continue;
    }
    if (!project.archived) {
      const archive = await api(`/api/projects/${project.id}/archive`, { method: "POST" });
      if (!archive.ok) {
        console.error(`ABORT ${label} — archive failed (${archive.status}): ${JSON.stringify(archive.body)}`);
        results.push({ ...project, outcome: "archive-failed" });
        break;
      }
    }
    const del = await api(`/api/projects/${project.id}`, { method: "DELETE" });
    if (!del.ok) {
      console.error(`ABORT ${label} — delete failed (${del.status}) after archiving: ${JSON.stringify(del.body)}. Project is now archived but not deleted — investigate before re-running.`);
      results.push({ ...project, outcome: "delete-failed-after-archive" });
      break;
    }
    console.log(`DONE  ${label} — deleted ${del.body?.deletedObjects ?? "?"} R2 objects.`);
    results.push({ ...project, outcome: "deleted", deletedObjects: del.body?.deletedObjects });
  }
  console.log("\nSummary:");
  for (const outcome of ["deleted", "would-delete", "already-deleted", "changed-since-signoff", "get-failed", "archive-failed", "delete-failed-after-archive"]) {
    const count = results.filter((r) => r.outcome === outcome).length;
    if (count) console.log(`  ${outcome}: ${count}`);
  }
  const objects = results.reduce((sum, r) => sum + (r.deletedObjects ?? 0), 0);
  if (mode === "live") console.log(`  R2 objects deleted: ${objects}`);
  const processed = results.length;
  if (processed < PROJECTS.length) console.log(`\nStopped early after ${processed}/${PROJECTS.length} — fix the reported failure and re-run (already-deleted/changed projects are skipped, not retried).`);
}

await main();
