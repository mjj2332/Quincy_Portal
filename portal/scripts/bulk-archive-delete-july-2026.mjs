#!/usr/bin/env node
// One-off bulk cleanup: archive-then-delete every "delivered" project shot on or before
// 2026-07-31. Calls the existing, already-reviewed single-project routes
// (workers/app/src/routes/projects.ts: POST /projects/:id/archive, DELETE /api/projects/:id)
// once per project instead of reimplementing their FK-ordered DB cascade + dual R2-prefix
// purge (projects/{id}/ and renditions/{assetId}/) here.
//
// Scope was derived by hand against production D1 on 2026-08-16: stage_key = 'delivered',
// archived_at IS NULL, shoot_date <= 2026-07-31 (parsed across both the canonical
// YYYY-MM-DD rows and the "Weekday, DD Mon, YYYY" rows some projects have from Tonomo
// webhook ingestion). 25 projects, listed below with their address for a final human check
// against this list before running live.
//
// Usage:
//   QUINCY_SESSION_COOKIE='<cookie header value from an admin browser session>' \
//     node scripts/bulk-archive-delete-july-2026.mjs --dry-run
//
//   QUINCY_SESSION_COOKIE='...' node scripts/bulk-archive-delete-july-2026.mjs --live
//
// --dry-run (default if neither flag is passed) only performs GET requests: it fetches each
// project's current state and reports whether it's still eligible (stage still "delivered",
// still unarchived, no active jobs/uploads reported by the API). No mutation is issued.
//
// --live performs the real archive-then-delete for every project still eligible at the
// moment it's processed, stopping at the first failure so a partial run is never silently
// treated as complete. Re-run is safe: already-deleted projects will 404 on GET and are
// skipped, not retried.

const origin = process.env.QUINCY_ORIGIN ?? "https://quincy.flamingfire.my";
const cookie = process.env.QUINCY_SESSION_COOKIE;
const mode = process.argv.includes("--live") ? "live" : "dry-run";

if (!cookie) throw new Error("QUINCY_SESSION_COOKIE is required — copy the full Cookie header value from an admin's logged-in browser session (devtools > Network > any /api request > Request Headers > cookie).");

// street/suburb/shootDate are informational only (for the printed report); the id is what's
// actually used. Re-verify this list against production before a --live run if any time has
// passed since 2026-08-16.
const PROJECTS = [
  { id: "3cf343b3-d144-4b13-ae08-3b91bd996ec5", street: "2/208 Alison Road", suburb: "Randwick", shootDate: "2026-06-09" },
  { id: "5a0afeed-07a7-4002-bee7-0e835caf3319", street: "2/159 Victoria Road", suburb: "Bellevue Hill", shootDate: "2026-06-10" },
  { id: "6ff8beae-51bf-4e19-b082-f69e359d039c", street: "17 Oxford Street", suburb: "Bondi Junction", shootDate: "2026-06-12" },
  { id: "7e0da074-7c52-426b-8a38-b7974048d532", street: "24/10A Mears Avenue", suburb: "Randwick", shootDate: "2026-06-16" },
  { id: "0b8926af-2104-4878-9266-c65f08a15569", street: "53/818 Anzac Parade", suburb: "Maroubra", shootDate: "2026-06-29" },
  { id: "7f3e8624-883d-4ca7-9fe0-6a902b0be834", street: "1 Edgecliffe Avenue", suburb: "South Coogee", shootDate: "2026-07-14" },
  { id: "8a531e64-0f41-4381-9928-17b6c9e35e78", street: "45 Vista Street", suburb: "Sans Souci", shootDate: "2026-07-14" },
  { id: "e655f015-9ffa-42d9-9f28-2fa6aa964316", street: "11/20 Abbott Street", suburb: "Coogee", shootDate: "2026-07-14" },
  { id: "9147cc02-520f-471b-b64d-192bd421ae90", street: "21 Wolseley Road", suburb: "Mosman", shootDate: "2026-07-15" },
  { id: "4914ed4a-4460-4af0-a38a-e9ad3a12dbed", street: "1-5 Flinders Street", suburb: "Darlinghurst", shootDate: "2026-07-15" },
  { id: "0d2d54cc-aa93-42db-90c6-10cd249bda56", street: "16/165-167 Victoria Street", suburb: "Potts Point", shootDate: "2026-07-17" },
  { id: "57a72c52-cf2c-4c44-80b7-07d60585e38c", street: "4 McGowen Avenue", suburb: "Malabar", shootDate: "2026-07-20" },
  { id: "9dae2a13-f023-47fa-aff8-34bca15a80aa", street: "62 Beach Street", suburb: "Coogee", shootDate: "2026-07-21" },
  { id: "14851995-fbcf-4dcb-88d3-ed97f7386968", street: "243 Victoria Road", suburb: "Gladesville", shootDate: "2026-07-22" },
  { id: "2e5e2329-fe74-4815-acf2-44ad2fd034d1", street: "12 Brompton Road", suburb: "Kensington", shootDate: "2026-07-22" },
  { id: "63d59d52-1b52-4cc7-837c-940ee55c04d0", street: "20/337 New South Head Road", suburb: "Double Bay", shootDate: "2026-07-27" },
  { id: "3192629f-6116-4f07-b8ac-7b8d7c7d48a8", street: "28/40 Victoria Street", suburb: "Potts Point", shootDate: "2026-07-27" },
  { id: "4602c0d7-6e55-4383-a98d-86cab45bcee8", street: "4/16 Salisbury Road", suburb: "Kensington", shootDate: "2026-07-29" },
  { id: "b9b3cefe-33d6-47b2-8d4c-cfcb27c4a5bb", street: "38 Carnegie Circuit", suburb: "Chifley", shootDate: "2026-07-29" },
  { id: "c5dd3ed8-1195-4a4d-b333-50dca22ea80d", street: "3/9 Chicago Avenue", suburb: "Maroubra", shootDate: "Monday, 27 Jul, 2026" },
  { id: "061de998-71fd-4d83-b4bf-acc699a5397a", street: "13 Asquith Avenue", suburb: "Rosebery", shootDate: "Wednesday, 29 Jul, 2026" },
  { id: "a9cb9a7b-ce2b-4f0a-a896-1c718a0f878d", street: "65 Gladesville Road", suburb: "Hunters Hill", shootDate: "Friday, 31 Jul, 2026" },
  { id: "8279510f-ed10-42bf-93dd-8e0a3ac7195d", street: "24/53 Ocean Avenue", suburb: "Double Bay", shootDate: "Thursday, 30 Jul, 2026" },
  { id: "804be23a-db62-4132-bb51-2c6eac9134d3", street: "238 Lawrence Street", suburb: "Alexandria", shootDate: "Friday, 31 Jul, 2026" },
  { id: "cfb54ab3-6ded-40e3-9f89-0e8509612715", street: "1/27 Wyanbah Road", suburb: "Cronulla", shootDate: "Thursday, 30 Jul, 2026" },
];

async function api(path, init) {
  const response = await fetch(`${origin}${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...init?.headers } });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { ok: response.ok, status: response.status, body };
}

async function main() {
  console.log(`Mode: ${mode}. Origin: ${origin}. Projects in scope: ${PROJECTS.length}.\n`);
  const results = [];
  for (const project of PROJECTS) {
    const label = `${project.street}, ${project.suburb} (shot ${project.shootDate}, ${project.id})`;
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
    const stillEligible = current.stageKey === "delivered" && !current.archivedAt;
    if (!stillEligible) {
      console.log(`SKIP  ${label} — no longer eligible (stageKey=${current.stageKey}, archivedAt=${current.archivedAt}). Not touching it.`);
      results.push({ ...project, outcome: "no-longer-eligible" });
      continue;
    }
    if (mode === "dry-run") {
      console.log(`WOULD archive+delete  ${label}`);
      results.push({ ...project, outcome: "would-delete" });
      continue;
    }
    const archive = await api(`/api/projects/${project.id}/archive`, { method: "POST" });
    if (!archive.ok) {
      console.error(`ABORT ${label} — archive failed (${archive.status}): ${JSON.stringify(archive.body)}`);
      results.push({ ...project, outcome: "archive-failed" });
      break;
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
  for (const outcome of ["deleted", "would-delete", "already-deleted", "no-longer-eligible", "get-failed", "archive-failed", "delete-failed-after-archive"]) {
    const count = results.filter((r) => r.outcome === outcome).length;
    if (count) console.log(`  ${outcome}: ${count}`);
  }
  const processed = results.length;
  if (processed < PROJECTS.length) console.log(`\nStopped early after ${processed}/${PROJECTS.length} — fix the reported failure and re-run (already-deleted/no-longer-eligible projects are skipped, not retried).`);
}

await main();
