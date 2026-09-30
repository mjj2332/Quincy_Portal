#!/usr/bin/env node
// One-off bulk cleanup (October 2026): archive-then-delete every project whose shoot date is before
// 2026-09-01 (shoot_date < '2026-09-01'), at ANY stage. Projects with a NULL shoot_date are
// deliberately NOT in scope (owner: "do not touch projects without a shoot date"). Same mechanism as
// scripts/bulk-archive-delete-late-sep-2026.mjs: calls the existing single-project routes
// (workers/app/src/routes/projects.ts: POST /projects/:id/archive, DELETE /api/projects/:id) once per
// project so the audit row, active-job/upload guards, FK-ordered cascade and R2 purge all stay the
// route's, not this script's.
//
// Why again: the 2026-09-28 run left 0 projects before 2026-09-01, but on 2026-09-30 00:00-00:13 UTC
// Tonomo re-sent 91 historical (orderStatus "complete") orders and background/src/tonomo/process.ts
// recreated 79 of them, because it matches an order to a project only by projects.order_id — a
// deleted project leaves no trace, so any replay recreates it. 52 of the 79 had been deleted before.
// Until that is guarded, a future Tonomo replay can bring these back again.
//
// Scope from a read-only remote D1 query on 2026-10-01: 146 projects, 10 NULL shoot_date, 57 on/after
// 2026-09-01, 79 before 2026-09-01 (all stage raw_review, none archived, every shoot_date canonical
// YYYY-MM-DD, all created by actor "tonomo"). The 79 own no assets and no R2 objects, so each delete
// is expected to report 0 R2 objects. No queued/running jobs. They do own 137 collections, 92
// members, 171 notifications, 79 outbox rows, 531 finished jobs, 9 raw-reconciliation claims and 10
// editor_folder_mappings — all removed by the route's cascade. Dropbox folders are NOT touched.
// Archiving raises one project.archived broadcast per project (as in the 09-28 run).
// Residue scan the same day: 0 D1 orphans (only audit_log, kept by design) and 0 orphan R2 objects
// across all 7,082 keys under projects/ and renditions/.
//
// Usage (owner's own terminal; the cookie is never shown to an agent):
//   QUINCY_SESSION_COOKIE='<cookie header value from an admin browser session>' \
//     node scripts/bulk-archive-delete-oct-2026.mjs --dry-run
//   QUINCY_SESSION_COOKIE='...' node scripts/bulk-archive-delete-oct-2026.mjs --live
//
// Before --live: D1 backup (wrangler d1 export quincy-portal --remote --output
// ~/quincy-d1-backups/quincy-portal-2026-10-01-pre-oct-cleanup.sql from portal/workers/app).
//
// Run record (2026-10-01, owner-run from their signed-in Admin session):
//   - D1 backup quincy-portal-2026-10-01-pre-oct-cleanup.sql (29,937,241 bytes, 146 project rows,
//     12,376 audit_log rows).
//   - Guard shipped first (#409): 0051 applied by hand after Time Travel bookmark
//     00000899-00000a58-000050f6-f31f4923f24902a5df4e98eb5ee3def9; seed recorded 96 tombstones
//     (52 held by live in-scope projects at the time); new Worker versions live before --live ran.
//   - 79/79 archived + deleted, 0 R2 objects. D1 afterwards: 146 -> 67 projects, 10 NULL shoot_date
//     (untouched), 57 on/after 2026-09-01, 0 before. tonomo_order_tombstones 123 (79 source
//     project_delete); audit_log holds 79 project.archive + 79 project.delete rows for them.
//   - Residue: 0 D1 orphans across every project/asset-linked table; 0 orphan R2 objects across all
//     7,082 keys under projects/ and renditions/.
//   - audit_log cleanup (owner decision, reversing the 09-28 "kept by design"): after Time Travel
//     bookmark 0000089a-00000440-000050f6-dc40016ae3d30bb50e03e5f791351454, deleted 4,643 rows —
//     target_type 'project' rows of projects that no longer exist (except project.archive and
//     project.delete, kept as the record of each deletion: 416 remain) plus rows of other target
//     types whose meta_json.projectId names a deleted project. All 4,643 predate the backup above.
//     Rows for deleted entities that carry no projectId were left, since their project can't be
//     proven and they may belong to live projects.
const origin = process.env.QUINCY_ORIGIN ?? "https://quincy.flamingfire.my";
const cookie = process.env.QUINCY_SESSION_COOKIE;
const mode = process.argv.includes("--live") ? "live" : "dry-run";

if (!cookie) throw new Error("QUINCY_SESSION_COOKIE is required — copy the full Cookie header value from an admin's logged-in browser session (devtools > Network > any /api request > Request Headers > cookie).");

// street/suburb/shootDate are informational only (for the printed report). stageKey/archived are
// the sign-off snapshot: a project whose stage moved since sign-off is skipped, not deleted.
const PROJECTS = [
  { id: "a505aadd-d09a-4506-abe6-e67389de2cc2", street: "127-129 Manning Road", suburb: "Double Bay", shootDate: "2026-04-14", stageKey: "raw_review", archived: false },
  { id: "f3ccd5b9-e7e7-4388-9449-ce4a02aeefa4", street: "50/107 Macpherson Street", suburb: "Bronte", shootDate: "2026-04-15", stageKey: "raw_review", archived: false },
  { id: "d367e44c-3a6d-4acc-9034-85dd42cb5ed8", street: "21 Trevilyan Avenue, 2018 Rosebery, AU", suburb: null, shootDate: "2026-04-16", stageKey: "raw_review", archived: false },
  { id: "712b162b-8911-4994-879c-b6bd25bd22f5", street: "81 Campbell St, Surry Hills NSW 2010, Australia", suburb: null, shootDate: "2026-04-16", stageKey: "raw_review", archived: false },
  { id: "30712f24-f72b-4eb8-a36d-7b2bd37b56a1", street: "6 Ingram Street", suburb: "Kensington", shootDate: "2026-04-17", stageKey: "raw_review", archived: false },
  { id: "f71d6d7d-02b0-436c-b235-3cc6a0325641", street: "13/253 Carrington Road", suburb: "Coogee", shootDate: "2026-05-07", stageKey: "raw_review", archived: false },
  { id: "7a886aef-1e1f-41e1-bf78-f52b51702fc1", street: "13 Sirius Avenue", suburb: "Mosman", shootDate: "2026-05-20", stageKey: "raw_review", archived: false },
  { id: "11d72337-a87d-4af5-b65a-f602b790c62a", street: "29 Bay Street", suburb: "Mosman", shootDate: "2026-05-21", stageKey: "raw_review", archived: false },
  { id: "0d59d53d-c423-47a5-a323-d519f6322e7a", street: "57 Meehan Street", suburb: "Matraville", shootDate: "2026-05-27", stageKey: "raw_review", archived: false },
  { id: "0c8d5fe5-31ea-45b6-a657-77ff44449ae0", street: "25/49 Albion Street", suburb: "Waverley", shootDate: "2026-05-28", stageKey: "raw_review", archived: false },
  { id: "4af3b503-f900-4637-9174-54dac7502354", street: "40 Parer Street", suburb: "Maroubra", shootDate: "2026-06-05", stageKey: "raw_review", archived: false },
  { id: "d049aba5-9451-4a3c-8926-0e0575df8b5f", street: "63A Wilson Street", suburb: "Botany", shootDate: "2026-06-05", stageKey: "raw_review", archived: false },
  { id: "40a40c3f-ee23-41a1-8b9e-f402ef8173e5", street: "8 Irvine Street", suburb: "Kingsford", shootDate: "2026-06-05", stageKey: "raw_review", archived: false },
  { id: "e86c2c67-f423-4b31-83f0-4f0f7fff6822", street: "2/208 Alison Road", suburb: "Randwick", shootDate: "2026-06-09", stageKey: "raw_review", archived: false },
  { id: "6735150f-8257-4a0c-a38b-65cfebd30362", street: "2/560 Military Road", suburb: "Mosman", shootDate: "2026-06-09", stageKey: "raw_review", archived: false },
  { id: "ab0b65cb-9254-4569-afb5-20ebc96f5164", street: "28/231-233 Anzac Parade", suburb: "Kensington", shootDate: "2026-06-10", stageKey: "raw_review", archived: false },
  { id: "e0d5a8b5-ef7a-4100-9a3f-459fb8ebe40e", street: "17 Oxford Street", suburb: "Bondi Junction", shootDate: "2026-06-12", stageKey: "raw_review", archived: false },
  { id: "ede0ed91-7772-43b6-a328-2a8765ad61b2", street: "208 Blues Point Road", suburb: "North Sydney", shootDate: "2026-06-16", stageKey: "raw_review", archived: false },
  { id: "67a7091f-4ad1-4860-ae8c-6f22376f6d59", street: "21/71-79 Avoca Street", suburb: "Randwick", shootDate: "2026-06-16", stageKey: "raw_review", archived: false },
  { id: "8fef7605-a74b-4769-9bf4-df242cbc0a49", street: "24/10A Mears Avenue", suburb: "Randwick", shootDate: "2026-06-16", stageKey: "raw_review", archived: false },
  { id: "bb5240bd-0f10-44e5-bbe1-d4425cc45c51", street: "26/110 Cascade Street", suburb: "Paddington", shootDate: "2026-06-17", stageKey: "raw_review", archived: false },
  { id: "f43414e8-8c8e-4be5-aeff-927209e7b165", street: "50 Moruben Road", suburb: "Mosman", shootDate: "2026-06-17", stageKey: "raw_review", archived: false },
  { id: "38d3055b-0de1-4945-aff5-c9332d49d6a0", street: "154 Prince Edward Street", suburb: "Malabar", shootDate: "2026-06-18", stageKey: "raw_review", archived: false },
  { id: "811d4941-2903-49b1-9dd6-5e8fc46b1ee4", street: "1510/79-81 Berry Street", suburb: "North Sydney", shootDate: "2026-06-22", stageKey: "raw_review", archived: false },
  { id: "380716d4-0fe3-4ab2-a3d3-461926c44bbe", street: "level 1/60 Reservoir Street", suburb: "Surry Hills", shootDate: "2026-06-22", stageKey: "raw_review", archived: false },
  { id: "d0531bb1-a0fa-4e47-bd69-eb72de71fdaf", street: "225 Birrell Street", suburb: "Bronte", shootDate: "2026-06-23", stageKey: "raw_review", archived: false },
  { id: "32bddb53-9535-430c-aa3d-4847a74a0b1e", street: "45 Alma Road", suburb: "Maroubra", shootDate: "2026-06-23", stageKey: "raw_review", archived: false },
  { id: "c59cd672-df92-4630-a38b-f0de5cfdea3c", street: "2/55 Sir Thomas Mitchell Road", suburb: "Bondi Beach", shootDate: "2026-06-24", stageKey: "raw_review", archived: false },
  { id: "e44bae7e-1029-4ba8-bfcf-ad1deb551b3c", street: "5/28 William Street", suburb: "Double Bay", shootDate: "2026-06-24", stageKey: "raw_review", archived: false },
  { id: "19080e10-b0e3-4a37-9779-066159b9191d", street: "53/818 Anzac Parade", suburb: "Maroubra", shootDate: "2026-06-29", stageKey: "raw_review", archived: false },
  { id: "00751ada-99bf-4259-bcfb-3da86f5c8708", street: "10/30 William Street", suburb: "Double Bay", shootDate: "2026-06-30", stageKey: "raw_review", archived: false },
  { id: "9ddfba61-9f60-4aac-a6b0-aa22c8716820", street: "77 Belmont Road", suburb: "Mosman", shootDate: "2026-07-08", stageKey: "raw_review", archived: false },
  { id: "ba9402ca-ab05-49a5-99c7-d79c7f5fed7f", street: "7/2 Marathon Road", suburb: "Darling Point", shootDate: "2026-07-10", stageKey: "raw_review", archived: false },
  { id: "a633bd2f-0500-40e5-a61f-3b80e0e626eb", street: "29 Stanley Street", suburb: "Randwick", shootDate: "2026-07-13", stageKey: "raw_review", archived: false },
  { id: "ee5348a6-d401-483c-9b6f-add4ac3d4455", street: "3/11 Francis Street", suburb: "Bondi Beach", shootDate: "2026-07-13", stageKey: "raw_review", archived: false },
  { id: "1560728c-cdfc-4121-b9dd-b341a21e7f47", street: "30 Canberra Street", suburb: "Randwick", shootDate: "2026-07-13", stageKey: "raw_review", archived: false },
  { id: "a3b2e21e-9db5-4100-9625-57860acdfb79", street: "3/361A Bronte Road", suburb: "Bronte", shootDate: "2026-07-14", stageKey: "raw_review", archived: false },
  { id: "7ded33de-2a47-43fe-be25-cd260ba84d88", street: "45 Vista Street", suburb: "Sans Souci", shootDate: "2026-07-14", stageKey: "raw_review", archived: false },
  { id: "66ce55be-ca90-4679-99ba-d5eb56acd1c3", street: "14 Hume Street", suburb: "Chifley", shootDate: "2026-07-15", stageKey: "raw_review", archived: false },
  { id: "27976da2-ba7c-4d1d-bb0b-098bd4002160", street: "26A O'Connell Avenue", suburb: "Matraville", shootDate: "2026-07-15", stageKey: "raw_review", archived: false },
  { id: "6043e5a2-67f6-422f-ab9a-8ec19b8a318c", street: "192 Clovelly Road", suburb: "Randwick", shootDate: "2026-07-16", stageKey: "raw_review", archived: false },
  { id: "5f444f6d-f531-4769-9373-a774f2c5c698", street: "16/165-167 Victoria Street", suburb: "Potts Point", shootDate: "2026-07-17", stageKey: "raw_review", archived: false },
  { id: "39327022-345f-4ee0-af02-5e7ff8ded8e0", street: "36/65 Avoca Street", suburb: "Randwick", shootDate: "2026-07-20", stageKey: "raw_review", archived: false },
  { id: "b1f5a570-64c4-4912-9fb0-2af244f11b5f", street: "4 McGowen Avenue", suburb: "Malabar", shootDate: "2026-07-20", stageKey: "raw_review", archived: false },
  { id: "6693a8d8-061e-4113-8a24-1b53b2087172", street: "168 Botany Street", suburb: "Kingsford", shootDate: "2026-07-22", stageKey: "raw_review", archived: false },
  { id: "07299597-9b76-40db-81ae-8e51f42a96c4", street: "225-227 Victoria Road", suburb: "Gladesville", shootDate: "2026-07-22", stageKey: "raw_review", archived: false },
  { id: "01e6d5dd-a19a-4662-9c54-4fbb145ba951", street: "243 Victoria Road", suburb: "Gladesville", shootDate: "2026-07-22", stageKey: "raw_review", archived: false },
  { id: "ef8b7914-cd09-49a6-86f5-ab6bf07fd63f", street: "6/120 Beach Street", suburb: "Coogee", shootDate: "2026-07-23", stageKey: "raw_review", archived: false },
  { id: "6c42f8bd-bd8f-418c-b211-f8a5e452cf5b", street: "level 16 suite 1605/520 Oxford Street", suburb: "Bondi Junction", shootDate: "2026-07-24", stageKey: "raw_review", archived: false },
  { id: "e50d6927-bdef-4bcc-89f0-1553765c91d6", street: "28/40 Victoria Street", suburb: "Potts Point", shootDate: "2026-07-27", stageKey: "raw_review", archived: false },
  { id: "29c95076-291c-40c3-89be-532daaced2d2", street: "3/9 Chicago Avenue", suburb: "Maroubra", shootDate: "2026-07-27", stageKey: "raw_review", archived: false },
  { id: "21a3612b-af15-43b4-9624-550c7872a0fd", street: "13 Asquith Avenue", suburb: "Rosebery", shootDate: "2026-07-29", stageKey: "raw_review", archived: false },
  { id: "612499ab-5146-4ac9-89aa-68d4d3df1ee3", street: "38 Carnegie Circuit", suburb: "Chifley", shootDate: "2026-07-29", stageKey: "raw_review", archived: false },
  { id: "fb46affd-2dac-480f-a935-4d4049472fc1", street: "4/16 Salisbury Road", suburb: "Kensington", shootDate: "2026-07-29", stageKey: "raw_review", archived: false },
  { id: "74b6066c-fa43-4212-9752-1ca0ef9e0471", street: "1/27 Wyanbah Road", suburb: "Cronulla", shootDate: "2026-07-30", stageKey: "raw_review", archived: false },
  { id: "c292ba42-a920-48ce-8260-607fc193cdf8", street: "24/53 Ocean Avenue", suburb: "Double Bay", shootDate: "2026-07-30", stageKey: "raw_review", archived: false },
  { id: "24952874-8ef0-4e17-9299-b23fdcc0ce0f", street: "238 Lawrence Street", suburb: "Alexandria", shootDate: "2026-07-31", stageKey: "raw_review", archived: false },
  { id: "ece41b46-d7d5-4551-9bf2-558818358fa7", street: "65 Gladesville Road & 67 Gladesville Road", suburb: "Hunters Hill", shootDate: "2026-07-31", stageKey: "raw_review", archived: false },
  { id: "383c226b-684b-42c3-90ac-19e946d4440c", street: "22 Hardie Street", suburb: "Mascot", shootDate: "2026-08-03", stageKey: "raw_review", archived: false },
  { id: "84db953b-ca49-49c8-8f77-2e923ebd39cd", street: "3/137 Maroubra Road", suburb: "Maroubra", shootDate: "2026-08-03", stageKey: "raw_review", archived: false },
  { id: "c56b936e-25de-4865-bc8e-fc17490db223", street: "119 King Street", suburb: "Mascot", shootDate: "2026-08-04", stageKey: "raw_review", archived: false },
  { id: "6e262834-7fad-41ea-9af1-98fd3d68b941", street: "49 Great Buckingham Street", suburb: "Redfern", shootDate: "2026-08-04", stageKey: "raw_review", archived: false },
  { id: "bbbe193f-e8c7-4e59-8ef4-d93068da307c", street: "3/123 Ocean Street", suburb: "Edgecliff", shootDate: "2026-08-05", stageKey: "raw_review", archived: false },
  { id: "ad6d973b-adfa-4a5a-a3fe-5c390baac129", street: "2/95 Darling Point Road", suburb: "Darling Point", shootDate: "2026-08-07", stageKey: "raw_review", archived: false },
  { id: "90aa36ef-f69d-4c3f-8498-ff7663430ed6", street: "11/164 New South Head Road", suburb: "Edgecliff", shootDate: "2026-08-11", stageKey: "raw_review", archived: false },
  { id: "66edf680-6f0b-40cb-963c-74533cbcccf3", street: "1471 Botany Road", suburb: "Botany", shootDate: "2026-08-12", stageKey: "raw_review", archived: false },
  { id: "eeb01c65-beb8-4548-a546-0e55f00b6037", street: "79 Commonwealth Street", suburb: "Surry Hills", shootDate: "2026-08-12", stageKey: "raw_review", archived: false },
  { id: "6250a7fe-c49a-4c93-aef6-00b32cfe41bf", street: "5/146 Boundary Street", suburb: "Paddington", shootDate: "2026-08-14", stageKey: "raw_review", archived: false },
  { id: "12ff98aa-6269-4157-a547-1c5a031f269c", street: "902/1 Circular Quay", suburb: "Sydney", shootDate: "2026-08-15", stageKey: "raw_review", archived: false },
  { id: "cdb390f3-e364-4352-8860-74c246a88c9b", street: "25-27 John Street", suburb: "Woollahra", shootDate: "2026-08-19", stageKey: "raw_review", archived: false },
  { id: "ac59a913-33c9-4c01-9c57-3fb7d85def82", street: "5 Alkoo Avenue", suburb: "Little Bay", shootDate: "2026-08-20", stageKey: "raw_review", archived: false },
  { id: "80d1708f-e8f5-4bb4-b7d6-61d27f2f2799", street: "8/102 Alison Road", suburb: "Randwick", shootDate: "2026-08-21", stageKey: "raw_review", archived: false },
  { id: "be221cf7-4993-45d0-9d3d-a205d3ec505b", street: "1/21 Mount Street", suburb: "Coogee", shootDate: "2026-08-24", stageKey: "raw_review", archived: false },
  { id: "942b6d17-14a7-4a09-82fe-ff79e7132441", street: "2/7 Loftus Road", suburb: "Darling Point", shootDate: "2026-08-24", stageKey: "raw_review", archived: false },
  { id: "a295cc2f-3f88-4038-8808-b121910d5177", street: "62 Edward Street", suburb: "Bondi", shootDate: "2026-08-24", stageKey: "raw_review", archived: false },
  { id: "fbb0faa5-efab-4591-823c-8836de46d73c", street: "1/6 Holt Street", suburb: "Double Bay", shootDate: "2026-08-26", stageKey: "raw_review", archived: false },
  { id: "005d2199-68f4-4fee-af5d-9a08f1753b49", street: "27 Cabramatta Road", suburb: "Mosman", shootDate: "2026-08-26", stageKey: "raw_review", archived: false },
  { id: "b3b6bf30-980d-4636-9aa8-3aade95152bc", street: "9/2 Frances Street", suburb: "Randwick", shootDate: "2026-08-27", stageKey: "raw_review", archived: false },
  { id: "1ffcecf2-d65e-455c-aaa4-f3bf0c03299b", street: "117 O'Sullivan Road", suburb: "Bellevue Hill", shootDate: "2026-08-28", stageKey: "raw_review", archived: false },
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
