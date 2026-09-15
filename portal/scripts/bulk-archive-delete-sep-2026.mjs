#!/usr/bin/env node
// One-off bulk cleanup (September 2026): archive-then-delete every project whose shoot date is
// more than 30 days before 2026-09-15 (shoot_date < 2026-08-16), at ANY stage, plus one
// already-archived QA fixture the owner asked to remove. Calls the existing, already-reviewed
// single-project routes (workers/app/src/routes/projects.ts: POST /projects/:id/archive,
// DELETE /api/projects/:id) once per project instead of reimplementing their FK-ordered DB
// cascade + dual R2-prefix purge (projects/{id}/ and renditions/{assetId}/) here.
//
// Scope was derived from a read-only remote D1 query on 2026-09-15 07:26 AEST and signed off by
// the owner the same morning (relayed by Agent_Main): 8 delivered + 43 raw_review projects, and the
// archived fixture "ZZZ TB3 QA Fixture — DELETE ME". Every shoot_date in production was already
// canonical YYYY-MM-DD (migrations 0042/0043 converted the Tonomo display strings), so no display
// date parsing was needed; the 10 projects with a NULL shoot_date are deliberately NOT in scope.
//
// Usage:
//   QUINCY_SESSION_COOKIE='<cookie header value from an admin browser session>' \
//     node scripts/bulk-archive-delete-sep-2026.mjs --dry-run
//
//   QUINCY_SESSION_COOKIE='...' node scripts/bulk-archive-delete-sep-2026.mjs --live
//
// --dry-run (default) only performs GET requests: it fetches each project's current state and
// reports whether it is still eligible (stage unchanged since sign-off, no active jobs reported).
// No mutation is issued.
//
// --live archives (skipped when the project is already archived: the route returns ok) and then
// deletes every project still eligible at the moment it is processed, stopping at the first
// failure so a partial run is never silently treated as complete. Re-run is safe: already-deleted
// projects 404 on GET and are skipped, not retried.
//
// Before --live: take a D1 backup (wrangler d1 export quincy-portal --remote --output
// ~/quincy-d1-backups/quincy-portal-<date>-pre-<label>.sql from portal/workers/app).
//
// Run record (2026-09-15, owner confirmed "Go, run live" via Agent_Main):
//   - D1 backup quincy-portal-2026-09-15-pre-sep-cleanup.sql (18,582,019 bytes, 21,868 INSERTs,
//     110 project rows) taken immediately before --live.
//   - First --live attempt stopped on project 1 with no mutation: the archive POST returned
//     403 {"error":"Forbidden: invalid request origin"}. workers/app/src/middleware/origin.ts
//     (added after the July 2026 script) requires the Origin header to equal APP_ORIGIN on every
//     POST/PUT/PATCH/DELETE as a CSRF guard for cookie sessions. Fix: api() now sends
//     `origin` alongside the cookie, exactly as the browser does. Any future cookie-session
//     script must do the same (see docs/lessons.md).
//   - Second --live run: 52/52 deleted (51 archived first, the fixture was already archived),
//     2789 R2 objects removed, 0 failures. D1 afterwards: 110 -> 58 projects, 0 archived.
//   - R2 spot-check: former keys under projects/2f2f70f7…, projects/fc6b0d2d… and
//     projects/332b7fb6… all "The specified key does not exist"; a surviving project's key
//     still downloaded.

const origin = process.env.QUINCY_ORIGIN ?? "https://quincy.flamingfire.my";
const cookie = process.env.QUINCY_SESSION_COOKIE;
const mode = process.argv.includes("--live") ? "live" : "dry-run";

if (!cookie) throw new Error("QUINCY_SESSION_COOKIE is required — copy the full Cookie header value from an admin's logged-in browser session (devtools > Network > any /api request > Request Headers > cookie).");

// street/suburb/shootDate are informational only (for the printed report). stageKey/archived are
// the sign-off snapshot: a project whose stage moved since sign-off is skipped, not deleted.
const PROJECTS = [
  { id: "2f2f70f7-a1d6-41d7-9c94-8b4bc9f91c00", street: "22 Hardie Street", suburb: "Mascot", shootDate: "2026-08-03", stageKey: "delivered", archived: false },
  { id: "8619acd6-c1a6-45a4-bca2-9a72dda9a50b", street: "3/137 Maroubra Road", suburb: "Maroubra", shootDate: "2026-08-03", stageKey: "delivered", archived: false },
  { id: "fc6b0d2d-d703-4770-b9a4-809603015ac2", street: "49 Great Buckingham Street", suburb: "Redfern", shootDate: "2026-08-04", stageKey: "delivered", archived: false },
  { id: "3cdfa826-4422-46a0-bcde-5a4b36369341", street: "14/15 Begonia Street", suburb: "Pagewood", shootDate: "2026-08-05", stageKey: "delivered", archived: false },
  { id: "214890e7-a8ca-4c3f-bf94-42f36de2ef1c", street: "5 Ritchard Avenue", suburb: "Coogee", shootDate: "2026-08-05", stageKey: "delivered", archived: false },
  { id: "9e0d292a-def5-4784-9f5e-f915e29e3e60", street: "2/95 Darling Point Road", suburb: "Darling Point", shootDate: "2026-08-07", stageKey: "delivered", archived: false },
  { id: "a3ba8d95-4da3-40cf-8683-cbd8a0bb2f8d", street: "15 Hartill-Law Avenue", suburb: "Earlwood", shootDate: "2026-08-07", stageKey: "delivered", archived: false },
  { id: "3390555e-e991-41f0-8f10-0a2d4bbe0e87", street: "5/26 Beach Street", suburb: "Coogee", shootDate: "2026-08-12", stageKey: "delivered", archived: false },
  { id: "d2df8b30-eaff-4742-8b65-ef4dd6aac4bb", street: "28/231-233 Anzac Parade", suburb: "Kensington", shootDate: "2026-06-10", stageKey: "raw_review", archived: false },
  { id: "3d3d0f67-203f-4a87-94ec-81bda8816499", street: "20 Sutherland Crescent", suburb: "Darling Point", shootDate: "2026-06-15", stageKey: "raw_review", archived: false },
  { id: "00e0d159-b966-4554-99e4-00ea56ec7e09", street: "21/71-79 Avoca Street", suburb: "Randwick", shootDate: "2026-06-16", stageKey: "raw_review", archived: false },
  { id: "e8db29b1-e1cb-4e2a-9b67-66e1b50e28b1", street: "225 Birrell Street", suburb: "Bronte", shootDate: "2026-06-23", stageKey: "raw_review", archived: false },
  { id: "df08f469-93ff-40f3-b7c0-4328af5a6d19", street: "g01/18 Illiliwa Street", suburb: "Cremorne", shootDate: "2026-06-23", stageKey: "raw_review", archived: false },
  { id: "e293b1ac-24a6-48fa-b877-9caf617b1484", street: "2/55 Sir Thomas Mitchell Road", suburb: "Bondi Beach", shootDate: "2026-06-24", stageKey: "raw_review", archived: false },
  { id: "a2c68fa8-804b-4333-8f52-fe239a39d089", street: "10/30 William Street", suburb: "Double Bay", shootDate: "2026-06-30", stageKey: "raw_review", archived: false },
  { id: "f07ed7e4-b274-4bda-a40f-feefd313fbae", street: "112 Cascade Street", suburb: "Paddington", shootDate: "2026-07-01", stageKey: "raw_review", archived: false },
  { id: "f81a805c-74c1-4935-8736-b9473b089cac", street: "12 Johnston Parade", suburb: "Maroubra", shootDate: "2026-07-03", stageKey: "raw_review", archived: false },
  { id: "926e9cbf-9604-4d44-b26c-6c6ea8c2e073", street: "1 Tivoli Avenue", suburb: "Rose Bay", shootDate: "2026-07-03", stageKey: "raw_review", archived: false },
  { id: "8352fa06-410a-43f8-8b0a-050300874753", street: "9 Wyong Road", suburb: "Mosman", shootDate: "2026-07-08", stageKey: "raw_review", archived: false },
  { id: "d24251dd-074c-4147-b339-b177267e16e7", street: "271 Darley Road", suburb: "Randwick", shootDate: "2026-07-09", stageKey: "raw_review", archived: false },
  { id: "a2ef62d4-67f4-431f-84b0-f2177a7b611a", street: "30 Canberra Street", suburb: "Randwick", shootDate: "2026-07-13", stageKey: "raw_review", archived: false },
  { id: "faa5fdab-8e03-4d94-a820-d314154d140f", street: "3/11 Francis Street", suburb: "Bondi Beach", shootDate: "2026-07-13", stageKey: "raw_review", archived: false },
  { id: "6d413266-8316-4476-b459-c4411fe3c5ae", street: "2A Bayview Hill Road", suburb: "Rose Bay", shootDate: "2026-07-13", stageKey: "raw_review", archived: false },
  { id: "c99a41e4-9c4f-47ad-9dba-88ef51c2fa34", street: "11/20 Abbott Street", suburb: "Coogee", shootDate: "2026-07-14", stageKey: "raw_review", archived: false },
  { id: "98db3f4a-d541-429d-881e-e18d00b8550b", street: "26A O'Connell Avenue", suburb: "Matraville", shootDate: "2026-07-15", stageKey: "raw_review", archived: false },
  { id: "86b6297e-8e80-4bfb-bf6f-a538bf365a9d", street: "14 Hume Street", suburb: "Chifley", shootDate: "2026-07-15", stageKey: "raw_review", archived: false },
  { id: "91ff4e44-9e37-4a3b-b24b-59a68a9c2ede", street: "192 Clovelly Road", suburb: "Randwick", shootDate: "2026-07-16", stageKey: "raw_review", archived: false },
  { id: "7a8266d5-709a-4e4c-a2be-b234952f7113", street: "16/165-167 Victoria Street", suburb: "Potts Point", shootDate: "2026-07-17", stageKey: "raw_review", archived: false },
  { id: "f081fcd8-a598-441d-8f3a-4d202f968267", street: "243 Victoria Road", suburb: "Gladesville", shootDate: "2026-07-22", stageKey: "raw_review", archived: false },
  { id: "a40a7596-525a-47d0-8716-ac0ac22fd372", street: "225-227 Victoria Road", suburb: "Gladesville", shootDate: "2026-07-22", stageKey: "raw_review", archived: false },
  { id: "332b7fb6-01a2-4927-a2c6-93d05da0cea3", street: "level 16 suite 1605/520 Oxford Street", suburb: "Bondi Junction", shootDate: "2026-07-23", stageKey: "raw_review", archived: false },
  { id: "d9e7eb6d-2b75-4ed6-9006-bb1971f38105", street: "6/120 Beach Street", suburb: "Coogee", shootDate: "2026-07-23", stageKey: "raw_review", archived: false },
  { id: "37de3d7d-58d0-4f56-bf92-cfb913cc320b", street: "9/108 Brook Street", suburb: "Coogee", shootDate: "2026-07-27", stageKey: "raw_review", archived: false },
  { id: "7cedbab4-2b73-4736-ad64-dac589136aa7", street: "28/40 Victoria Street", suburb: "Potts Point", shootDate: "2026-07-27", stageKey: "raw_review", archived: false },
  { id: "218da8a9-d3d8-4974-95e3-9f69e13a2d05", street: "65 Gladesville Road & 67 Gladesville Road", suburb: "Hunters Hill", shootDate: "2026-07-31", stageKey: "raw_review", archived: false },
  { id: "ad45469f-1bf6-424f-af41-d224186cd70e", street: "119 King Street", suburb: "Mascot", shootDate: "2026-08-03", stageKey: "raw_review", archived: false },
  { id: "f3bb3bfa-4b12-449c-bb04-b40d8e190ff5", street: "5/6 Wallaroy Road", suburb: "Woollahra", shootDate: "2026-08-04", stageKey: "raw_review", archived: false },
  { id: "5877ca47-fd77-4bd1-a5ac-a1858c08f6fe", street: "19/20 Boronia Street", suburb: "Kensington", shootDate: "2026-08-06", stageKey: "raw_review", archived: false },
  { id: "213085ff-0e04-4719-977e-e604f576296f", street: "19/20 Boronia Street", suburb: "Kensington", shootDate: "2026-08-06", stageKey: "raw_review", archived: false },
  { id: "4cd4c318-ccd4-47cd-bf2e-80b03178c9ac", street: "25 Waverley Street", suburb: "Randwick", shootDate: "2026-08-11", stageKey: "raw_review", archived: false },
  { id: "0ca64868-0f58-4a9a-b595-05d3a4f35b46", street: "10 Macleay Street", suburb: "Elizabeth Bay", shootDate: "2026-08-11", stageKey: "raw_review", archived: false },
  { id: "e0672320-f348-49d6-bf2a-cc530544f3a7", street: "5/146 Boundary Street", suburb: "Paddington", shootDate: "2026-08-11", stageKey: "raw_review", archived: false },
  { id: "59b495df-19a8-402c-95fa-09c9390e5d6b", street: "8/37 Kensington Road", suburb: "Kensington", shootDate: "2026-08-11", stageKey: "raw_review", archived: false },
  { id: "6cca70a9-acc9-432f-a50a-c6b4a7901cf7", street: "807/2 Birtley Place", suburb: "Elizabeth Bay", shootDate: "2026-08-12", stageKey: "raw_review", archived: false },
  { id: "5c1741f7-9687-4a37-aec4-f4ca6df29d56", street: "103-105 Doncaster Avenue", suburb: "Kensington", shootDate: "2026-08-12", stageKey: "raw_review", archived: false },
  { id: "a3a8a1a7-31a2-462d-b232-65f33467f767", street: "1471 Botany Road", suburb: "Botany", shootDate: "2026-08-12", stageKey: "raw_review", archived: false },
  { id: "494a321b-33d9-4774-ab7d-2e85664b26c9", street: "8/183 Coogee Bay Road", suburb: "Coogee", shootDate: "2026-08-12", stageKey: "raw_review", archived: false },
  { id: "05eda3f8-4fa3-4607-a24f-5f2937d119c2", street: "79 Commonwealth Street", suburb: "Surry Hills", shootDate: "2026-08-12", stageKey: "raw_review", archived: false },
  { id: "9d760def-c9cf-493d-9d7a-6c5209667bc1", street: "9 Torrens Street", suburb: "Matraville", shootDate: "2026-08-14", stageKey: "raw_review", archived: false },
  { id: "ce046a46-cac8-4f56-bdae-c57dd68c7882", street: "7 Emily Street", suburb: "Rozelle", shootDate: "2026-08-14", stageKey: "raw_review", archived: false },
  { id: "5835e7e6-fcf8-4883-9b15-848a65882e50", street: "902/1 Circular Quay", suburb: "Sydney", shootDate: "2026-08-15", stageKey: "raw_review", archived: false },
  { id: "73ab6e89-1166-4599-bdfe-3cabc6cd7170", street: "ZZZ TB3 QA Fixture — DELETE ME", suburb: "TB3 Production Smoke Test", shootDate: null, stageKey: "awaiting_raw", archived: true },
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
