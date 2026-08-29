# TB5A Slice 8 — full proof and deployment preparation

Recorded 2026-08-29 on branch `tb5a-stage-kanban-ordering`, starting at Slice 7 commit `c638f04`.

This slice adds proof and deployment-preparation artifacts only. It is not deployed, and the
implemented-plan status remains unchanged. No production-code defect was found or fixed by the
Slice 8 audits. The pre-existing untracked `qa-evidence/` directory was preserved.

## Added proof suites

- `packages/db/test/tb5a-migration-proof.test.ts` is the single consolidated scratch-D1 pass.
- `packages/db/test/tb5a-compaction-benchmark.test.ts` runs the bounded compaction measurements.
- `packages/db/test/tb5a-proof-support.ts` is test-only shared SQLite/Wrangler setup; it does not
  ship in a Worker bundle.

The consolidated pass covers the full `0000..0037` chain, foreign keys, `quick_check`, the
representative `0036→0037` seed (null Priority, ties, fractional positions, an inactive Stage
occupant, and archived rows), exact visible order, `board_revision = 1` for every unarchived
project, archived-row preservation, Wrangler breakpoint splitting, preflight journal fencing,
postflight rollback through a temporary `RAISE(IGNORE)` trigger, all-or-zero pre-enable
restoration, byte-identical normative SQL, valid non-compacting/compacting winners, malformed
compacting plans, and `MATERIALIZE fence` in both query plans.

## Repository-audit classification

| ID | Audit | Classification |
|---|---|---|
| A1 | capability and writer names | PASS. Stage UI/API routes through `moveProjectStage`; RAW selection retains `selectForEditing`; same-Stage ordering uses Admin-only `prioritizeProjects`. Shared schemas, projections, and tests are benign matches. |
| A2 | Stage assignment patterns | PASS. The only production Stage/position writes are the DB-owned winner SQL, app project creation, archive/restore, and the documented Tonomo insert exception. Reads, DTO projections, and test fixture updates are benign matches. |
| A3 | Board-state references | PASS. Production reads/projections and mutation paths carry the Board revision contract; direct test setup updates are fixtures, not writers. |
| A4 | legacy ordering helpers / Priority coupling | PASS. No legacy helper remains. Remaining Priority/Board matches are canonical sorting or test characterization; no Priority-to-position production path remains. |
| A5 | legacy activity/notification patterns | PASS. One human `project.stage.changed` producer exists with the empty payload; workflow-only `sent_to_editing` notifications remain. No manual Delivered/Editing legacy notification was found. Priority activity is the separate metadata route. |
| A6 | bare full-object `projects` selects | PASS — no matches. |
| A7 | Admin Board backfill route/action | PASS — no matches. |
| A8 | migration-only objects in schema/snapshot | PASS — no matches. |

The additional contract checks also passed: both Stage route forms are registered; no invalid
root-mounted wildcard middleware was found (the `/api/*` app middleware and path-scoped nested
middleware are intentional); the TB4E manifest has strict external-surface probes; strict External
DTOs and authorized order maps are present; and the DB bundle exports are complete.

## Full raw audit output

### A1

```text
$ rg -n 'selectForEditing|moveProjectStage|prioritizeProjects' portal/packages/shared portal/apps/web portal/workers
portal/packages/shared/src/stage-move.ts:129:export const moveProjectStageRequestSchema = z.object({
portal/packages/shared/src/stage-move.ts:140:export function moveProjectStageRequestSchemaForProject(projectId: string) {
portal/packages/shared/src/stage-move.ts:141:  return moveProjectStageRequestSchema.superRefine((request, context) => {
portal/packages/shared/src/stage-move.ts:182:export const moveProjectStageResponseSchema = z.object({
portal/packages/shared/src/stage-move.ts:201:export const moveProjectStageConflictResponseSchema = stageMoveConflictResponseSchema;
portal/packages/shared/src/stage-move.ts:228:  error: "Forbidden: manual Board reorder requires prioritizeProjects.";
portal/packages/shared/src/stage-move.ts:230:  capability: "prioritizeProjects";
portal/packages/shared/src/project-activity.ts:183:  "project.stage.changed": live("stage", "moveProjectStage", ["workers/app/src/lib/project-stage.ts#moveProjectStage"], "project_stage", "project-stage:<projectId>:transition:<activityId>", "project", payloadSchemas["project.stage.changed"]),
portal/workers/app/src/routes/review.ts:146:    else if (asset.kind === "raw" && !roleHasCapability(user.role, "selectForEditing")) return c.json({ error: "Forbidden", capability: "selectForEditing" }, 403);
portal/workers/app/src/routes/review.ts:151:reviewRoutes.post("/assets/:id/select", requireCapability("selectForEditing"), terminalRoute("/assets/:id/select", async (c) => {
portal/workers/app/src/routes/review.ts:154:reviewRoutes.delete("/assets/:id/select", requireCapability("selectForEditing"), terminalRoute("/assets/:id/select", async (c) => { const id = c.req.param("id"); const asset = await assetContext(c, id); if (!asset) return c.json({ error: "Asset not found" }, 404); const unavailable = unavailableAsset(c, asset); if (unavailable) return unavailable; if (!await hasProjectAccess(c, asset.projectId)) return c.json({ error: "Forbidden: you are not assigned to this project" }, 403); if (asset.kind !== "raw") return c.json({ error: "Only RAW assets can be selected for editing" }, 400); await createDb(c.env.DB).delete(schema.selections).where(eq(schema.selections.assetId, id)); await audit(c.env, c.get("user"), "asset.unselect", "asset", id); return c.json({ ok: true }); }));
portal/packages/shared/src/capabilities.ts:29:  "selectForEditing",
portal/packages/shared/src/capabilities.ts:43:  "prioritizeProjects",
portal/packages/shared/src/capabilities.ts:44:  "moveProjectStage",
portal/packages/shared/src/capabilities.ts:58:  "moveProjectStage",
portal/packages/shared/src/capabilities.ts:85:    "selectForEditing",
portal/packages/shared/src/capabilities.ts:99:    "prioritizeProjects",
portal/packages/shared/src/capabilities.ts:100:    "moveProjectStage",
portal/packages/shared/src/capabilities.ts:110:    "selectForEditing",
portal/packages/shared/src/capabilities.ts:120:    "moveProjectStage",
portal/apps/web/src/screens/ProjectWorkspace.tsx:397:  const isEdited = activeTab === "edited"; const canUpload = can("uploadRaw"), canSelect = can("selectForEditing"), canEdit = can("editProject"), canManageCollections = can("editProject") || can("manageExtras"), canDeleteAssets = can("adminBackend");
portal/apps/web/src/screens/ProjectWorkspace.tsx:398:  const canReview = isEdited ? can("reviewEdited") : can("selectForEditing"); const canRecommend = activeTab === "raw" && can("recommendRaw"); const canAnnotate = activeTab === "raw" ? can("annotateRaw") : isEdited && can("annotateEdited");
portal/apps/web/src/screens/ProjectWorkspace.tsx:411:    if (stageMovePending || !can("moveProjectStage") || project.archivedAt || !project.contractEnabled) return;
portal/apps/web/src/screens/ProjectWorkspace.tsx:461:    <section className="workmain"><div className="wsbar"><InternalLink className="chip" to="/">← Dashboard</InternalLink><span className="ey">{activeTab === "raw" ? `RAW capture · ${rawCollection?.receivedCount ?? 0} received` : `${collectionLabel(activeTab)} collection`}</span><div className="grow" /></div>{props.ingest?.mismatch && <div className="ingest-warning" role="alert"><strong>Capture count needs attention.</strong> Expected {props.ingest.expectedCount}, received {props.ingest.receivedCount}.</div>}{activeTab === "raw" || activeTab === "edited" ? <><div className="workspace-intro"><div><div className="ey">{activeTab === "raw" ? "Capture QA" : "Edited QA"}</div><h1 className="serif">{activeTab === "raw" ? "RAW frames" : "Edited frames"}</h1></div><div className="muted">{activeTab === "raw" ? "Ratings from XMP are shown at ingest. Select the strongest frames for editing." : "Review delivered edits before they move to client delivery."}</div></div>{props.canAdminBackend && activeTab === "raw" && canSelect && <div className="hdr"><div className="grow"><strong>AutoHDR hand-off</strong><div className="muted">{selectionCount} selected RAW frame{selectionCount === 1 ? "" : "s"} will be sent for editing.</div></div><div className="row gap2"><button className="button button--secondary" type="button" disabled={selectionCount === 0} onClick={() => { const link = document.createElement("a"); link.href = `/api/projects/${encodeURIComponent(project.id)}/selected-raw.zip`; link.download = ""; document.body.append(link); link.click(); link.remove(); }}>{`Download ${selectionCount} selected (zip)`}</button><button className="button" type="button" disabled={selectionCount === 0 || props.isSending || autoHdrApiSendActive} onClick={props.onSendToAutoHdr}>{props.isSending || autoHdrApiSendActive ? "Sending to AutoHDR…" : `Send ${selectionCount} selected to AutoHDR`}</button></div></div>}{props.canAdminBackend && activeTab === "edited" && <div className="hdr" role="status"><div className="grow"><strong>AutoHDR status</strong><div className="muted"><span>{autohdrStatusLabel}</span></div><div className="muted">{autohdrMessage}</div></div></div>}{activeTab === "raw" && canUpload && <div className="workgrid"><UploadDropzone projectId={project.id} collection="raw" onComplete={() => props.onUploadComplete("raw")} onToast={toast} /></div>}{activeTab === "edited" && can("uploadEdited") && <div className="workgrid">{hasRawFolder ? <UploadDropzone projectId={project.id} collection="edited" onComplete={() => props.onUploadComplete("edited")} onToast={toast} /> : <div className="empty" role="status"><span className="serif">No Dropbox RAW folder for this shoot.</span>Edited uploads are published to Dropbox before they appear here.</div>}</div>}{props.assetsPending ? <div className="empty" role="status"><span className="serif">Loading collection.</span>Reading this collection's assets.</div> : <PhotoGrid key={activeTab} assets={assets} showSections={activeTab === "raw" || activeTab === "edited"} canReview={canReview} canRecommend={canRecommend} canSelect={activeTab === "raw" && canSelect} canSetCover={canEdit && (activeTab === "raw" || activeTab === "edited")} canDelete={canDeleteAssets} canDownloadSelection={activeTab === "raw" ? can("selectForEditing") : can("downloadFinal")} coverAssetId={project.effectiveCoverAssetId} storedCoverAssetId={project.coverAssetId} onSetCover={updateCover} onOpen={(asset, orderedAssets) => { setLightboxOrderIds(orderedAssets.map((item) => item.id)); setOpenAssetId(asset.id); }} onReview={updateReview} onSelection={updateSelection} onDelete={deleteOne} onBulkDelete={deleteMany} onDownloadSelection={downloadSelection} />}</> : <CollectionPanel projectId={project.id} collection={activeTab as "video" | "floorplan" | "copy"} assets={assets} canManage={canManageCollections} canDelete={canDeleteAssets} canApprove={can("reviewEdited")} onReview={updateReview} onDelete={deleteOne} onLinksChanged={props.onLinksChanged} onDocumentsChanged={props.onDocumentsChanged} onToast={toast} />}{props.canAdminBackend && props.jobs.length > 0 && <div className="workgrid"><section className="hdr" style={{ alignItems: "flex-start", flexDirection: "column" }}><div><strong>AutoHDR status</strong><div className="muted">Recent API sends, legacy hand-offs, fetches, and manual-upload publishes for this project.</div></div>{props.jobs.map((job) => <div className="kv" style={{ width: "100%" }} key={job.id}><span className="k">{new Date(job.createdAt).toLocaleString("en-AU")}</span><span className="vv"><span className="k">{job.kind === "autohdr_api_send" ? "API send" : job.kind === "fetch_edited" ? "Fetch" : job.kind === "autohdr_scaffold" ? "Scaffold" : job.kind === "manual_edited_publish" || job.kind === "manual_raw_publish" ? "Manual upload" : "Send"}</span>{" "}<span className={`statetag st-${job.status}`}>{job.status}</span>{job.error ? ` ${job.error}` : ""}{job.kind !== "autohdr_api_send" && (job.status === "stuck" || job.status === "failed") && <button className="chip" style={{ marginLeft: 8 }} type="button" onClick={() => props.onRetryAutoHdr(job.id)}>Retry</button>}</span></div>)}</section></div>}</section>
portal/apps/web/src/screens/Dashboard-stage-interactions.dom.test.tsx:18:  useCapabilities: () => ({ role: authState.role, capabilities: authState.role === "admin" ? ["moveProjectStage", "prioritizeProjects"] : ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" || (capability === "prioritizeProjects" && authState.role === "admin") }),
portal/apps/web/src/screens/Dashboard-stage-interactions.dom.test.tsx:98:  it("does not offer same-column reorder to an Editor without prioritizeProjects", async () => {
portal/workers/app/src/routes/projects.ts:6:import { COLLECTION_KINDS, DOWNLOAD_SELECTION_MAX_ASSETS, DOWNLOAD_SELECTION_MAX_BYTES, moveProjectStageRequestSchemaForProject, PHOTOGRAPHER_VISIBLE_STAGES, PROJECT_ASSIGNMENT_ELIGIBLE_ROLES, projectActivityDeepLink, publishNotificationOutbox, roleHasCapability, type CollectionKind, type MoveProjectStageRequest, type ProjectActivityIntent, type ProjectMemberRole, type ProjectMembershipDto, type Role, type StageKey, type StageTransportKey } from "@quincy/shared";
portal/workers/app/src/routes/projects.ts:21:import { moveProjectStage } from "../lib/project-stage";
portal/workers/app/src/routes/projects.ts:117:  const capability = collection === "raw" ? "selectForEditing" : "downloadFinal";
portal/workers/app/src/routes/projects.ts:406:  if (!roleHasCapability(c.get("user").role, "prioritizeProjects")) return c.json({ error: "Forbidden", capability: "prioritizeProjects" }, 403);
portal/workers/app/src/routes/projects.ts:813:  if (!roleHasCapability(c.get("user").role, "selectForEditing")) return c.json({ error: "Forbidden", capability: "selectForEditing" }, 403);
portal/workers/app/src/routes/projects.ts:1101:  const parsed = moveProjectStageRequestSchemaForProject(id).safeParse(body);
portal/workers/app/src/routes/projects.ts:1103:  const result = await moveProjectStage({ env: c.env, principal: c.get("user"), projectId: id, request: parsed.data as MoveProjectStageRequest });
portal/workers/app/src/routes/projects.ts:1110:  if (result.kind === "reorder_forbidden") return c.json({ error: "Forbidden: manual Board reorder requires prioritizeProjects.", code: result.code, capability: result.capability }, 403);
portal/apps/web/src/screens/Dashboard-kanban-sort.dom.test.tsx:12:  useCapabilities: () => ({ role: "admin", capabilities: ["prioritizeProjects"], can: (capability: string) => capability === "prioritizeProjects" }),
portal/apps/web/src/screens/Dashboard.tsx:241:  const canMoveStagesCapability = can("moveProjectStage");
portal/apps/web/src/screens/Dashboard.tsx:242:  const canPrioritize = can("prioritizeProjects");
portal/apps/web/src/components/ProjectOverviewRail.dom.test.tsx:12:  useCapabilities: () => ({ role: roleState.role, capabilities: roleState.role === "photographer" ? [] : ["moveProjectStage"], can: (capability: string) => capability === "moveProjectStage" && roleState.role !== "photographer" }),
portal/workers/app/src/lib/project-board-order.ts:62:  | { kind: "forbidden"; capability: "prioritizeProjects" }
portal/workers/app/src/lib/project-board-order.ts:322:  if (!principal || !roleHasCapability(principal.role, "prioritizeProjects")) return { kind: "forbidden", capability: "prioritizeProjects" };
portal/packages/shared/test/capabilities.test.ts:12:      "moveProjectStage",
portal/packages/shared/test/capabilities.test.ts:17:    expect(roleHasCapability("external_editor", "moveProjectStage")).toBe(true);
portal/packages/shared/test/capabilities.test.ts:42:    for (const capability of ["viewEdited", "publish", "selectForEditing", "adminBackend"] as const) {
portal/packages/shared/test/capabilities.test.ts:75:    expect(ROLE_CAPABILITIES.admin).toContain("prioritizeProjects");
portal/packages/shared/test/capabilities.test.ts:76:    expect(ROLE_CAPABILITIES.editor).not.toContain("prioritizeProjects");
portal/packages/shared/test/capabilities.test.ts:77:    expect(ROLE_CAPABILITIES.photographer).not.toContain("prioritizeProjects");
portal/packages/shared/test/capabilities.test.ts:81:    expect(roleHasCapability("admin", "moveProjectStage")).toBe(true);
portal/packages/shared/test/capabilities.test.ts:82:    expect(roleHasCapability("editor", "moveProjectStage")).toBe(true);
portal/packages/shared/test/capabilities.test.ts:83:    expect(roleHasCapability("external_editor", "moveProjectStage")).toBe(true);
portal/packages/shared/test/capabilities.test.ts:84:    expect(roleHasCapability("photographer", "moveProjectStage")).toBe(false);
portal/packages/shared/test/capabilities.test.ts:88:    expect(roleHasCapability("admin", "selectForEditing")).toBe(true);
portal/packages/shared/test/capabilities.test.ts:89:    expect(roleHasCapability("editor", "selectForEditing")).toBe(true);
portal/packages/shared/test/capabilities.test.ts:90:    expect(roleHasCapability("external_editor", "selectForEditing")).toBe(false);
portal/packages/shared/test/capabilities.test.ts:91:    expect(roleHasCapability("photographer", "selectForEditing")).toBe(false);
portal/packages/shared/test/capabilities.test.ts:92:    expect(roleHasCapability("admin", "prioritizeProjects")).toBe(true);
portal/packages/shared/test/capabilities.test.ts:93:    expect(roleHasCapability("editor", "prioritizeProjects")).toBe(false);
portal/packages/shared/test/capabilities.test.ts:94:    expect(roleHasCapability("external_editor", "prioritizeProjects")).toBe(false);
portal/packages/shared/test/capabilities.test.ts:95:    expect(roleHasCapability("photographer", "prioritizeProjects")).toBe(false);
portal/workers/app/src/lib/project-stage.ts:52:  | { kind: "forbidden"; capability: "moveProjectStage" }
portal/workers/app/src/lib/project-stage.ts:53:  | { kind: "reorder_forbidden"; code: "project_board_reorder_forbidden"; capability: "prioritizeProjects" }
portal/workers/app/src/lib/project-stage.ts:109:  if (result.kind === "forbidden") return { kind: "forbidden", capability: "moveProjectStage" };
portal/workers/app/src/lib/project-stage.ts:131:export async function moveProjectStage(input: MoveProjectStageInput): Promise<MoveProjectStageResult> {
portal/workers/app/src/lib/project-stage.ts:137:  if (!principal.active || !roleHasCapability(principal.role, "moveProjectStage")) return { kind: "forbidden", capability: "moveProjectStage" };
portal/workers/app/src/lib/project-stage.ts:159:    if (!roleHasCapability(principal.role, "prioritizeProjects")) return { kind: "reorder_forbidden", code: "project_board_reorder_forbidden", capability: "prioritizeProjects" };
portal/workers/app/test/api.test.ts:881:    await expect(me.json()).resolves.toMatchObject({ user: { role: "external_editor", authorizationEpoch: 0 }, capabilities: ["uploadEdited", "viewRaw", "annotateRaw", "recommendRaw", "compareFrames", "viewEdited", "reviewEdited", "annotateEdited", "collaborateOnProject", "moveProjectStage"] });
portal/workers/app/test/api.test.ts:1998:    const photographerRaw = await post(await sessionCookie(firstPhotographerToken), [rawAssets[0]!.id]); expect(photographerRaw.status).toBe(403); await expect(photographerRaw.json()).resolves.toMatchObject({ capability: "selectForEditing" });
portal/workers/app/test/api.test.ts:2046:    await database.DB.prepare("UPDATE user SET role = 'photographer' WHERE id = ?").bind(changingUserId).run(); const downgraded = await SELF.fetch(`https://portal.test${downgradeUrl}`, { headers: { cookie: changingCookie } }); expect(downgraded.status).toBe(403); await expect(downgraded.json()).resolves.toMatchObject({ capability: "selectForEditing" });
portal/workers/app/test/api.test.ts:3553:        error: "Forbidden: manual Board reorder requires prioritizeProjects.",
portal/workers/app/test/api.test.ts:3555:        capability: "prioritizeProjects",
portal/packages/shared/test/project-activity.test.ts:107:      producerOwner: "moveProjectStage",
portal/packages/shared/test/project-activity.test.ts:108:      producerCallSites: ["workers/app/src/lib/project-stage.ts#moveProjectStage"],
portal/apps/web/src/components/ProjectOverviewRail.tsx:81:  const canMoveStage = can("moveProjectStage") && !project.archivedAt;
portal/packages/shared/test/stage-move.test.ts:6:  moveProjectStageConflictResponseSchema,
portal/packages/shared/test/stage-move.test.ts:7:  moveProjectStageRequestSchema,
portal/packages/shared/test/stage-move.test.ts:8:  moveProjectStageRequestSchemaForProject,
portal/packages/shared/test/stage-move.test.ts:9:  moveProjectStageResponseSchema,
portal/packages/shared/test/stage-move.test.ts:73:    expect(moveProjectStageRequestSchema.parse(validRequest)).toEqual(validRequest);
portal/packages/shared/test/stage-move.test.ts:74:    expect(moveProjectStageRequestSchema.parse({
portal/packages/shared/test/stage-move.test.ts:78:    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, extra: true }).success).toBe(false);
portal/packages/shared/test/stage-move.test.ts:82:    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, expected: { ...validRequest.expected, boardRevision: -1 } }).success).toBe(false);
portal/packages/shared/test/stage-move.test.ts:83:    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, expected: { ...validRequest.expected, boardRevision: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
portal/packages/shared/test/stage-move.test.ts:84:    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, placement: { ...validRequest.placement, before: { ...validRequest.placement.before!, projectId: "not-a-uuid" } } }).success).toBe(false);
portal/packages/shared/test/stage-move.test.ts:85:    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, confirmation: { reasons: ["editing_boundary", "editing_boundary"] } }).success).toBe(false);
portal/packages/shared/test/stage-move.test.ts:86:    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, placement: { ...validRequest.placement, after: { ...validRequest.placement.before! } } }).success).toBe(false);
portal/packages/shared/test/stage-move.test.ts:90:    expect(moveProjectStageRequestSchemaForProject(targetProjectId).safeParse({
portal/packages/shared/test/stage-move.test.ts:94:    expect(moveProjectStageRequestSchemaForProject(targetProjectId).safeParse(validRequest).success).toBe(true);
portal/packages/shared/test/stage-move.test.ts:103:    expect(moveProjectStageResponseSchema.safeParse(response).success).toBe(true);
portal/packages/shared/test/stage-move.test.ts:104:    expect(moveProjectStageConflictResponseSchema.safeParse({ error: "Conflict", code: "project_stage_conflict", current: response.project }).success).toBe(true);
portal/packages/shared/test/stage-move.test.ts:105:    expect(moveProjectStageConflictResponseSchema.safeParse({ error: "Conflict", code: "project_stage_conflict", current: { ...response.project, projectId: "not-a-uuid" } }).success).toBe(false);
```

### A2

```text
$ rg -n 'SET stage_key|stageKey:|stage_key =|update\(.*projects.*stage' portal/apps portal/workers portal/packages -g '*.ts'
portal/workers/app/src/routes/project-comments.ts:75:  const project = await db.select({ id: schema.projects.id, street: schema.projects.street, stageKey: schema.projects.stageKey }).from(schema.projects).where(eq(schema.projects.id, projectId)).get();
portal/workers/app/src/routes/project-comments.ts:82:      project: { id: project.id, street: project.street, stageKey: stageTransportKeyForRole(project.stageKey as StageKey, "external_editor") },
portal/workers/app/src/routes/project-comments.ts:92:    project: { id: project.id, street: project.street, stageKey: projectStageForRole(project, c.get("user").role).stageKey },
portal/workers/app/src/routes/projects.ts:42:function isExactLegacyStageBody(body: unknown): body is { stageKey: string } {
portal/workers/app/src/routes/projects.ts:204:function authorizedInternalBoardOrder(rows: Array<{ project: { id: string; stageKey: string; priority: number | null; boardPosition: number } }>, role: Role): Partial<Record<StageTransportKey, string[]>> {
portal/workers/app/src/routes/projects.ts:247:    stageKey: "awaiting_raw", priority: null, boardPosition: 0, boardRevision: 0, orderNo: data.orderNo ?? null, orderId: data.orderId ?? null,
portal/workers/app/src/routes/projects.ts:288:      (SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = 'awaiting_raw' AND archived_at IS NULL AND id != ?),
portal/workers/app/src/routes/projects.ts:412:  `).bind(id).first<{ id: string; stageKey: StageKey; priority: number | null; boardPosition: number; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:428:      AND stage_key = ?4 AND board_position IS ?5 AND board_revision = ?6
portal/workers/app/src/routes/projects.ts:438:    const current = await c.env.DB.prepare("SELECT priority, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NULL").bind(id).first<{ priority: number | null; stageKey: StageKey; boardPosition: number; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:523:  const updateWhere = ["id = ?", "stage_key = ?", "archived_at IS NULL", `(${snapshotPredicate})`, `(${changePredicate})`, removalSafe].join(" AND ");
portal/workers/app/src/routes/projects.ts:983:    const source = await c.env.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NULL").bind(id).first<{ stageKey: StageKey; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:993:        c.env.DB.prepare("UPDATE projects SET archived_at = ?, archived_by = ?, board_revision = board_revision + 1, updated_at = ? WHERE id = ? AND archived_at IS NULL AND stage_key = ? AND board_revision = ? AND NOT EXISTS (SELECT 1 FROM document_uploads WHERE project_id = ? AND status in ('pending', 'completing', 'aborting')) RETURNING id")
portal/workers/app/src/routes/projects.ts:1025:    const source = await c.env.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NOT NULL").bind(id).first<{ stageKey: StageKey; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:1031:      c.env.DB.prepare("UPDATE projects SET archived_at = NULL, archived_by = NULL, board_position = (SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id != ?), board_revision = board_revision + 1, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL AND stage_key = ? AND board_revision = ? RETURNING id").bind(source.stageKey, id, now.getTime(), id, source.stageKey, source.boardRevision),
portal/apps/web/src/lib/external-api-response.ts:37:    stageKey: project.stageKey,
portal/apps/web/src/lib/external-api-response.ts:64:    stageKey: project.stageKey,
portal/workers/app/src/routes/stages.ts:28:export function projectStageForRole<T extends { stageKey: string }>(project: T, role: AppEnv["Variables"]["user"]["role"]): T {
portal/workers/app/src/routes/stages.ts:30:    ? { ...project, stageKey: "editing" } as T
portal/workers/app/test/api.test.ts:274:async function setFixtureStage(fixture: VisibilityFixture, stageKey: string) {
portal/workers/app/test/api.test.ts:275:  await database.DB.prepare("UPDATE projects SET stage_key = ?, updated_at = ? WHERE id = ?")
portal/workers/app/test/api.test.ts:281:    .bind(projectId).first<{ stageKey: string; boardRevision: number }>();
portal/workers/app/test/api.test.ts:283:    expected: { stageKey: expectedStageKey ?? current?.stageKey, boardRevision: current?.boardRevision },
portal/workers/app/test/api.test.ts:777:    await expect(reverted.json()).resolves.toMatchObject({ project: { stageKey: "raw_review" } });
portal/workers/app/test/api.test.ts:839:    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered', notes = ?, production_notes = ?, raw_folder_path = ? WHERE id = ?")
portal/workers/app/test/api.test.ts:962:    await database.DB.prepare("UPDATE projects SET stage_key = 'edited_review' WHERE id = ?").bind(delivered).run();
portal/workers/app/test/api.test.ts:1930:    await database.DB.prepare("UPDATE projects SET stage_key = ? WHERE id = ?").bind("edited_review", project.id).run();
portal/workers/app/test/api.test.ts:1934:    await expect(response.json()).resolves.toMatchObject({ project: { stageKey: "raw_review" } });
portal/workers/app/test/api.test.ts:2001:    await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr' WHERE id = ?").bind(project.id).run();
portal/workers/app/test/api.test.ts:2827:    const project = await created.json() as { id: string; stageKey: string };
portal/workers/app/test/api.test.ts:2828:    await database.DB.prepare("UPDATE projects SET stage_key = ? WHERE id = ?").bind("editing_autohdr", project.id).run();
portal/workers/app/test/api.test.ts:2841:    const stageFor = async (response: Response) => (await response.json() as { projects: Array<{ id: string; stageKey: string }> }).projects.find((item) => item.id === project.id)?.stageKey;
portal/workers/app/test/api.test.ts:2849:    await expect(adminDetail.json()).resolves.toMatchObject({ stageKey: "editing_autohdr" });
portal/workers/app/test/api.test.ts:2850:    await expect(editorDetail.json()).resolves.toMatchObject({ stageKey: "editing" });
portal/workers/app/test/api.test.ts:2878:    await expect(internalStageMove.json()).resolves.toMatchObject({ project: { stageKey: "editing" } });
portal/workers/app/test/api.test.ts:2884:    await expect(adminMutation.json()).resolves.toMatchObject({ project: { stageKey: "editing_autohdr" } });
portal/workers/app/test/api.test.ts:2928:    const unusedStage = await database.DB.prepare("SELECT count(*) AS count FROM projects WHERE stage_key = ? AND archived_at IS NULL").bind(activationKey).first<{ count: number }>();
portal/workers/app/test/api.test.ts:2950:    await database.DB.prepare("UPDATE projects SET stage_key = ?, updated_at = ? WHERE id = ?").bind("raw_review", Date.now(), guardProject.id).run();
portal/workers/app/test/api.test.ts:2951:    const projectCountRow = await database.DB.prepare("SELECT count(*) AS count FROM projects WHERE stage_key = ? AND archived_at IS NULL").bind("raw_review").first<{ count: number }>();
portal/workers/app/test/api.test.ts:2970:      await expect(inactiveTarget.json()).resolves.toMatchObject({ code: "inactive_destination", current: { stageKey: "awaiting_raw" } });
portal/workers/app/test/api.test.ts:3534:      expected: { stageKey: "awaiting_raw", boardRevision: 0 },
portal/workers/app/test/project-deadline.test.ts:94:    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(projectId).run();
portal/workers/app/test/project-deadline.test.ts:311:    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(deliveredProjectId).run();
portal/workers/app/test/project-deadline.test.ts:314:    await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr' WHERE id = ?").bind(deliveredProjectId).run();
portal/workers/app/test/project-deadline.test.ts:344:      expected: { stageKey: "editing_autohdr", boardRevision: 0 },
portal/workers/app/test/project-deadline.test.ts:355:    expect(await database.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ?").bind(projectIdForRace).first()).toEqual({ stageKey: "editing_autohdr", boardRevision: 0 });
portal/workers/app/test/project-deadline.test.ts:359:    expect(await database.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ?").bind(projectIdForRace).first()).toEqual({ stageKey: "delivered", boardRevision: 1 });
portal/apps/web/src/lib/project-query-sync.test.ts:165:    receiverClient.setQueryData(summaryKey, { project: { id: "p", street: "P", stageKey: "raw_review" }, members: [] });
portal/apps/web/src/lib/stage-move.test.ts:7:  expected: { stageKey: "awaiting_raw", boardRevision: 4 },
portal/workers/app/src/lib/ingest.ts:232:        "SELECT board_revision AS boardRevision FROM projects WHERE id = ? AND stage_key = 'awaiting_raw' AND archived_at IS NULL",
portal/workers/app/src/lib/ingest.ts:235:        "SELECT id AS projectId, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE stage_key = 'raw_review' AND archived_at IS NULL AND id <> ? ORDER BY board_position, id",
portal/workers/app/src/lib/ingest.ts:273:          && winner.stage_key === "raw_review"
portal/workers/app/src/lib/ingest.ts:282:            row: { projectId: winner.id, stageKey: winner.stage_key as "raw_review", boardPosition: winner.board_position, boardRevision: winner.board_revision },
portal/apps/web/src/lib/project-data.ts:15:  shootDate: string | null; stageKey: ProjectStageKey; rawFolderPath: string | null; rawFolderLink: string | null; productionNotes?: string | null; editedUploadAvailable?: boolean; archivedAt?: string | number | null; boardRevision: number; contractEnabled: boolean;
portal/apps/web/src/lib/project-data.ts:249:  project: { id: string; street: string; stageKey: ProjectDetail["stageKey"] };
portal/apps/web/src/lib/external-api-response.characterization.test.ts:15:    stageKey: "awaiting_raw" as const,
portal/apps/web/src/lib/external-api-response.characterization.test.ts:30:			.map((project) => ({ ...project, stageKey: "awaiting_raw" as const }));
portal/apps/web/src/lib/external-api-response.characterization.test.ts:47:			stageKey: "awaiting_raw",
portal/packages/shared/src/external-project-dto.ts:111:  stageKey: z.enum(STAGE_PRESENTATION_KEYS),
portal/packages/shared/src/external-project-dto.ts:201:    allDay: z.boolean(), project: z.object({ id: uuid, street: z.string(), stageKey: z.string() }).strict(),
portal/packages/shared/src/external-project-dto.ts:274:  collaboration: z.object({ project: z.object({ id: uuid, street: z.string(), stageKey: z.string() }).strict(), members: z.array(externalParticipantSchema.extend({ assignedSubtaskCount: z.number().int().nonnegative() }).strict()) }).strict(),
portal/workers/app/src/lib/project-stage.ts:63:  return row ? { projectId: row.id, stageKey: stageTransportKeyForRole(row.stageKey, role), boardRevision: row.boardRevision } : null;
portal/workers/app/src/lib/project-stage.ts:75:    project: { projectId: row.id, stageKey: stageTransportKeyForRole(row.stageKey, role), boardRevision: row.boardRevision },
portal/packages/shared/src/stage-move.ts:118:    stageKey: StageTransportKey;
portal/packages/shared/src/stage-move.ts:131:    stageKey: stageTransportKeySchema,
portal/packages/shared/src/stage-move.ts:154:  stageKey: StageTransportKey;
portal/packages/shared/src/stage-move.ts:172:  stageKey: stageTransportKeySchema,
portal/workers/app/src/lib/external-project-query.ts:21:  stageKey: string;
portal/workers/app/src/lib/external-project-query.ts:84:      shootDate: row.shootDate, timeWindow: row.timeWindow, stageKey: row.stageKey,
portal/workers/app/src/lib/external-project-query.ts:106:    stageKey: stageTransportKeyForRole(project.stageKey as StageKey, "external_editor"),
portal/packages/shared/test/external-project-policy.test.ts:46:      stageKey: "edited_review",
portal/packages/shared/test/external-project-policy.test.ts:55:    expect(externalProjectSummarySchema.safeParse({ ...summary, stageKey: "editing" }).success).toBe(true);
portal/packages/shared/test/external-project-policy.test.ts:56:    expect(externalProjectSummarySchema.safeParse({ ...summary, stageKey: "editing_autohdr" }).success).toBe(false);
portal/packages/shared/test/external-project-policy.test.ts:57:    expect(externalProjectSummarySchema.safeParse({ ...summary, stageKey: "unknown-stage" }).success).toBe(false);
portal/packages/shared/test/external-project-policy.test.ts:60:    expect(externalProjectSummarySchema.safeParse({ ...summary, stageKey: externalEditing }).success).toBe(true);
portal/packages/shared/test/external-project-policy.test.ts:83:    expect(externalProjectListResponseSchema.safeParse({ ...list, projects: [{ ...summary, stageKey: "editing_autohdr" }] }).success).toBe(false);
portal/packages/shared/test/external-project-policy.test.ts:84:    expect(externalProjectDetailSchema.safeParse({ ...detail, stageKey: "editing_autohdr" }).success).toBe(false);
portal/workers/app/src/lib/project-deadline.ts:30:  stageKey: string;
portal/workers/background/src/tonomo/process.ts:110:    stageKey: "awaiting_raw", boardPosition: appendToStageBottomExpr("awaiting_raw", id), boardRevision: 0, createdAt: now, updatedAt: now,
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:11:  stageKey: "awaiting_raw",
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:48:			{ ...project, id: "source", stageKey: "awaiting_raw" as const, boardRevision: 3, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:49:			{ ...project, id: "before", stageKey: "raw_review" as const, boardRevision: 8, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:50:			{ ...project, id: "target", stageKey: "raw_review" as const, boardRevision: 9, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:51:			{ ...project, id: "after", stageKey: "raw_review" as const, boardRevision: 10, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
portal/workers/app/src/lib/project-board-order.ts:32:  stageKey: StageKey;
portal/workers/app/src/lib/project-board-order.ts:47:  expectedTarget: Array<{ projectId: string; stageKey: StageKey; boardPosition: number; boardRevision: number; newBoardPosition?: number }>;
portal/workers/app/src/lib/project-board-order.ts:89:    stageKey: stageTransportKeyForRole(row.stageKey, role),
portal/workers/app/src/lib/project-board-order.ts:105:      stageKey: stageTransportKeyForRole(target.stageKey, role),
portal/workers/app/src/lib/project-board-order.ts:124:export async function readBoardRows(db: D1Database, stageKey: StageKey): Promise<BoardProjectRow[]> {
portal/workers/app/src/lib/project-board-order.ts:129:    WHERE stage_key = ? AND archived_at IS NULL
portal/workers/app/src/lib/project-board-order.ts:134:export async function readVisibleBoardRows(db: D1Database, principal: Pick<SessionUser, "id" | "role">, stageKey: StageKey): Promise<BoardProjectRow[]> {
portal/workers/app/src/lib/project-board-order.ts:148:    WHERE p.stage_key = ? AND p.archived_at IS NULL${stageVisibility}${membership}
portal/workers/app/src/lib/project-board-order.ts:204:  destination.splice(insertionIndex, 0, { ...target, stageKey: requestedDestinationStage });
portal/workers/app/src/lib/project-board-order.ts:223:        stageKey: row.stageKey,
portal/workers/app/src/lib/project-board-order.ts:245:    stageKey: row.stageKey,
portal/workers/app/src/lib/project-board-order.ts:326:  const expected = "direction" in input.request ? { stageKey: current.stageKey, boardRevision: current.boardRevision } : input.request.expected;
portal/workers/app/src/lib/project-board-order.ts:342:    ? { expected: { stageKey: stageTransportKeyForRole(current.stageKey, principal.role), boardRevision: current.boardRevision }, targetStageKey: stageTransportKeyForRole(current.stageKey, principal.role), placement: directionPlacement(visibleRows, current.id, input.request.direction) }
portal/apps/web/src/screens/dashboard-routing.test.ts:8:  agencyName: null, agentName: null, stageKey: "awaiting_raw", shootDate: null, coverAssetId: null,
portal/packages/db/src/stage-transition.ts:28:  const source = await d1.prepare("SELECT board_revision AS boardRevision FROM projects WHERE id = ? AND stage_key = ? AND archived_at IS NULL")
portal/packages/db/src/stage-transition.ts:31:  const target = await d1.prepare("SELECT id AS projectId, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id <> ? ORDER BY board_position, id")
portal/packages/db/src/stage-transition.ts:32:    .bind(input.to, input.projectId).all<{ projectId: string; stageKey: string; boardPosition: number; boardRevision: number }>();
portal/packages/db/src/stage-transition.ts:39:    expectedTarget: target.results.map((row) => ({ ...row, stageKey: row.stageKey as never })),
portal/workers/background/src/reconcile-awaiting-raw.ts:6:  stageKey: string;
portal/workers/background/src/reconcile-awaiting-raw.ts:59:    AND stage_key = 'awaiting_raw'
portal/workers/app/test/kanban-ordering.integration.test.ts:37:async function seedProject(id: string, stageKey: string, boardPosition: number, priority: number | null = null) {
portal/workers/app/test/kanban-ordering.integration.test.ts:78:    const body = { expected: { stageKey: "raw_review", boardRevision: 0 }, targetStageKey: "delivered", placement: { kind: "append" } };
portal/workers/app/test/kanban-ordering.integration.test.ts:84:    expect((await confirmed.json()).project).toMatchObject({ projectId: target, stageKey: "delivered", boardRevision: 1 });
portal/workers/app/test/kanban-ordering.integration.test.ts:92:    const response = await request(`/api/projects/${target}/stage/`, adminToken, { method: "POST", body: JSON.stringify({ stageKey: "delivered" }) });
portal/workers/app/test/project-board-order.test.ts:5:  id, stageKey: "raw_review", priority, boardPosition, boardRevision: 0,
portal/workers/app/test/project-board-order.test.ts:18:        expected: { stageKey: "raw_review", boardRevision: 0 },
portal/workers/app/test/project-board-order.test.ts:34:        expected: { stageKey: "raw_review", boardRevision: 0 },
portal/workers/app/test/project-board-order.test.ts:45:        expected: { stageKey: "raw_review", boardRevision: 0 },
portal/apps/web/src/lib/project-data.test.ts:21:function detail(id: string): ProjectDetail { return { id, street: id, suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review", rawFolderPath: null, rawFolderLink: null, boardRevision: 0, contractEnabled: false, coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [], deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false } }; }
portal/apps/web/src/lib/project-data.test.ts:94:    const summary = { project: { id: "a/b", street: "Marker Lane", stageKey: "raw_review" as const }, members: [] };
portal/apps/web/src/lib/project-data.test.ts:112:    apiGetMock.mockResolvedValueOnce({ project: { id: "p", street: "Missing members", stageKey: "raw_review" }, members: "not-an-array" });
portal/apps/web/src/lib/project-data.test.ts:201:    queryClient.setQueryData(projectDataKeys.collaborationSummary(projectId), { project: { id: projectId, street: projectId, stageKey: "raw_review" as const }, members: [] });
portal/apps/web/src/lib/project-data.test.ts:269:    const summary = { project: { id: "p", street: "Private Lane", stageKey: "raw_review" as const }, members: [] };
portal/packages/shared/src/board-projection.ts:13:  stageKey: StageTransportKey;
portal/packages/shared/src/board-projection.ts:34:  stageKey: string,
portal/packages/db/src/schema.ts:168:    stageKey: text("stage_key").notNull().default("awaiting_raw"),
portal/packages/db/src/board-order-rollback-0037.ts:28:        AND p.stage_key = r.stage_key
portal/packages/shared/test/stage-move.test.ts:21:  expected: { stageKey: "raw_review", boardRevision: 2 },
portal/packages/shared/test/stage-move.test.ts:100:      project: { projectId: targetProjectId, stageKey: "editing", boardRevision: 3 },
portal/packages/db/src/stage-board-bundles.ts:116:  stageKey: StageKey;
portal/packages/db/src/stage-board-bundles.ts:177:  stageKey: StageKey;
portal/packages/db/src/stage-board-bundles.ts:232:    WHERE stage_key = ?4
portal/packages/db/src/stage-board-bundles.ts:242:    WHERE p.stage_key = e.stage_key
portal/packages/db/src/stage-board-bundles.ts:264:    WHERE p.stage_key = ?4
portal/packages/db/src/stage-board-bundles.ts:272:  stage_key = ?4,
portal/packages/db/src/stage-board-bundles.ts:278:  AND p.stage_key = ?6
portal/packages/db/src/stage-board-bundles.ts:290:WHERE stage_key = ?1
portal/packages/db/src/stage-board-bundles.ts:388:    WHERE stage_key = ?6
portal/packages/db/src/stage-board-bundles.ts:398:    WHERE p.stage_key = e.stage_key
portal/packages/db/src/stage-board-bundles.ts:420:    WHERE p.stage_key = ?6
portal/packages/db/src/stage-board-bundles.ts:451:      AND old_stage_key = ?8
portal/packages/db/src/stage-board-bundles.ts:478:          AND e.stage_key = c.old_stage_key
portal/packages/db/src/stage-board-bundles.ts:506:    WHERE p.stage_key = c.old_stage_key
portal/packages/db/src/stage-board-bundles.ts:514:  stage_key = CASE
portal/packages/db/src/stage-board-bundles.ts:523:  AND p.stage_key = c.old_stage_key
portal/packages/db/src/stage-board-bundles.ts:561:      AND stage_key = 'editing_autohdr'
portal/packages/db/src/stage-board-bundles.ts:580:      AND stage_key = 'editing_autohdr'
portal/packages/db/src/stage-board-bundles.ts:596:      AND stage_key = 'editing_autohdr'
portal/packages/db/src/stage-board-bundles.ts:616:      AND stage_key = 'editing_autohdr'
portal/packages/db/src/stage-board-bundles.ts:778:            AND ((? = 'project_archived' AND p.archived_at IS NOT NULL) OR (? = 'project_delivered' AND p.stage_key = 'delivered'))
portal/packages/db/test/tb5a-migration-proof.test.ts:46:function stageRows(db: SqliteDatabase, stageKey: string): SqliteRow[] {
portal/packages/db/test/tb5a-migration-proof.test.ts:47:  return db.prepare("SELECT id, stage_key, priority, board_position, board_revision, archived_at FROM projects WHERE stage_key = ? AND archived_at IS NULL ORDER BY board_position, id").all(stageKey) as SqliteRow[];
portal/packages/db/test/tb5a-migration-proof.test.ts:55:  seedContractProject(db, { id: "target", stageKey: "raw_review", boardPosition: 7, boardRevision: 5 });
portal/packages/db/test/tb5a-migration-proof.test.ts:56:  seedContractProject(db, { id: "sibling-a", stageKey: "edited_review", boardPosition: 0, boardRevision: 2 });
portal/packages/db/test/tb5a-migration-proof.test.ts:57:  seedContractProject(db, { id: "sibling-b", stageKey: "edited_review", boardPosition: 1024, boardRevision: 3 });
portal/packages/db/test/tb5a-migration-proof.test.ts:60:      { projectId: "sibling-a", stageKey: "edited_review", boardPosition: 0, boardRevision: 2, newBoardPosition: 1024 },
portal/packages/db/test/tb5a-migration-proof.test.ts:61:      { projectId: "sibling-b", stageKey: "edited_review", boardPosition: 1024, boardRevision: 3, newBoardPosition: 2048 },
portal/packages/db/test/tb5a-migration-proof.test.ts:99:        { id: "a-tie-a", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/tb5a-migration-proof.test.ts:100:        { id: "a-tie-b", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/tb5a-migration-proof.test.ts:101:        { id: "a-fraction", stageKey: "awaiting_raw", priority: 1, boardPosition: 4.5 },
portal/packages/db/test/tb5a-migration-proof.test.ts:102:        { id: "a-null", stageKey: "awaiting_raw", priority: null, boardPosition: -100 },
portal/packages/db/test/tb5a-migration-proof.test.ts:103:        { id: "b-priority", stageKey: "raw_review", priority: 1, boardPosition: 9 },
portal/packages/db/test/tb5a-migration-proof.test.ts:104:        { id: "inactive-occupant", stageKey: "edited_review", priority: 1, boardPosition: 99 },
portal/packages/db/test/tb5a-migration-proof.test.ts:105:        { id: "delivered-project", stageKey: "delivered", priority: null, boardPosition: 7 },
portal/packages/db/test/tb5a-migration-proof.test.ts:106:        { id: "archived-project", stageKey: "awaiting_raw", priority: 1, boardPosition: 123.25, archivedAt: FIXTURE_NOW + 1 },
portal/packages/db/test/tb5a-migration-proof.test.ts:107:        { id: "archived-noncanonical", stageKey: "legacy_archived", priority: null, boardPosition: 987.5, archivedAt: FIXTURE_NOW + 2 },
portal/packages/db/test/tb5a-migration-proof.test.ts:163:        seedLegacyProject(db, { id: "invalid-stage", stageKey: "not_a_stage", boardPosition: 42 });
portal/packages/db/test/tb5a-migration-proof.test.ts:184:          { id: "valid-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 },
portal/packages/db/test/tb5a-migration-proof.test.ts:185:          { id: "valid-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 },
portal/packages/db/test/tb5a-migration-proof.test.ts:216:        { id: "rollback-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 },
portal/packages/db/test/tb5a-migration-proof.test.ts:217:        { id: "rollback-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 },
portal/packages/db/test/tb5a-migration-proof.test.ts:233:        seedLegacyProject(drifted, { id: "drift-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 });
portal/packages/db/test/tb5a-migration-proof.test.ts:234:        seedLegacyProject(drifted, { id: "drift-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 });
portal/packages/db/test/tb5a-migration-proof.test.ts:260:      seedContractProject(db, { id: "target", stageKey: "raw_review", boardRevision: 5 });
portal/packages/db/src/board-position.ts:4:export function appendToStageBottomExpr(stageKey: string, excludeProjectId: string): SQL {
portal/packages/db/src/board-position.ts:5:  return sql`(SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ${stageKey} AND archived_at IS NULL AND id != ${excludeProjectId})`;
portal/workers/background/test/autohdr-manual-supplement.test.ts:386:      async (context) => bindings.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(context.projectId).run().then(() => undefined),
portal/packages/db/test/board-position-sql.test.ts:9:    const move = db.prepare("UPDATE projects SET stage_key = ?, board_position = (SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id != ?) WHERE id = ? AND stage_key = ? AND archived_at IS NULL");
portal/packages/db/test/board-position-sql.test.ts:14:    expect(db.prepare("SELECT board_position FROM projects WHERE stage_key = 'edited_review' ORDER BY board_position").all().map((row) => row.board_position)).toEqual([0, 1024]);
portal/packages/db/test/tb5a-proof-support.ts:140:  stageKey: string;
portal/workers/background/test/project-deadline.integration.test.ts:184:      await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(fixture.projectId).run();
portal/workers/background/test/autohdr-versioning.test.ts:221:    await bindings.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(deliveredReplacement.projectId).run();
portal/workers/background/src/workflows/autohdr.ts:280:          const confirmed = await db.select({ state: autoHdrHandoffs.state, stageKey: projects.stageKey })
portal/workers/background/src/workflows/autohdr.ts:323:            const current = await db.select({ stageKey: projects.stageKey, archivedAt: projects.archivedAt })
portal/workers/background/src/workflows/autohdr.ts:330:        return { status: "running", stageKey: "editing_autohdr" };
portal/packages/db/test/stage-board-bundles.test.ts:109:function seedProject(db: SqliteDatabase, input: { id: string; stageKey: string; boardPosition?: number; boardRevision?: number; shootDate?: string }): void {
portal/packages/db/test/stage-board-bundles.test.ts:146:  seedProject(db, { id: "target", stageKey: "raw_review", boardPosition: 4, boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:147:  seedProject(db, { id: "sibling-a", stageKey: "edited_review", boardPosition: 1024, boardRevision: 2 });
portal/packages/db/test/stage-board-bundles.test.ts:148:  seedProject(db, { id: "sibling-b", stageKey: "edited_review", boardPosition: 4096, boardRevision: 3 });
portal/packages/db/test/stage-board-bundles.test.ts:150:    { projectId: "sibling-a", stageKey: "edited_review", boardPosition: 1024, boardRevision: 2, newBoardPosition: 0 },
portal/packages/db/test/stage-board-bundles.test.ts:151:    { projectId: "sibling-b", stageKey: "edited_review", boardPosition: 4096, boardRevision: 3, newBoardPosition: 2048 },
portal/packages/db/test/stage-board-bundles.test.ts:179:      seedProject(db, { id: "target", stageKey: "raw_review", boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:188:      db.prepare("UPDATE projects SET stage_key = 'raw_review', board_position = 3, board_revision = 5 WHERE id = 'target'").run();
portal/packages/db/test/stage-board-bundles.test.ts:189:      seedProject(db, { id: "destination", stageKey: "edited_review", boardPosition: 1024, boardRevision: 8 });
portal/packages/db/test/stage-board-bundles.test.ts:190:      const expected: ExpectedTargetPlacementRow[] = [{ projectId: "destination", stageKey: "edited_review", boardPosition: 1024, boardRevision: 8 }];
portal/packages/db/test/stage-board-bundles.test.ts:198:      db.prepare("UPDATE projects SET stage_key = 'raw_review', board_position = 3, board_revision = 5 WHERE id = 'target'").run();
portal/packages/db/test/stage-board-bundles.test.ts:261:      if (caseName === "extra expected row") { expected = [...fixture.expected, { projectId: "ghost", stageKey: "edited_review", boardPosition: 8192, boardRevision: 1, newBoardPosition: 4096 }]; expectedCount = 3; }
portal/packages/db/test/stage-board-bundles.test.ts:296:      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:307:      db.prepare("UPDATE projects SET stage_key = 'raw_review', board_revision = 6 WHERE id = 'target'").run();
portal/packages/db/test/stage-board-bundles.test.ts:308:      db.prepare("UPDATE projects SET stage_key = 'editing_autohdr', board_revision = 7 WHERE id = 'target'").run();
portal/packages/db/test/stage-board-bundles.test.ts:309:      const completion = db.prepare("UPDATE projects SET stage_key = 'edited_review' WHERE id = ? AND stage_key = 'editing_autohdr' AND board_revision = ?").run("target", 5) as { changes?: number };
portal/packages/db/test/stage-board-bundles.test.ts:335:        seedProject(db, { id: "target", stageKey: premise.projectStage, boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:365:      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:399:      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 7 });
portal/packages/db/test/stage-board-bundles.test.ts:417:      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:495:      row: { projectId: "target", stageKey: "edited_review" as const, boardPosition: 0, boardRevision: 6 },
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:35:    expected.push({ projectId: id, stageKey: "edited_review", boardPosition: index * 1024, boardRevision: 0, newBoardPosition: (index + 1) * 1024 });
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:46:  seedContractProject(db, { id: "target", stageKey: "raw_review", boardPosition: 777, boardRevision: 5 });
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:48:    seedContractProject(db, { id: `edited-${String(index).padStart(4, "0")}`, stageKey: "edited_review", boardPosition: index * 1024, boardRevision: 0 });
portal/packages/db/test/tb5a-slice-6-closeout.test.ts:33:    expect(tonomo).toMatch(/stageKey:\s*"awaiting_raw"[\s\S]{0,180}boardPosition:[\s\S]{0,180}boardRevision:\s*0/);
portal/workers/background/src/project-deadline.ts:110:          WHEN p.stage_key = 'delivered' THEN 'project_delivered'
portal/workers/background/src/project-deadline.ts:122:            AND (p.archived_at IS NOT NULL OR p.stage_key = 'delivered' OR p.deadline_at IS NULL OR p.deadline_version <> project_deadline_occurrences.schedule_version)
portal/workers/background/test/autohdr-send-run.test.ts:67:    database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr' WHERE id = ?").bind(projectId),
portal/workers/background/test/autohdr-send-run.test.ts:177:    await database.DB.prepare("UPDATE projects SET stage_key = 'edited_review' WHERE id = ?").bind(input.projectId).run();
portal/workers/background/src/lib/automatic-stage.ts:39:    "SELECT board_revision AS boardRevision FROM projects WHERE id = ? AND stage_key = ? AND archived_at IS NULL",
portal/workers/background/src/lib/automatic-stage.ts:43:    "SELECT id AS projectId, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id <> ? ORDER BY board_position, id",
portal/workers/background/src/lib/automatic-stage.ts:59:  expected: { projectId: string; stageKey: StageKey; boardRevision: number },
portal/workers/background/src/lib/automatic-stage.ts:69:    row: { projectId: row.id, stageKey: row.stage_key as StageKey, boardPosition, boardRevision },
portal/workers/background/src/lib/automatic-stage.ts:171:    stageKey: input.to,
portal/workers/background/test/autohdr-claims.test.ts:281:            await database.DB.prepare("UPDATE projects SET stage_key = 'edited_review' WHERE id = ?").bind(data.projectId).run();
portal/workers/background/test/autohdr-claims.test.ts:374:    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(data.projectId).run();
portal/workers/background/test/autohdr-claims.test.ts:468:      database.DB.prepare("UPDATE projects SET stage_key = ? WHERE id = ?").bind(stage, data.projectId),
portal/workers/background/test/reconcile-awaiting-raw.test.ts:30:      { id: "due", shootDate: "2026-07-22", stageKey: "awaiting_raw", archivedAt: null },
portal/workers/background/test/reconcile-awaiting-raw.test.ts:31:      { id: "future", shootDate: "2026-07-23", stageKey: "awaiting_raw", archivedAt: null },
portal/workers/background/test/reconcile-awaiting-raw.test.ts:32:      { id: "null", shootDate: null, stageKey: "awaiting_raw", archivedAt: null },
portal/workers/background/test/reconcile-awaiting-raw.test.ts:33:      { id: "malformed", shootDate: "22/07/2026", stageKey: "awaiting_raw", archivedAt: null },
portal/workers/background/test/reconcile-awaiting-raw.test.ts:34:      { id: "archived", shootDate: "2026-07-21", stageKey: "awaiting_raw", archivedAt: 1 },
portal/workers/background/test/reconcile-awaiting-raw.test.ts:35:      { id: "already-review", shootDate: "2026-07-21", stageKey: "raw_review", archivedAt: null },
portal/workers/background/test/reconcile-awaiting-raw.test.ts:61:      { id: "advance", shootDate: "2026-07-21", stageKey: "awaiting_raw", archivedAt: null },
portal/workers/background/test/reconcile-awaiting-raw.test.ts:62:      { id: "moved", shootDate: "2026-07-21", stageKey: "awaiting_raw", archivedAt: null },
portal/workers/background/test/reconcile-awaiting-raw.test.ts:63:      { id: "fails", shootDate: "2026-07-21", stageKey: "awaiting_raw", archivedAt: null },
portal/workers/background/test/reconcile-awaiting-raw.test.ts:88:      stageKey: "awaiting_raw",
portal/workers/background/src/autohdr/finals.ts:106:  fence: { stageKey: string; editingEntryBoardRevision: number | null },
portal/workers/background/src/autohdr/finals.ts:183:    stageKey: projects.stageKey,
portal/packages/db/test/migration-0037.test.ts:110:  stageKey: string;
portal/packages/db/test/migration-0037.test.ts:119:  { id: "a-tie-1", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/migration-0037.test.ts:120:  { id: "a-tie-2", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/migration-0037.test.ts:121:  { id: "a-fraction", stageKey: "awaiting_raw", priority: 1, boardPosition: 4.5 },
portal/packages/db/test/migration-0037.test.ts:122:  { id: "a-null", stageKey: "awaiting_raw", priority: null, boardPosition: 8 },
portal/packages/db/test/migration-0037.test.ts:123:  { id: "b-priority-10", stageKey: "raw_review", priority: 10, boardPosition: 2 },
portal/packages/db/test/migration-0037.test.ts:124:  { id: "b-priority-5", stageKey: "raw_review", priority: 5, boardPosition: 2 },
portal/packages/db/test/migration-0037.test.ts:125:  { id: "b-null", stageKey: "raw_review", priority: null, boardPosition: -100 },
portal/packages/db/test/migration-0037.test.ts:126:  { id: "inactive-stage", stageKey: "edited_review", priority: 5, boardPosition: 99 },
portal/packages/db/test/migration-0037.test.ts:127:  { id: "delivered-project", stageKey: "delivered", priority: null, boardPosition: 7 },
portal/packages/db/test/migration-0037.test.ts:128:  { id: "archived-project", stageKey: "awaiting_raw", priority: 1, boardPosition: 123.25, archivedAt: FIXTURE_NOW + 1 },
portal/packages/db/test/migration-0037.test.ts:129:  { id: "archived-noncanonical", stageKey: "legacy_archived", priority: null, boardPosition: 987.5, archivedAt: FIXTURE_NOW + 2 },
portal/packages/db/test/migration-0037.test.ts:236:    const expected = new Map<string, { boardPosition: number; stageKey: string; priority: number | null; archivedAt: number | null }>();
portal/packages/db/test/migration-0037.test.ts:251:        stageKey: String(row.stage_key),
portal/packages/db/test/migration-0037.test.ts:288:      seedProjects(db, [{ id: "invalid-stage", stageKey: "not_a_stage", priority: 1, boardPosition: 42 }]);
portal/packages/db/test/migration-0037.test.ts:403:      db.prepare("UPDATE projects SET stage_key = 'wrong_stage' WHERE id = ?").run(driftedId);
portal/workers/background/src/autohdr/api-send.ts:120:    stageKey: projects.stageKey,
portal/workers/background/src/autohdr/api-send.ts:167:    "WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL AND stage_key = 'raw_review') " +
portal/workers/background/src/autohdr/api-send.ts:188:  const current = await db.select({ stageKey: projects.stageKey, archivedAt: projects.archivedAt })
portal/workers/background/src/autohdr/claims.ts:123:  const stateUpdate = env.DB.prepare("UPDATE autohdr_handoffs SET state = 'started', started_at = coalesce(started_at, ?), updated_at = ? WHERE id = ? AND project_id = ? AND connection_id = ? AND generation = ? AND state in ('starting','started') AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND stage_key = 'editing_autohdr' AND archived_at IS NULL) AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)")
portal/workers/background/src/autohdr/claims.ts:161:    const confirmed = await (await import("../lib/db")).dbFor(env).select({ state: autoHdrHandoffs.state, stageKey: projects.stageKey })
portal/workers/background/src/autohdr/claims.ts:237:    stageKey: projects.stageKey, archivedAt: projects.archivedAt, rawFolderPath: projects.rawFolderPath,
portal/workers/background/src/autohdr/claims.ts:268:      env.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, expected_origin_stage, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'raw_review', 'starting', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL AND stage_key = 'raw_review')")
portal/workers/background/src/autohdr/claims.ts:371:  const project = await db.select({ rawFolderPath: projects.rawFolderPath, stageKey: projects.stageKey, archivedAt: projects.archivedAt })
portal/workers/background/src/autohdr/claims.ts:901:      stageKey: projects.stageKey,
portal/packages/db/src/project-projections.ts:21:  stageKey: schema.projects.stageKey,
```

### A3

```text
$ rg -n 'board_position|boardPosition|board_revision|boardRevision' portal/apps portal/workers portal/packages -g '*.ts'
portal/packages/db/src/stage-board-bundles.ts:117:  boardPosition: number;
portal/packages/db/src/stage-board-bundles.ts:118:  boardRevision: number;
portal/packages/db/src/stage-board-bundles.ts:162:  boardPosition?: number;
portal/packages/db/src/stage-board-bundles.ts:178:  boardPosition: number;
portal/packages/db/src/stage-board-bundles.ts:179:  boardRevision: number;
portal/packages/db/src/stage-board-bundles.ts:199:    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
portal/packages/db/src/stage-board-bundles.ts:200:    json_type(value, '$.boardPosition') AS board_position_type,
portal/packages/db/src/stage-board-bundles.ts:201:    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision,
portal/packages/db/src/stage-board-bundles.ts:202:    json_type(value, '$.boardRevision') AS board_revision_type
portal/packages/db/src/stage-board-bundles.ts:224:       OR board_position_type NOT IN ('integer', 'real')
portal/packages/db/src/stage-board-bundles.ts:225:       OR board_revision_type <> 'integer'
portal/packages/db/src/stage-board-bundles.ts:226:       OR board_revision < 0
portal/packages/db/src/stage-board-bundles.ts:227:       OR board_revision > 9007199254740991
portal/packages/db/src/stage-board-bundles.ts:243:      AND p.board_position IS e.board_position
portal/packages/db/src/stage-board-bundles.ts:244:      AND p.board_revision = e.board_revision
portal/packages/db/src/stage-board-bundles.ts:255:       OR p.board_position IS NOT e.board_position
portal/packages/db/src/stage-board-bundles.ts:256:       OR p.board_revision IS NOT e.board_revision
portal/packages/db/src/stage-board-bundles.ts:273:  board_position = ?8,
portal/packages/db/src/stage-board-bundles.ts:274:  board_revision = p.board_revision + 1,
portal/packages/db/src/stage-board-bundles.ts:279:  AND p.board_revision = ?7
portal/packages/db/src/stage-board-bundles.ts:284:  board_position,
portal/packages/db/src/stage-board-bundles.ts:285:  board_revision;
portal/packages/db/src/stage-board-bundles.ts:288:export const APPEND_STAGE_BOTTOM_SQL = String.raw`SELECT COALESCE(MAX(board_position) + 1024, 0)
portal/packages/db/src/stage-board-bundles.ts:296:  "board_position = ?8",
portal/packages/db/src/stage-board-bundles.ts:297:  `board_position = (${APPEND_STAGE_BOTTOM_SQL.replace("?1", "?4").replace("?2", "?5").trimEnd()})`,
portal/packages/db/src/stage-board-bundles.ts:307:    CAST(json_extract(value, '$.boardPosition') AS REAL) AS board_position,
portal/packages/db/src/stage-board-bundles.ts:308:    json_type(value, '$.boardPosition') AS board_position_type,
portal/packages/db/src/stage-board-bundles.ts:309:    CAST(json_extract(value, '$.boardRevision') AS INTEGER) AS board_revision,
portal/packages/db/src/stage-board-bundles.ts:310:    json_type(value, '$.boardRevision') AS board_revision_type,
portal/packages/db/src/stage-board-bundles.ts:311:    CAST(json_extract(value, '$.newBoardPosition') AS REAL) AS new_board_position,
portal/packages/db/src/stage-board-bundles.ts:312:    json_type(value, '$.newBoardPosition') AS new_board_position_type
portal/packages/db/src/stage-board-bundles.ts:323:    CAST(json_extract(value, '$.oldBoardPosition') AS REAL) AS old_board_position,
portal/packages/db/src/stage-board-bundles.ts:324:    json_type(value, '$.oldBoardPosition') AS old_board_position_type,
portal/packages/db/src/stage-board-bundles.ts:325:    CAST(json_extract(value, '$.oldBoardRevision') AS INTEGER) AS old_board_revision,
portal/packages/db/src/stage-board-bundles.ts:326:    json_type(value, '$.oldBoardRevision') AS old_board_revision_type,
portal/packages/db/src/stage-board-bundles.ts:327:    CAST(json_extract(value, '$.newBoardPosition') AS REAL) AS new_board_position,
portal/packages/db/src/stage-board-bundles.ts:328:    json_type(value, '$.newBoardPosition') AS new_board_position_type,
portal/packages/db/src/stage-board-bundles.ts:340:  WHERE new_board_position IS NOT board_position
portal/packages/db/src/stage-board-bundles.ts:343:  SELECT project_id, new_board_position
portal/packages/db/src/stage-board-bundles.ts:346:  SELECT project_id, new_board_position
portal/packages/db/src/stage-board-bundles.ts:353:    new_board_position,
portal/packages/db/src/stage-board-bundles.ts:355:      ORDER BY new_board_position, project_id
portal/packages/db/src/stage-board-bundles.ts:378:       OR board_position_type NOT IN ('integer', 'real')
portal/packages/db/src/stage-board-bundles.ts:379:       OR board_revision_type <> 'integer'
portal/packages/db/src/stage-board-bundles.ts:380:       OR board_revision < 0
portal/packages/db/src/stage-board-bundles.ts:381:       OR board_revision > 9007199254740991
portal/packages/db/src/stage-board-bundles.ts:382:       OR new_board_position_type NOT IN ('integer', 'real')
portal/packages/db/src/stage-board-bundles.ts:399:      AND p.board_position IS e.board_position
portal/packages/db/src/stage-board-bundles.ts:400:      AND p.board_revision = e.board_revision
portal/packages/db/src/stage-board-bundles.ts:411:       OR p.board_position IS NOT e.board_position
portal/packages/db/src/stage-board-bundles.ts:412:       OR p.board_revision IS NOT e.board_revision
portal/packages/db/src/stage-board-bundles.ts:433:       OR old_board_position_type NOT IN ('integer', 'real')
portal/packages/db/src/stage-board-bundles.ts:434:       OR old_board_revision_type <> 'integer'
portal/packages/db/src/stage-board-bundles.ts:435:       OR old_board_revision < 0
portal/packages/db/src/stage-board-bundles.ts:436:       OR old_board_revision > 9007199254740991
portal/packages/db/src/stage-board-bundles.ts:437:       OR new_board_position_type NOT IN ('integer', 'real')
portal/packages/db/src/stage-board-bundles.ts:452:      AND old_board_revision = ?9
portal/packages/db/src/stage-board-bundles.ts:479:          AND e.board_position IS c.old_board_position
portal/packages/db/src/stage-board-bundles.ts:480:          AND e.board_revision = c.old_board_revision
portal/packages/db/src/stage-board-bundles.ts:481:          AND e.new_board_position IS c.new_board_position
portal/packages/db/src/stage-board-bundles.ts:491:    SELECT COUNT(DISTINCT new_board_position)
portal/packages/db/src/stage-board-bundles.ts:497:    WHERE new_board_position
portal/packages/db/src/stage-board-bundles.ts:507:      AND p.board_position IS c.old_board_position
portal/packages/db/src/stage-board-bundles.ts:508:      AND p.board_revision = c.old_board_revision
portal/packages/db/src/stage-board-bundles.ts:518:  board_position = c.new_board_position,
portal/packages/db/src/stage-board-bundles.ts:519:  board_revision = p.board_revision + 1,
portal/packages/db/src/stage-board-bundles.ts:524:  AND p.board_position IS c.old_board_position
portal/packages/db/src/stage-board-bundles.ts:525:  AND p.board_revision = c.old_board_revision
portal/packages/db/src/stage-board-bundles.ts:530:  board_position,
portal/packages/db/src/stage-board-bundles.ts:531:  board_revision;
portal/packages/db/src/stage-board-bundles.ts:557:  editing_entry_board_revision = (
portal/packages/db/src/stage-board-bundles.ts:558:    SELECT board_revision
portal/packages/db/src/stage-board-bundles.ts:570:  AND editing_entry_board_revision IS ?7
portal/packages/db/src/stage-board-bundles.ts:587:  editing_entry_board_revision;
portal/packages/db/src/stage-board-bundles.ts:592:  stage_entry_board_revision = (
portal/packages/db/src/stage-board-bundles.ts:593:    SELECT board_revision
portal/packages/db/src/stage-board-bundles.ts:606:  AND stage_entry_board_revision IS ?6
portal/packages/db/src/stage-board-bundles.ts:622:  stage_entry_board_revision;
portal/packages/db/src/stage-board-bundles.ts:673:  const position = input.boardPosition ?? input.exactBoardPosition ?? input.position;
portal/packages/db/src/stage-board-bundles.ts:674:  if (input.placement === "exact" && position === undefined) throw new Error("Exact Stage placement requires boardPosition");
portal/packages/db/src/stage-board-bundles.ts:976:    const sourceEntryJob = selectStatement(prerequisite.db, `SELECT id, project_id, stage_entry_board_revision FROM jobs WHERE id = ? AND project_id = ? AND kind = ? AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ? AND json_extract(payload_json, '$.stageEntrySourceJobId') = id AND CAST(COALESCE(json_extract(payload_json, '$.stageEntryGeneration'), json_extract(payload_json, '$.generation')) AS INTEGER) = ? AND stage_entry_board_revision IS NOT NULL ${AUDIT_EXISTS}`, [prerequisite.sourceJobId ?? "", prerequisite.projectId, prerequisite.sourceJobKind ?? "autohdr", prerequisite.projectId, prerequisite.generation, prerequisite.auditId]);
portal/packages/db/src/stage-board-bundles.ts:1008:    if (!Number.isFinite(result.row.boardPosition) || !Number.isInteger(result.row.boardRevision) || result.row.boardRevision < 0) return false;
portal/packages/db/src/stage-board-bundles.ts:1017:    if (result.auditId !== first.auditId || result.row.projectId !== first.row.projectId || result.row.stageKey !== first.row.stageKey || result.row.boardPosition !== first.row.boardPosition || result.row.boardRevision !== first.row.boardRevision || result.legacyWorkflowNotification !== first.legacyWorkflowNotification) return undefined;
portal/apps/web/src/lib/external-api-response.ts:47:    boardRevision: project.boardRevision,
portal/apps/web/src/lib/external-api-response.ts:65:    boardRevision: project.boardRevision,
portal/packages/db/src/board-position.ts:5:  return sql`(SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ${stageKey} AND archived_at IS NULL AND id != ${excludeProjectId})`;
portal/packages/db/src/stage-transition.test.ts:56:      sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, stage_key TEXT NOT NULL, board_position REAL NOT NULL, board_revision INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, updated_at INTEGER NOT NULL)");
portal/packages/db/src/stage-transition.test.ts:61:      sqlite.exec("INSERT INTO projects (id, stage_key, board_position, updated_at) VALUES ('target', 'awaiting_raw', 0, 1), ('raw-a', 'raw_review', 1024, 1), ('raw-b', 'raw_review', 1536, 1)");
portal/packages/db/src/stage-transition.test.ts:73:      expect(sqlite.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = 'target'").get()).toEqual({ stage_key: "raw_review", board_position: 2560, board_revision: 1 });
portal/packages/db/src/project-projections.ts:6: * board_revision on a 0036 database. This is also the single audit surface for project reads.
portal/packages/db/src/project-projections.ts:23:  boardPosition: schema.projects.boardPosition,
portal/packages/db/src/project-projections.ts:48:    ? { ...projectColumnsPre0037, boardRevision: schema.projects.boardRevision }
portal/packages/db/src/board-order-rollback-0037.ts:24:      SET board_position = r.old_board_position
portal/packages/db/src/board-order-rollback-0037.ts:29:        AND p.board_position IS r.normalized_board_position
portal/packages/db/src/board-order-rollback-0037.ts:30:        AND p.board_revision = ?1
portal/apps/web/src/lib/project-data.ts:15:  shootDate: string | null; stageKey: ProjectStageKey; rawFolderPath: string | null; rawFolderLink: string | null; productionNotes?: string | null; editedUploadAvailable?: boolean; archivedAt?: string | number | null; boardRevision: number; contractEnabled: boolean;
portal/apps/web/src/lib/external-api-response.characterization.test.ts:16:    boardRevision: 0,
portal/apps/web/src/lib/external-api-response.characterization.test.ts:25:	it("renders the authorized server order when raw boardPosition is unavailable", () => {
portal/apps/web/src/lib/external-api-response.characterization.test.ts:32:		expect(mapped.every((project) => project.boardPosition === undefined)).toBe(true);
portal/apps/web/src/lib/external-api-response.characterization.test.ts:39:			boardRevision: 9,
portal/apps/web/src/lib/external-api-response.characterization.test.ts:48:			boardRevision: 9,
portal/packages/db/src/stage-transition.ts:28:  const source = await d1.prepare("SELECT board_revision AS boardRevision FROM projects WHERE id = ? AND stage_key = ? AND archived_at IS NULL")
portal/packages/db/src/stage-transition.ts:29:    .bind(input.projectId, input.from).first<{ boardRevision: number }>();
portal/packages/db/src/stage-transition.ts:31:  const target = await d1.prepare("SELECT id AS projectId, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id <> ? ORDER BY board_position, id")
portal/packages/db/src/stage-transition.ts:32:    .bind(input.to, input.projectId).all<{ projectId: string; stageKey: string; boardPosition: number; boardRevision: number }>();
portal/packages/db/src/stage-transition.ts:38:    oldBoardRevision: source.boardRevision,
portal/apps/web/src/lib/project-data.test.ts:21:function detail(id: string): ProjectDetail { return { id, street: id, suburb: null, postcode: null, agencyName: null, agentName: null, shootDate: null, stageKey: "raw_review", rawFolderPath: null, rawFolderLink: null, boardRevision: 0, contractEnabled: false, coverAssetId: null, effectiveCoverAssetId: null, collections: [], members: [], deadlineSchedule: { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false } }; }
portal/packages/db/src/schema.ts:170:    boardPosition: real("board_position").notNull().default(0),
portal/packages/db/src/schema.ts:171:    boardRevision: integer("board_revision").notNull().default(0),
portal/packages/db/src/schema.ts:635:    editingEntryBoardRevision: integer("editing_entry_board_revision"),
portal/packages/db/src/schema.ts:1040:    stageEntryBoardRevision: integer("stage_entry_board_revision"),
portal/workers/app/src/routes/projects.ts:34:const boardPositionInput = z.object({ direction: z.enum(["up", "down"]) });
portal/workers/app/src/routes/projects.ts:180:  // Do not replace this with select(). The post-0037 Drizzle schema contains board_revision.
portal/workers/app/src/routes/projects.ts:194:    boardRevision: variant === "tb5a_0037" && "boardRevision" in project ? Number(project.boardRevision) : 0,
portal/workers/app/src/routes/projects.ts:204:function authorizedInternalBoardOrder(rows: Array<{ project: { id: string; stageKey: string; priority: number | null; boardPosition: number } }>, role: Role): Partial<Record<StageTransportKey, string[]>> {
portal/workers/app/src/routes/projects.ts:205:  const groups = new Map<StageTransportKey, Array<{ id: string; priority: number | null; boardPosition: number }>>();
portal/workers/app/src/routes/projects.ts:214:    group.sort((left, right) => (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0) || left.boardPosition - right.boardPosition || left.id.localeCompare(right.id));
portal/workers/app/src/routes/projects.ts:247:    stageKey: "awaiting_raw", priority: null, boardPosition: 0, boardRevision: 0, orderNo: data.orderNo ?? null, orderId: data.orderId ?? null,
portal/workers/app/src/routes/projects.ts:282:      agency_id, agent_id, shoot_date, time_window, stage_key, board_position,
portal/workers/app/src/routes/projects.ts:283:      board_revision,
portal/workers/app/src/routes/projects.ts:288:      (SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = 'awaiting_raw' AND archived_at IS NULL AND id != ?),
portal/workers/app/src/routes/projects.ts:360:      boardRevision: variant === "tb5a_0037" && "boardRevision" in r.project ? Number(r.project.boardRevision) : 0,
portal/workers/app/src/routes/projects.ts:383:  // Creation is an INSERT of a new row (append at Stage bottom, board_revision 0). It does not
portal/workers/app/src/routes/projects.ts:410:    SELECT id, stage_key AS stageKey, priority, board_position AS boardPosition, board_revision AS boardRevision
portal/workers/app/src/routes/projects.ts:412:  `).bind(id).first<{ id: string; stageKey: StageKey; priority: number | null; boardPosition: number; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:414:  if (target.priority === data.priority) return c.json({ priority: target.priority, boardRevision: target.boardRevision });
portal/workers/app/src/routes/projects.ts:428:      AND stage_key = ?4 AND board_position IS ?5 AND board_revision = ?6
portal/workers/app/src/routes/projects.ts:429:    RETURNING priority, board_revision
portal/workers/app/src/routes/projects.ts:430:  `).bind(data.priority, now, id, target.stageKey, target.boardPosition, target.boardRevision);
portal/workers/app/src/routes/projects.ts:432:  const rawUpdated = firstD1<{ priority: number | null; boardRevision?: number; board_revision?: number }>(result[0]);
portal/workers/app/src/routes/projects.ts:435:    boardRevision: rawUpdated.boardRevision ?? rawUpdated.board_revision,
portal/workers/app/src/routes/projects.ts:437:  if (!updated || updated.boardRevision === undefined || !rowsFromD1(result[1]).length) {
portal/workers/app/src/routes/projects.ts:438:    const current = await c.env.DB.prepare("SELECT priority, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NULL").bind(id).first<{ priority: number | null; stageKey: StageKey; boardPosition: number; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:439:    if (current && current.priority === data.priority && current.stageKey === target.stageKey && current.boardPosition === target.boardPosition && current.boardRevision === target.boardRevision) return c.json({ priority: current.priority, boardRevision: current.boardRevision });
portal/workers/app/src/routes/projects.ts:449:  const data = await jsonInput(c, boardPositionInput); if (data instanceof Response) return data;
portal/workers/app/src/routes/projects.ts:469:  // Explicit variant selection prevents a 0036 deployment from preparing board_revision.
portal/workers/app/src/routes/projects.ts:983:    const source = await c.env.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NULL").bind(id).first<{ stageKey: StageKey; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:993:        c.env.DB.prepare("UPDATE projects SET archived_at = ?, archived_by = ?, board_revision = board_revision + 1, updated_at = ? WHERE id = ? AND archived_at IS NULL AND stage_key = ? AND board_revision = ? AND NOT EXISTS (SELECT 1 FROM document_uploads WHERE project_id = ? AND status in ('pending', 'completing', 'aborting')) RETURNING id")
portal/workers/app/src/routes/projects.ts:994:        .bind(archivedAt, c.get("user").id, archivedAt, id, source.stageKey, source.boardRevision, id),
portal/workers/app/src/routes/projects.ts:1025:    const source = await c.env.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NOT NULL").bind(id).first<{ stageKey: StageKey; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:1031:      c.env.DB.prepare("UPDATE projects SET archived_at = NULL, archived_by = NULL, board_position = (SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id != ?), board_revision = board_revision + 1, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL AND stage_key = ? AND board_revision = ? RETURNING id").bind(source.stageKey, id, now.getTime(), id, source.stageKey, source.boardRevision),
portal/packages/db/test/migration-0034.test.ts:31:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'TB4C Street', 'edited_review', 0, ?, ?)").run("tb4c-project", now, now);
portal/packages/db/test/board-position-sql.test.ts:6:    const sqlite = getBuiltinModule("node:sqlite") as { DatabaseSync: new (filename: string) => { exec: (sql: string) => void; prepare: (sql: string) => { run: (...values: unknown[]) => unknown; all: () => Array<{ board_position: number }> } } };
portal/packages/db/test/board-position-sql.test.ts:8:    db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, stage_key TEXT NOT NULL, board_position REAL NOT NULL DEFAULT 0, archived_at INTEGER)");
portal/packages/db/test/board-position-sql.test.ts:9:    const move = db.prepare("UPDATE projects SET stage_key = ?, board_position = (SELECT COALESCE(MAX(board_position) + 1024, 0) FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id != ?) WHERE id = ? AND stage_key = ? AND archived_at IS NULL");
portal/packages/db/test/board-position-sql.test.ts:14:    expect(db.prepare("SELECT board_position FROM projects WHERE stage_key = 'edited_review' ORDER BY board_position").all().map((row) => row.board_position)).toEqual([0, 1024]);
portal/packages/db/test/migration-0037.test.ts:112:  boardPosition: number;
portal/packages/db/test/migration-0037.test.ts:119:  { id: "a-tie-1", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/migration-0037.test.ts:120:  { id: "a-tie-2", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/migration-0037.test.ts:121:  { id: "a-fraction", stageKey: "awaiting_raw", priority: 1, boardPosition: 4.5 },
portal/packages/db/test/migration-0037.test.ts:122:  { id: "a-null", stageKey: "awaiting_raw", priority: null, boardPosition: 8 },
portal/packages/db/test/migration-0037.test.ts:123:  { id: "b-priority-10", stageKey: "raw_review", priority: 10, boardPosition: 2 },
portal/packages/db/test/migration-0037.test.ts:124:  { id: "b-priority-5", stageKey: "raw_review", priority: 5, boardPosition: 2 },
portal/packages/db/test/migration-0037.test.ts:125:  { id: "b-null", stageKey: "raw_review", priority: null, boardPosition: -100 },
portal/packages/db/test/migration-0037.test.ts:126:  { id: "inactive-stage", stageKey: "edited_review", priority: 5, boardPosition: 99 },
portal/packages/db/test/migration-0037.test.ts:127:  { id: "delivered-project", stageKey: "delivered", priority: null, boardPosition: 7 },
portal/packages/db/test/migration-0037.test.ts:128:  { id: "archived-project", stageKey: "awaiting_raw", priority: 1, boardPosition: 123.25, archivedAt: FIXTURE_NOW + 1 },
portal/packages/db/test/migration-0037.test.ts:129:  { id: "archived-noncanonical", stageKey: "legacy_archived", priority: null, boardPosition: 987.5, archivedAt: FIXTURE_NOW + 2 },
portal/packages/db/test/migration-0037.test.ts:137:  const insert = db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
portal/packages/db/test/migration-0037.test.ts:139:    insert.run(project.id, `${project.id} Street`, project.stageKey, project.priority, project.boardPosition, project.archivedAt ?? null, FIXTURE_NOW, FIXTURE_NOW);
portal/packages/db/test/migration-0037.test.ts:144:  return db.prepare("SELECT id, stage_key, priority, board_position, archived_at FROM projects ORDER BY id").all() as SqliteRow[];
portal/packages/db/test/migration-0037.test.ts:205:      expect.objectContaining({ name: "board_revision", type: "INTEGER", notnull: 1, dflt_value: "0" }),
portal/packages/db/test/migration-0037.test.ts:208:      expect.objectContaining({ name: "editing_entry_board_revision", type: "INTEGER", notnull: 0, dflt_value: null }),
portal/packages/db/test/migration-0037.test.ts:211:      expect.objectContaining({ name: "stage_entry_board_revision", type: "INTEGER", notnull: 0, dflt_value: null }),
portal/packages/db/test/migration-0037.test.ts:236:    const expected = new Map<string, { boardPosition: number; stageKey: string; priority: number | null; archivedAt: number | null }>();
portal/packages/db/test/migration-0037.test.ts:247:        return leftNull - rightNull || Number(left.board_position) - Number(right.board_position) || String(left.id).localeCompare(String(right.id));
portal/packages/db/test/migration-0037.test.ts:250:        boardPosition: index * 1024,
portal/packages/db/test/migration-0037.test.ts:257:    const after = db.prepare("SELECT id, stage_key, priority, board_position, board_revision, archived_at FROM projects ORDER BY id").all() as SqliteRow[];
portal/packages/db/test/migration-0037.test.ts:264:        expect(row.board_position).toBe(expected.get(String(row.id))?.boardPosition);
portal/packages/db/test/migration-0037.test.ts:265:        expect(row.board_revision).toBe(1);
portal/packages/db/test/migration-0037.test.ts:267:        expect(row.board_position).toBe(original?.board_position);
portal/packages/db/test/migration-0037.test.ts:268:        expect(row.board_revision).toBe(0);
portal/packages/db/test/migration-0037.test.ts:275:    expect(db.prepare("SELECT project_id, old_board_position, normalized_board_position, visible_rank FROM project_board_order_0037_rollback ORDER BY stage_key, visible_rank").all()).toHaveLength(unarchivedCount);
portal/packages/db/test/migration-0037.test.ts:288:      seedProjects(db, [{ id: "invalid-stage", stageKey: "not_a_stage", priority: 1, boardPosition: 42 }]);
portal/packages/db/test/migration-0037.test.ts:296:      expect(hasColumn(db, "projects", "board_revision")).toBe(false);
portal/packages/db/test/migration-0037.test.ts:297:      expect(hasColumn(db, "autohdr_handoffs", "editing_entry_board_revision")).toBe(false);
portal/packages/db/test/migration-0037.test.ts:298:      expect(hasColumn(db, "jobs", "stage_entry_board_revision")).toBe(false);
portal/packages/db/test/migration-0037.test.ts:318:        BEFORE UPDATE OF board_position ON projects
portal/packages/db/test/migration-0037.test.ts:331:      expect(hasColumn(db, "projects", "board_revision")).toBe(false);
portal/packages/db/test/migration-0037.test.ts:332:      expect(hasColumn(db, "autohdr_handoffs", "editing_entry_board_revision")).toBe(false);
portal/packages/db/test/migration-0037.test.ts:333:      expect(hasColumn(db, "jobs", "stage_entry_board_revision")).toBe(false);
portal/packages/db/test/migration-0037.test.ts:370:    expect(parsed.tables.projects.columns).toHaveProperty("board_revision");
portal/packages/db/test/migration-0037.test.ts:371:    expect(parsed.tables.autohdr_handoffs.columns).toHaveProperty("editing_entry_board_revision");
portal/packages/db/test/migration-0037.test.ts:372:    expect(parsed.tables.jobs.columns).toHaveProperty("stage_entry_board_revision");
portal/packages/db/test/migration-0037.test.ts:383:    const normalized = db.prepare("SELECT id, board_position FROM projects WHERE archived_at IS NULL ORDER BY id").all() as SqliteRow[];
portal/packages/db/test/migration-0037.test.ts:384:    const oldPositions = new Map((db.prepare("SELECT project_id, old_board_position FROM project_board_order_0037_rollback").all() as SqliteRow[]).map((row) => [String(row.project_id), row.old_board_position]));
portal/packages/db/test/migration-0037.test.ts:387:    const restored = db.prepare("SELECT id, board_position FROM projects WHERE archived_at IS NULL ORDER BY id").all() as SqliteRow[];
portal/packages/db/test/migration-0037.test.ts:388:    for (const row of restored) expect(row.board_position).toBe(oldPositions.get(String(row.id)));
portal/packages/db/test/migration-0037.test.ts:389:    expect(normalized.every((row) => Number(row.board_position) !== Number(oldPositions.get(String(row.id))))).toBe(true);
portal/packages/db/test/migration-0037.test.ts:400:    const normalized = db.prepare("SELECT id, board_position FROM projects WHERE archived_at IS NULL ORDER BY id").all() as SqliteRow[];
portal/packages/db/test/migration-0037.test.ts:405:      db.prepare("UPDATE projects SET board_revision = 2 WHERE id = ?").run(driftedId);
portal/packages/db/test/migration-0037.test.ts:409:    expect(db.prepare("SELECT id, board_position FROM projects WHERE archived_at IS NULL ORDER BY id").all()).toEqual(normalized);
portal/packages/db/test/tb5a-proof-support.ts:142:  boardPosition?: number;
portal/packages/db/test/tb5a-proof-support.ts:147:  db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
portal/packages/db/test/tb5a-proof-support.ts:148:    .run(project.id, `${project.id} Street`, project.stageKey, project.priority ?? null, project.boardPosition ?? 0, project.archivedAt ?? null, FIXTURE_NOW, FIXTURE_NOW);
portal/packages/db/test/tb5a-proof-support.ts:151:export function seedContractProject(db: SqliteDatabase, project: LegacyProject & { boardRevision?: number; shootDate?: string | null }): void {
portal/packages/db/test/tb5a-proof-support.ts:152:  db.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, priority, board_position, board_revision, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
portal/packages/db/test/tb5a-proof-support.ts:153:    .run(project.id, `${project.id} Street`, project.shootDate ?? null, project.stageKey, project.priority ?? null, project.boardPosition ?? 0, project.boardRevision ?? 0, project.archivedAt ?? null, FIXTURE_NOW, FIXTURE_NOW);
portal/packages/db/test/migration-0035.test.ts:27:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4d-project', 'TB4D Street', 'edited_review', 0, ?, ?)").run(now, now);
portal/packages/db/test/migration-0030.test.ts:34:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").run("tb3-project-1", "TB3 Marker Lane", now, now);
portal/packages/db/test/migration-0030.test.ts:35:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").run("tb3-project-2", "TB3 Other Lane", now, now);
portal/packages/db/test/migration-0036.test.ts:27:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, notes, created_at, updated_at) VALUES ('tb4e-project', 'TB4E Street', 'edited_review', 0, 'internal legacy note', ?, ?)").run(now, now);
portal/packages/db/test/stage-board-bundles.test.ts:109:function seedProject(db: SqliteDatabase, input: { id: string; stageKey: string; boardPosition?: number; boardRevision?: number; shootDate?: string }): void {
portal/packages/db/test/stage-board-bundles.test.ts:111:  db.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, board_position, board_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
portal/packages/db/test/stage-board-bundles.test.ts:112:    .run(input.id, `${input.id} Street`, input.shootDate ?? null, input.stageKey, input.boardPosition ?? 0, input.boardRevision ?? 0, now, now);
portal/packages/db/test/stage-board-bundles.test.ts:146:  seedProject(db, { id: "target", stageKey: "raw_review", boardPosition: 4, boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:147:  seedProject(db, { id: "sibling-a", stageKey: "edited_review", boardPosition: 1024, boardRevision: 2 });
portal/packages/db/test/stage-board-bundles.test.ts:148:  seedProject(db, { id: "sibling-b", stageKey: "edited_review", boardPosition: 4096, boardRevision: 3 });
portal/packages/db/test/stage-board-bundles.test.ts:150:    { projectId: "sibling-a", stageKey: "edited_review", boardPosition: 1024, boardRevision: 2, newBoardPosition: 0 },
portal/packages/db/test/stage-board-bundles.test.ts:151:    { projectId: "sibling-b", stageKey: "edited_review", boardPosition: 4096, boardRevision: 3, newBoardPosition: 2048 },
portal/packages/db/test/stage-board-bundles.test.ts:165:    expect(APPEND_STAGE_BOTTOM_SQL).toBe(blocks.find((block) => block.includes("SELECT COALESCE(MAX(board_position) + 1024, 0)")));
portal/packages/db/test/stage-board-bundles.test.ts:166:    expect(NORMATIVE_NON_COMPACTING_EXACT_SQL).toBe(blocks.find((block) => block.includes("board_position = ?8")));
portal/packages/db/test/stage-board-bundles.test.ts:170:    expect(NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL).toBe(blocks.find((block) => block.includes("UPDATE jobs") && block.includes("stage_entry_board_revision")));
portal/packages/db/test/stage-board-bundles.test.ts:179:      seedProject(db, { id: "target", stageKey: "raw_review", boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:183:      expect((appendResults[append.indexes.winner]!.results as SqliteRow[])).toEqual([{ id: "target", stage_key: "edited_review", board_position: 0, board_revision: 6 }]);
portal/packages/db/test/stage-board-bundles.test.ts:185:      expect(db.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = 'target'").get()).toEqual({ stage_key: "edited_review", board_position: 0, board_revision: 6 });
portal/packages/db/test/stage-board-bundles.test.ts:188:      db.prepare("UPDATE projects SET stage_key = 'raw_review', board_position = 3, board_revision = 5 WHERE id = 'target'").run();
portal/packages/db/test/stage-board-bundles.test.ts:189:      seedProject(db, { id: "destination", stageKey: "edited_review", boardPosition: 1024, boardRevision: 8 });
portal/packages/db/test/stage-board-bundles.test.ts:190:      const expected: ExpectedTargetPlacementRow[] = [{ projectId: "destination", stageKey: "edited_review", boardPosition: 1024, boardRevision: 8 }];
portal/packages/db/test/stage-board-bundles.test.ts:191:      const exact = buildNonCompactingStageWinner({ ...baseStageInput(d1), placement: "exact", expectedTarget: expected, boardPosition: 512, expectedTargetRowCount: 1 });
portal/packages/db/test/stage-board-bundles.test.ts:194:      expect((exactResults[exact.indexes.winner]!.results as SqliteRow[])[0]).toMatchObject({ id: "target", board_position: 512, board_revision: 6 });
portal/packages/db/test/stage-board-bundles.test.ts:198:      db.prepare("UPDATE projects SET stage_key = 'raw_review', board_position = 3, board_revision = 5 WHERE id = 'target'").run();
portal/packages/db/test/stage-board-bundles.test.ts:199:      db.prepare("UPDATE projects SET board_position = 2048 WHERE id = 'destination'").run();
portal/packages/db/test/stage-board-bundles.test.ts:200:      const stale = buildNonCompactingStageWinner({ ...baseStageInput(d1), placement: "exact", expectedTarget: expected, boardPosition: 512, expectedTargetRowCount: 1 });
portal/packages/db/test/stage-board-bundles.test.ts:204:      expect(db.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = 'target'").get()).toEqual({ stage_key: "raw_review", board_position: 3, board_revision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:224:      expect(db.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all()).toEqual([
portal/packages/db/test/stage-board-bundles.test.ts:225:        { id: "sibling-a", stage_key: "edited_review", board_position: 0, board_revision: 3 },
portal/packages/db/test/stage-board-bundles.test.ts:226:        { id: "sibling-b", stage_key: "edited_review", board_position: 2048, board_revision: 4 },
portal/packages/db/test/stage-board-bundles.test.ts:227:        { id: "target", stage_key: "edited_review", board_position: 1024, board_revision: 6 },
portal/packages/db/test/stage-board-bundles.test.ts:261:      if (caseName === "extra expected row") { expected = [...fixture.expected, { projectId: "ghost", stageKey: "edited_review", boardPosition: 8192, boardRevision: 1, newBoardPosition: 4096 }]; expectedCount = 3; }
portal/packages/db/test/stage-board-bundles.test.ts:263:      if (caseName === "concurrent snapshot drift") db.prepare("UPDATE projects SET board_position = 8192 WHERE id = 'sibling-b'").run();
portal/packages/db/test/stage-board-bundles.test.ts:266:      const before = db.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all();
portal/packages/db/test/stage-board-bundles.test.ts:270:      expect(db.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all()).toEqual(before);
portal/packages/db/test/stage-board-bundles.test.ts:296:      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:304:      expect(tokenResults[0]!.results).toEqual([{ id: "handoff", project_id: "target", generation: 1, editing_entry_board_revision: 5 }]);
portal/packages/db/test/stage-board-bundles.test.ts:305:      expect(db.prepare("SELECT editing_entry_board_revision FROM autohdr_handoffs WHERE id = 'handoff'").get()).toEqual({ editing_entry_board_revision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:307:      db.prepare("UPDATE projects SET stage_key = 'raw_review', board_revision = 6 WHERE id = 'target'").run();
portal/packages/db/test/stage-board-bundles.test.ts:308:      db.prepare("UPDATE projects SET stage_key = 'editing_autohdr', board_revision = 7 WHERE id = 'target'").run();
portal/packages/db/test/stage-board-bundles.test.ts:309:      const completion = db.prepare("UPDATE projects SET stage_key = 'edited_review' WHERE id = ? AND stage_key = 'editing_autohdr' AND board_revision = ?").run("target", 5) as { changes?: number };
portal/packages/db/test/stage-board-bundles.test.ts:312:      db.prepare("UPDATE projects SET board_revision = 7 WHERE id = 'target'").run();
portal/packages/db/test/stage-board-bundles.test.ts:313:      db.prepare("UPDATE autohdr_handoffs SET editing_entry_board_revision = NULL WHERE id = 'handoff'").run();
portal/packages/db/test/stage-board-bundles.test.ts:335:        seedProject(db, { id: "target", stageKey: premise.projectStage, boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:338:        db.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, editing_entry_board_revision, created_at, updated_at) VALUES ('handoff', 'target', 'connection', 1, 'hash', '[]', '[]', '/Raw/target', 'started', 'workflow', 'entry-job', 2, ?, 1, 1)").run(premise.storedToken ?? null);
portal/packages/db/test/stage-board-bundles.test.ts:365:      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:399:      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 7 });
portal/packages/db/test/stage-board-bundles.test.ts:417:      seedProject(db, { id: "target", stageKey: "editing_autohdr", boardRevision: 5 });
portal/packages/db/test/stage-board-bundles.test.ts:418:      db.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, stage_entry_board_revision, created_at, updated_at) VALUES ('entry-job', 'autohdr', 'done', 'target', '{\"projectId\":\"target\",\"generation\":1,\"stageEntrySourceJobId\":\"entry-job\",\"stageEntryGeneration\":1}', 5, 1, 1)").run();
portal/packages/db/test/stage-board-bundles.test.ts:419:      db.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, stage_entry_board_revision, created_at, updated_at) VALUES ('completion-job', 'fetch_edited', 'done', 'target', '{\"projectId\":\"target\",\"generation\":1,\"stageEntrySourceJobId\":\"entry-job\",\"stageEntryGeneration\":1}', NULL, 1, 1)").run();
portal/packages/db/test/stage-board-bundles.test.ts:424:      expect(validResults[valid.indexes.sourceEntryJob]!.results).toEqual([{ id: "entry-job", project_id: "target", stage_entry_board_revision: 5 }]);
portal/packages/db/test/stage-board-bundles.test.ts:428:      db.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, stage_entry_board_revision, created_at, updated_at) VALUES ('impostor-job', 'autohdr', 'done', 'target', '{\"projectId\":\"target\",\"generation\":1}', 5, 1, 1)").run();
portal/packages/db/test/stage-board-bundles.test.ts:495:      row: { projectId: "target", stageKey: "edited_review" as const, boardPosition: 0, boardRevision: 6 },
portal/packages/db/test/stage-board-bundles.test.ts:503:    expect(deriveStageFinalizerIntent([winner, { ...winner, row: { ...winner.row, boardRevision: 7 } }])).toBeUndefined();
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:26:function boardRows(db: SqliteDatabase): Array<{ id: string; board_position: number; board_revision: number }> {
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:27:  return db.prepare("SELECT id, board_position, board_revision FROM projects WHERE archived_at IS NULL ORDER BY board_position, id").all() as Array<{ id: string; board_position: number; board_revision: number }>;
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:35:    expected.push({ projectId: id, stageKey: "edited_review", boardPosition: index * 1024, boardRevision: 0, newBoardPosition: (index + 1) * 1024 });
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:46:  seedContractProject(db, { id: "target", stageKey: "raw_review", boardPosition: 777, boardRevision: 5 });
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:48:    seedContractProject(db, { id: `edited-${String(index).padStart(4, "0")}`, stageKey: "edited_review", boardPosition: index * 1024, boardRevision: 0 });
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:83:        expect(rows.map((row) => row.board_position)).toEqual(Array.from({ length: size + 1 }, (_, index) => index * 1024));
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:84:        expect(rows.find((row) => row.id === "target")?.board_revision).toBe(6);
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:85:        expect(rows.filter((row) => row.id !== "target").every((row) => row.board_revision === 1)).toBe(true);
portal/packages/db/test/tb5a-compaction-benchmark.test.ts:95:          revisionsIncremented: rows.filter((candidate) => candidate.board_revision > 0).length,
portal/packages/db/test/dashboard-order.characterization.test.ts:41:      sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, shoot_date TEXT, priority INTEGER, board_position REAL NOT NULL)");
portal/packages/db/test/dashboard-order.characterization.test.ts:42:      sqlite.exec("INSERT INTO projects (id, shoot_date, priority, board_position) VALUES ('null-priority', '2026-07-22', NULL, 4096), ('priority-midpoint', '2026-07-21', 2, 1536), ('priority-tie', '2026-07-20', 1, 1536), ('no-date', NULL, NULL, 0)");
portal/apps/web/src/lib/stage-move.test.ts:7:  expected: { stageKey: "awaiting_raw", boardRevision: 4 },
portal/packages/db/test/tb5a-migration-proof.test.ts:47:  return db.prepare("SELECT id, stage_key, priority, board_position, board_revision, archived_at FROM projects WHERE stage_key = ? AND archived_at IS NULL ORDER BY board_position, id").all(stageKey) as SqliteRow[];
portal/packages/db/test/tb5a-migration-proof.test.ts:55:  seedContractProject(db, { id: "target", stageKey: "raw_review", boardPosition: 7, boardRevision: 5 });
portal/packages/db/test/tb5a-migration-proof.test.ts:56:  seedContractProject(db, { id: "sibling-a", stageKey: "edited_review", boardPosition: 0, boardRevision: 2 });
portal/packages/db/test/tb5a-migration-proof.test.ts:57:  seedContractProject(db, { id: "sibling-b", stageKey: "edited_review", boardPosition: 1024, boardRevision: 3 });
portal/packages/db/test/tb5a-migration-proof.test.ts:60:      { projectId: "sibling-a", stageKey: "edited_review", boardPosition: 0, boardRevision: 2, newBoardPosition: 1024 },
portal/packages/db/test/tb5a-migration-proof.test.ts:61:      { projectId: "sibling-b", stageKey: "edited_review", boardPosition: 1024, boardRevision: 3, newBoardPosition: 2048 },
portal/packages/db/test/tb5a-migration-proof.test.ts:99:        { id: "a-tie-a", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/tb5a-migration-proof.test.ts:100:        { id: "a-tie-b", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/tb5a-migration-proof.test.ts:101:        { id: "a-fraction", stageKey: "awaiting_raw", priority: 1, boardPosition: 4.5 },
portal/packages/db/test/tb5a-migration-proof.test.ts:102:        { id: "a-null", stageKey: "awaiting_raw", priority: null, boardPosition: -100 },
portal/packages/db/test/tb5a-migration-proof.test.ts:103:        { id: "b-priority", stageKey: "raw_review", priority: 1, boardPosition: 9 },
portal/packages/db/test/tb5a-migration-proof.test.ts:104:        { id: "inactive-occupant", stageKey: "edited_review", priority: 1, boardPosition: 99 },
portal/packages/db/test/tb5a-migration-proof.test.ts:105:        { id: "delivered-project", stageKey: "delivered", priority: null, boardPosition: 7 },
portal/packages/db/test/tb5a-migration-proof.test.ts:106:        { id: "archived-project", stageKey: "awaiting_raw", priority: 1, boardPosition: 123.25, archivedAt: FIXTURE_NOW + 1 },
portal/packages/db/test/tb5a-migration-proof.test.ts:107:        { id: "archived-noncanonical", stageKey: "legacy_archived", priority: null, boardPosition: 987.5, archivedAt: FIXTURE_NOW + 2 },
portal/packages/db/test/tb5a-migration-proof.test.ts:110:      const archivedBefore = db.prepare("SELECT id, stage_key, priority, board_position, archived_at FROM projects WHERE archived_at IS NOT NULL ORDER BY id").all();
portal/packages/db/test/tb5a-migration-proof.test.ts:115:      expect(stageRows(db, "awaiting_raw").map((row) => row.board_position)).toEqual([0, 1024, 2048, 3072]);
portal/packages/db/test/tb5a-migration-proof.test.ts:116:      expect(stageRows(db, "raw_review").map((row) => row.board_position)).toEqual([0]);
portal/packages/db/test/tb5a-migration-proof.test.ts:117:      expect(stageRows(db, "edited_review").map((row) => row.board_position)).toEqual([0]);
portal/packages/db/test/tb5a-migration-proof.test.ts:118:      expect(stageRows(db, "delivered").map((row) => row.board_position)).toEqual([0]);
portal/packages/db/test/tb5a-migration-proof.test.ts:119:      expect(db.prepare("SELECT COUNT(*) AS count FROM projects WHERE archived_at IS NULL AND board_revision = 1").get()).toEqual({ count: 7 });
portal/packages/db/test/tb5a-migration-proof.test.ts:120:      expect(db.prepare("SELECT id, stage_key, priority, board_position, archived_at FROM projects WHERE archived_at IS NOT NULL ORDER BY id").all()).toEqual(archivedBefore);
portal/packages/db/test/tb5a-migration-proof.test.ts:148:    expect(APPEND_STAGE_BOTTOM_SQL).toBe(blocks.find((block) => block.includes("SELECT COALESCE(MAX(board_position) + 1024, 0)")));
portal/packages/db/test/tb5a-migration-proof.test.ts:149:    expect(NORMATIVE_NON_COMPACTING_EXACT_SQL).toBe(blocks.find((block) => block.includes("board_position = ?8")));
portal/packages/db/test/tb5a-migration-proof.test.ts:153:    expect(NORMATIVE_JOB_EDITING_ENTRY_TOKEN_SQL).toBe(blocks.find((block) => block.includes("UPDATE jobs") && block.includes("stage_entry_board_revision")));
portal/packages/db/test/tb5a-migration-proof.test.ts:163:        seedLegacyProject(db, { id: "invalid-stage", stageKey: "not_a_stage", boardPosition: 42 });
portal/packages/db/test/tb5a-migration-proof.test.ts:184:          { id: "valid-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 },
portal/packages/db/test/tb5a-migration-proof.test.ts:185:          { id: "valid-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 },
portal/packages/db/test/tb5a-migration-proof.test.ts:189:          BEFORE UPDATE OF board_position ON projects
portal/packages/db/test/tb5a-migration-proof.test.ts:195:        const before = db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all();
portal/packages/db/test/tb5a-migration-proof.test.ts:201:        expect(db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all()).toEqual(before);
portal/packages/db/test/tb5a-migration-proof.test.ts:216:        { id: "rollback-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 },
portal/packages/db/test/tb5a-migration-proof.test.ts:217:        { id: "rollback-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 },
portal/packages/db/test/tb5a-migration-proof.test.ts:219:      const original = db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all();
portal/packages/db/test/tb5a-migration-proof.test.ts:221:      const normalized = db.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY id").all();
portal/packages/db/test/tb5a-migration-proof.test.ts:222:      const oldPositions = new Map((db.prepare("SELECT project_id, old_board_position FROM project_board_order_0037_rollback").all() as SqliteRow[]).map((row) => [row.project_id, row.old_board_position]));
portal/packages/db/test/tb5a-migration-proof.test.ts:224:      expect(db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all()).toEqual(original);
portal/packages/db/test/tb5a-migration-proof.test.ts:225:      expect(db.prepare("SELECT id, board_revision FROM projects ORDER BY id").all()).toEqual(normalized.map((row) => ({ id: row.id, board_revision: 1 })));
portal/packages/db/test/tb5a-migration-proof.test.ts:233:        seedLegacyProject(drifted, { id: "drift-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 });
portal/packages/db/test/tb5a-migration-proof.test.ts:234:        seedLegacyProject(drifted, { id: "drift-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 });
portal/packages/db/test/tb5a-migration-proof.test.ts:236:        const before = drifted.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all();
portal/packages/db/test/tb5a-migration-proof.test.ts:237:        drifted.prepare("UPDATE projects SET board_revision = 2 WHERE id = 'drift-a'").run();
portal/packages/db/test/tb5a-migration-proof.test.ts:239:        expect(drifted.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all()).toEqual(before.map((row) => row.id === "drift-a" ? { ...row, board_revision: 2 } : row));
portal/packages/db/test/tb5a-migration-proof.test.ts:260:      seedContractProject(db, { id: "target", stageKey: "raw_review", boardRevision: 5 });
portal/packages/db/test/tb5a-migration-proof.test.ts:264:      expect(appendResults[append.indexes.winner]!.results).toMatchObject([{ id: "target", stage_key: "edited_review", board_position: 0, board_revision: 6 }]);
portal/packages/db/test/tb5a-migration-proof.test.ts:281:      expect(compactPlanDb.prepare("SELECT id, board_position, board_revision FROM projects ORDER BY board_position, id").all()).toEqual([
portal/packages/db/test/tb5a-migration-proof.test.ts:282:        { id: "target", board_position: 0, board_revision: 6 },
portal/packages/db/test/tb5a-migration-proof.test.ts:283:        { id: "sibling-a", board_position: 1024, board_revision: 3 },
portal/packages/db/test/tb5a-migration-proof.test.ts:284:        { id: "sibling-b", board_position: 2048, board_revision: 4 },
portal/packages/db/test/tb5a-migration-proof.test.ts:325:        const before = malformedDb.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all();
portal/packages/db/test/tb5a-migration-proof.test.ts:331:        expect(malformedDb.prepare("SELECT id, stage_key, board_position, board_revision FROM projects ORDER BY id").all(), caseName).toEqual(before);
portal/packages/db/test/project-activity.test.ts:88:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4c-project', 'TB4C Street', 'edited_review', 0, ?, ?)").run(now, now);
portal/packages/db/test/project-activity.test.ts:107:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4c-project', 'TB4C Street', 'edited_review', 0, ?, ?)").run(now, now);
portal/packages/db/test/project-activity.test.ts:140:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4c-project', 'TB4C Street', 'edited_review', 0, ?, ?)").run(start, start);
portal/packages/db/test/project-activity.test.ts:173:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4c-project', 'TB4C Street', 'edited_review', 0, ?, ?)").run(start, start);
portal/packages/db/test/migration-0031.test.ts:66:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4-project', 'TB4 Street', 'edited_review', 0, ?, ?)").run(now, now);
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:16:  boardRevision: 0,
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:18:  boardPosition: 0,
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:25:	it("uses the authorized Board map and never boardPosition", () => {
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:27:			{ ...project, id: "a", boardPosition: 999, authorizedBoardOrder: { awaiting_raw: ["b", "a", "c"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:28:			{ ...project, id: "b", boardPosition: 1, authorizedBoardOrder: { awaiting_raw: ["b", "a", "c"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:29:			{ ...project, id: "c", boardPosition: 2, authorizedBoardOrder: { awaiting_raw: ["b", "a", "c"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:48:			{ ...project, id: "source", stageKey: "awaiting_raw" as const, boardRevision: 3, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:49:			{ ...project, id: "before", stageKey: "raw_review" as const, boardRevision: 8, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:50:			{ ...project, id: "target", stageKey: "raw_review" as const, boardRevision: 9, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:51:			{ ...project, id: "after", stageKey: "raw_review" as const, boardRevision: 10, authorizedBoardOrder: { raw_review: ["before", "target", "after"] } },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:56:			before: { projectId: "before", boardRevision: 8 },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:57:			after: { projectId: "target", boardRevision: 9 },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:61:			before: { projectId: "target", boardRevision: 9 },
portal/apps/web/src/screens/Dashboard-board-order.characterization.test.ts:62:			after: { projectId: "after", boardRevision: 10 },
portal/workers/app/src/lib/ingest.ts:232:        "SELECT board_revision AS boardRevision FROM projects WHERE id = ? AND stage_key = 'awaiting_raw' AND archived_at IS NULL",
portal/workers/app/src/lib/ingest.ts:233:      ).bind(input.projectId).first<{ boardRevision: number }>();
portal/workers/app/src/lib/ingest.ts:235:        "SELECT id AS projectId, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE stage_key = 'raw_review' AND archived_at IS NULL AND id <> ? ORDER BY board_position, id",
portal/workers/app/src/lib/ingest.ts:244:          oldBoardRevision: source.boardRevision,
portal/workers/app/src/lib/ingest.ts:267:          ? winnerRows[0] as { id?: string; stage_key?: string; board_position?: number; board_revision?: number }
portal/workers/app/src/lib/ingest.ts:274:          && typeof winner.board_position === "number"
portal/workers/app/src/lib/ingest.ts:275:          && Number.isFinite(winner.board_position)
portal/workers/app/src/lib/ingest.ts:276:          && typeof winner.board_revision === "number"
portal/workers/app/src/lib/ingest.ts:277:          && Number.isInteger(winner.board_revision)
portal/workers/app/src/lib/ingest.ts:278:          && winner.board_revision === source.boardRevision + 1
portal/workers/app/src/lib/ingest.ts:282:            row: { projectId: winner.id, stageKey: winner.stage_key as "raw_review", boardPosition: winner.board_position, boardRevision: winner.board_revision },
portal/workers/app/src/lib/external-project-query.ts:25:  boardRevision: number;
portal/workers/app/src/lib/external-project-query.ts:27:  boardPosition: number;
portal/workers/app/src/lib/external-project-query.ts:87:      boardRevision: Number("boardRevision" in row ? row.boardRevision ?? 0 : 0),
portal/workers/app/src/lib/external-project-query.ts:89:      boardPosition: Number(row.boardPosition),
portal/workers/app/src/lib/external-project-query.ts:107:    boardRevision: project.boardRevision,
portal/workers/app/src/lib/external-project-query.ts:150:    rows.sort((left, right) => (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0) || left.boardPosition - right.boardPosition || left.id.localeCompare(right.id));
portal/workers/app/src/lib/project-stage.ts:63:  return row ? { projectId: row.id, stageKey: stageTransportKeyForRole(row.stageKey, role), boardRevision: row.boardRevision } : null;
portal/workers/app/src/lib/project-stage.ts:75:    project: { projectId: row.id, stageKey: stageTransportKeyForRole(row.stageKey, role), boardRevision: row.boardRevision },
portal/workers/app/src/lib/project-stage.ts:115:  const winner = (results[winnerIndex]?.results ?? []).find((item) => (item as { id?: unknown }).id === projectId) as { id?: string; stage_key?: StageKey; stageKey?: StageKey; board_position?: number; boardPosition?: number; board_revision?: number; boardRevision?: number } | undefined;
portal/workers/app/src/lib/project-stage.ts:119:  const boardPosition = winner.boardPosition ?? winner.board_position;
portal/workers/app/src/lib/project-stage.ts:120:  const boardRevision = winner.boardRevision ?? winner.board_revision;
portal/workers/app/src/lib/project-stage.ts:121:  if (!stageKey || boardPosition === undefined || boardRevision === undefined) return null;
portal/workers/app/src/lib/project-stage.ts:125:    row: { projectId: winner.id, stageKey, boardPosition, boardRevision },
portal/workers/app/src/lib/project-stage.ts:149:  if (!expectedStageKey || !targetStageKey || expectedStageKey !== project.stageKey || input.request.expected.boardRevision !== project.boardRevision) {
portal/workers/app/src/lib/project-stage.ts:189:      oldBoardRevision: project.boardRevision, expectedTarget: placement.expectedTarget.map((row) => ({ ...row, newBoardPosition: row.newBoardPosition! })),
portal/workers/app/src/lib/project-stage.ts:196:      oldBoardRevision: project.boardRevision, expectedTarget: placement.expectedTarget,
portal/workers/app/src/lib/project-stage.ts:197:      placement: placement.placement, exactBoardPosition: placement.boardPosition,
portal/packages/db/test/migration-0033.test.ts:32:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES ('tb4b-existing-project', 'Existing', 'edited_review', 0, ?, ?)").run(now, now);
portal/packages/db/test/migration-0033.test.ts:48:    db.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at, deadline_version) VALUES ('tb4b-project', 'TB4B Street', 'edited_review', 0, ?, ?, 1)").run(now, now);
portal/packages/shared/src/board-projection.ts:14:  boardRevision: number;
portal/workers/app/test/api.test.ts:280:  const current = await database.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ?")
portal/workers/app/test/api.test.ts:281:    .bind(projectId).first<{ stageKey: string; boardRevision: number }>();
portal/workers/app/test/api.test.ts:283:    expected: { stageKey: expectedStageKey ?? current?.stageKey, boardRevision: current?.boardRevision },
portal/workers/app/test/api.test.ts:3534:      expected: { stageKey: "awaiting_raw", boardRevision: 0 },
portal/workers/app/test/api.test.ts:3538:        before: { projectId: before, boardRevision: 0 },
portal/workers/app/test/api.test.ts:3539:        after: { projectId: after, boardRevision: 0 },
portal/workers/app/test/api.test.ts:3543:      database.DB.prepare("SELECT stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE id IN (?, ?, ?) ORDER BY board_position, id").bind(target, before, after).all(),
portal/packages/db/test/board-schema-variant.test.ts:66:    expect(() => sqlite.prepare("SELECT board_revision FROM projects").get()).toThrow();
portal/packages/db/test/board-schema-variant.test.ts:73:    expect(Object.hasOwn(projectColumnsForVariant("pre_0037"), "boardRevision")).toBe(false);
portal/packages/db/test/board-schema-variant.test.ts:87:    expect(Object.hasOwn(projectColumnsForVariant(variant), "boardRevision")).toBe(false);
portal/packages/db/test/tb5a-slice-6-closeout.test.ts:23:      expect(text, relativePath).not.toMatch(/UPDATE\s+projects[\s\S]{0,300}\bSET\b[\s\S]{0,180}\bboard_position\s*=/i);
portal/packages/db/test/tb5a-slice-6-closeout.test.ts:24:      expect(text, relativePath).not.toMatch(/db\.update\(projects\)\.set\([\s\S]{0,180}boardPosition\s*:/i);
portal/packages/db/test/tb5a-slice-6-closeout.test.ts:33:    expect(tonomo).toMatch(/stageKey:\s*"awaiting_raw"[\s\S]{0,180}boardPosition:[\s\S]{0,180}boardRevision:\s*0/);
portal/workers/app/test/project-subtask-command.test.ts:29:  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").bind(projectId, `Command ${projectId}`, now, now).run();
portal/workers/app/test/project-comments.test.ts:39:  for (const [id, street] of [[projectId, "Comment Street"], [otherProjectId, "Other Street"]]) await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").bind(id, street, now, now).run();
portal/workers/app/test/project-subtasks.test.ts:27:  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Subtask Street', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
portal/workers/app/test/project-subtasks.test.ts:130:    for (const id of [guardedProject, otherProject]) await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").bind(id, `Reorder ${id}`, now, now).run();
portal/workers/app/test/project-subtasks.test.ts:143:    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Tied rebase', 'editing_autohdr', 0, ?, ?)").bind(tiedProject, now, now).run();
portal/workers/app/test/project-subtasks.test.ts:148:    const longProject = crypto.randomUUID(); await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Long tied rebase', 'editing_autohdr', 0, ?, ?)").bind(longProject, now, now).run();
portal/workers/app/test/project-subtasks.test.ts:159:    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Ordinary reorders', 'editing_autohdr', 0, ?, ?)").bind(ordinaryProject, now, now).run();
portal/workers/app/test/project-subtasks.test.ts:175:    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Fractional midpoint', 'editing_autohdr', 0, ?, ?)").bind(midpointProject, now, now).run();
portal/workers/app/test/project-subtasks.test.ts:250:    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Final role isolation', 'editing_autohdr', 0, ?, ?)").bind(isolatedProject, now, now).run();
portal/packages/shared/src/stage-move.ts:77:export const boardRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
portal/packages/shared/src/stage-move.ts:80:  boardRevision: boardRevisionSchema,
portal/packages/shared/src/stage-move.ts:85:  boardRevision: number;
portal/packages/shared/src/stage-move.ts:119:    boardRevision: number;
portal/packages/shared/src/stage-move.ts:132:    boardRevision: boardRevisionSchema,
portal/packages/shared/src/stage-move.ts:155:  boardRevision: number;
portal/packages/shared/src/stage-move.ts:173:  boardRevision: boardRevisionSchema,
portal/workers/app/test/project-subtask-inert.test.ts:35:  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Inert schedule', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
portal/packages/shared/src/external-project-dto.ts:112:  boardRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
portal/workers/app/test/kanban-ordering.integration.test.ts:37:async function seedProject(id: string, stageKey: string, boardPosition: number, priority: number | null = null) {
portal/workers/app/test/kanban-ordering.integration.test.ts:39:  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, board_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
portal/workers/app/test/kanban-ordering.integration.test.ts:40:    .bind(id, id, stageKey, priority, boardPosition, now, now).run();
portal/workers/app/test/kanban-ordering.integration.test.ts:61:    expect(await response.json()).toEqual({ priority: 2, boardRevision: 0 });
portal/workers/app/test/kanban-ordering.integration.test.ts:62:    expect(await database.DB.prepare("SELECT priority, board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ priority: 2, board_position: 4096, board_revision: 0 });
portal/workers/app/test/kanban-ordering.integration.test.ts:70:    expect((await response.json()).project).toMatchObject({ projectId: target, boardRevision: 1 });
portal/workers/app/test/kanban-ordering.integration.test.ts:71:    expect(await database.DB.prepare("SELECT board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ board_position: 0, board_revision: 1 });
portal/workers/app/test/kanban-ordering.integration.test.ts:72:    expect(await database.DB.prepare("SELECT action FROM audit_log WHERE target_id = ? ORDER BY created_at DESC LIMIT 1").bind(target).first()).toEqual({ action: "project.board_position_set" });
portal/workers/app/test/kanban-ordering.integration.test.ts:78:    const body = { expected: { stageKey: "raw_review", boardRevision: 0 }, targetStageKey: "delivered", placement: { kind: "append" } };
portal/workers/app/test/kanban-ordering.integration.test.ts:84:    expect((await confirmed.json()).project).toMatchObject({ projectId: target, stageKey: "delivered", boardRevision: 1 });
portal/workers/app/test/kanban-ordering.integration.test.ts:95:    expect(await database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ stage_key: "raw_review", board_revision: 0 });
portal/workers/app/src/lib/project-board-order.ts:34:  boardPosition: number;
portal/workers/app/src/lib/project-board-order.ts:35:  boardRevision: number;
portal/workers/app/src/lib/project-board-order.ts:46:  boardPosition: number;
portal/workers/app/src/lib/project-board-order.ts:47:  expectedTarget: Array<{ projectId: string; stageKey: StageKey; boardPosition: number; boardRevision: number; newBoardPosition?: number }>;
portal/workers/app/src/lib/project-board-order.ts:82:    || left.boardPosition - right.boardPosition
portal/workers/app/src/lib/project-board-order.ts:90:    boardRevision: row.boardRevision,
portal/workers/app/src/lib/project-board-order.ts:106:      boardRevision: target.boardRevision,
portal/workers/app/src/lib/project-board-order.ts:118:    SELECT id, stage_key AS stageKey, priority, board_position AS boardPosition,
portal/workers/app/src/lib/project-board-order.ts:119:      board_revision AS boardRevision, archived_at AS archivedAt
portal/workers/app/src/lib/project-board-order.ts:126:    SELECT id, stage_key AS stageKey, priority, board_position AS boardPosition,
portal/workers/app/src/lib/project-board-order.ts:127:      board_revision AS boardRevision
portal/workers/app/src/lib/project-board-order.ts:145:      p.board_position AS boardPosition, p.board_revision AS boardRevision
portal/workers/app/src/lib/project-board-order.ts:183:    if (before && (!visibleById.has(before.projectId) || fullById.get(before.projectId)?.boardRevision !== before.boardRevision)) return null;
portal/workers/app/src/lib/project-board-order.ts:184:    if (after && (!visibleById.has(after.projectId) || fullById.get(after.projectId)?.boardRevision !== after.boardRevision)) return null;
portal/workers/app/src/lib/project-board-order.ts:220:      boardPosition: target.boardPosition,
portal/workers/app/src/lib/project-board-order.ts:224:        boardPosition: row.boardPosition,
portal/workers/app/src/lib/project-board-order.ts:225:        boardRevision: row.boardRevision,
portal/workers/app/src/lib/project-board-order.ts:233:  const candidate = computeInsertPosition(previous?.boardPosition ?? null, next?.boardPosition ?? null);
portal/workers/app/src/lib/project-board-order.ts:234:  const collides = !Number.isFinite(candidate) || destinationWithoutTarget.some((row) => row.boardPosition === candidate);
portal/workers/app/src/lib/project-board-order.ts:242:    || target.boardPosition !== finalPosition;
portal/workers/app/src/lib/project-board-order.ts:246:    boardPosition: row.boardPosition,
portal/workers/app/src/lib/project-board-order.ts:247:    boardRevision: row.boardRevision,
portal/workers/app/src/lib/project-board-order.ts:254:      if (row.id === target.id) changedPlan.push({ projectId: row.id, oldStageKey: target.stageKey, oldBoardPosition: target.boardPosition, oldBoardRevision: target.boardRevision, newBoardPosition, isTarget: 1 });
portal/workers/app/src/lib/project-board-order.ts:255:      else if (row.boardPosition !== newBoardPosition) changedPlan.push({ projectId: row.id, oldStageKey: row.stageKey, oldBoardPosition: row.boardPosition, oldBoardRevision: row.boardRevision, newBoardPosition, isTarget: 0 });
portal/workers/app/src/lib/project-board-order.ts:258:    changedPlan.push({ projectId: target.id, oldStageKey: target.stageKey, oldBoardPosition: target.boardPosition, oldBoardRevision: target.boardRevision, newBoardPosition: finalPosition, isTarget: 1 });
portal/workers/app/src/lib/project-board-order.ts:266:    boardPosition: finalPosition,
portal/workers/app/src/lib/project-board-order.ts:286:    before: before ? { projectId: before.id, boardRevision: before.boardRevision } : null,
portal/workers/app/src/lib/project-board-order.ts:287:    after: after ? { projectId: after.id, boardRevision: after.boardRevision } : null,
portal/workers/app/src/lib/project-board-order.ts:292:  const winner = (results[winnerIndex]?.results ?? []).find((row) => (row as { id?: unknown }).id === projectId) as { id?: string; stageKey?: StageKey; stage_key?: StageKey; boardPosition?: number; board_position?: number; boardRevision?: number; board_revision?: number } | undefined;
portal/workers/app/src/lib/project-board-order.ts:295:  const boardPosition = winner?.boardPosition ?? winner?.board_position;
portal/workers/app/src/lib/project-board-order.ts:296:  const boardRevision = winner?.boardRevision ?? winner?.board_revision;
portal/workers/app/src/lib/project-board-order.ts:297:  if (!winner?.id || !stageKey || boardPosition === undefined || boardRevision === undefined || !auditRow?.id) return null;
portal/workers/app/src/lib/project-board-order.ts:303:    row: { projectId: winner.id, stageKey, boardPosition, boardRevision },
portal/workers/app/src/lib/project-board-order.ts:326:  const expected = "direction" in input.request ? { stageKey: current.stageKey, boardRevision: current.boardRevision } : input.request.expected;
portal/workers/app/src/lib/project-board-order.ts:329:  if (expectedStage !== current.stageKey || expected.boardRevision !== current.boardRevision) {
portal/workers/app/src/lib/project-board-order.ts:342:    ? { expected: { stageKey: stageTransportKeyForRole(current.stageKey, principal.role), boardRevision: current.boardRevision }, targetStageKey: stageTransportKeyForRole(current.stageKey, principal.role), placement: directionPlacement(visibleRows, current.id, input.request.direction) }
portal/workers/app/src/lib/project-board-order.ts:356:      oldBoardRevision: current.boardRevision, expectedTarget: plan.expectedTarget.map((row) => ({ ...row, newBoardPosition: row.newBoardPosition! })),
portal/workers/app/src/lib/project-board-order.ts:358:      auditId, actorId: principal.id, auditAction: "project.board_position_set", auditMetaJson: auditMeta(principal, {} ) ?? "{}", now,
portal/workers/app/src/lib/project-board-order.ts:362:      oldBoardRevision: current.boardRevision, expectedTarget: plan.expectedTarget, placement: plan.placement,
portal/workers/app/src/lib/project-board-order.ts:363:      exactBoardPosition: plan.boardPosition, auditId, actorId: principal.id,
portal/workers/app/src/lib/project-board-order.ts:364:      auditAction: "project.board_position_set", auditMetaJson: auditMeta(principal, {}) ?? "{}", now,
portal/workers/app/test/project-board-order.test.ts:4:const row = (id: string, boardPosition: number, priority: number | null = null): BoardProjectRow => ({
portal/workers/app/test/project-board-order.test.ts:5:  id, stageKey: "raw_review", priority, boardPosition, boardRevision: 0,
portal/workers/app/test/project-board-order.test.ts:18:        expected: { stageKey: "raw_review", boardRevision: 0 },
portal/workers/app/test/project-board-order.test.ts:20:        placement: { kind: "between", before: null, after: { projectId: after.id, boardRevision: 0 } },
portal/workers/app/test/project-board-order.test.ts:34:        expected: { stageKey: "raw_review", boardRevision: 0 },
portal/workers/app/test/project-board-order.test.ts:45:        expected: { stageKey: "raw_review", boardRevision: 0 },
portal/workers/app/test/project-deadline.test.ts:66:      database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Deadline API Street', 'edited_review', 0, ?, ?)").bind(projectId, now, now),
portal/workers/app/test/project-deadline.test.ts:344:      expected: { stageKey: "editing_autohdr", boardRevision: 0 },
portal/workers/app/test/project-deadline.test.ts:355:    expect(await database.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ?").bind(projectIdForRace).first()).toEqual({ stageKey: "editing_autohdr", boardRevision: 0 });
portal/workers/app/test/project-deadline.test.ts:359:    expect(await database.DB.prepare("SELECT stage_key AS stageKey, board_revision AS boardRevision FROM projects WHERE id = ?").bind(projectIdForRace).first()).toEqual({ stageKey: "delivered", boardRevision: 1 });
portal/packages/shared/test/external-project-policy.test.ts:47:      boardRevision: 0,
portal/packages/shared/test/external-project-policy.test.ts:63:      boardRevision: 4,
portal/packages/shared/test/external-project-policy.test.ts:78:    for (const field of ["priority", "boardPosition", "hiddenProjectIds", "hiddenCount"] as const) {
portal/packages/shared/test/stage-move.test.ts:21:  expected: { stageKey: "raw_review", boardRevision: 2 },
portal/packages/shared/test/stage-move.test.ts:25:    before: { projectId: beforeProjectId, boardRevision: 4 },
portal/packages/shared/test/stage-move.test.ts:26:    after: { projectId: afterProjectId, boardRevision: 7 },
portal/packages/shared/test/stage-move.test.ts:82:    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, expected: { ...validRequest.expected, boardRevision: -1 } }).success).toBe(false);
portal/packages/shared/test/stage-move.test.ts:83:    expect(moveProjectStageRequestSchema.safeParse({ ...validRequest, expected: { ...validRequest.expected, boardRevision: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
portal/packages/shared/test/stage-move.test.ts:92:      placement: { ...validRequest.placement, before: { projectId: targetProjectId, boardRevision: 1 } },
portal/packages/shared/test/stage-move.test.ts:100:      project: { projectId: targetProjectId, stageKey: "editing", boardRevision: 3 },
portal/workers/background/src/tonomo/process.ts:110:    stageKey: "awaiting_raw", boardPosition: appendToStageBottomExpr("awaiting_raw", id), boardRevision: 0, createdAt: now, updatedAt: now,
portal/workers/background/src/lib/automatic-stage.ts:39:    "SELECT board_revision AS boardRevision FROM projects WHERE id = ? AND stage_key = ? AND archived_at IS NULL",
portal/workers/background/src/lib/automatic-stage.ts:40:  ).bind(projectId, sourceStageKey).first<{ boardRevision: number }>();
portal/workers/background/src/lib/automatic-stage.ts:43:    "SELECT id AS projectId, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE stage_key = ? AND archived_at IS NULL AND id <> ? ORDER BY board_position, id",
portal/workers/background/src/lib/automatic-stage.ts:45:  return { oldBoardRevision: Number(source.boardRevision), expectedTarget: target.results };
portal/workers/background/src/lib/automatic-stage.ts:59:  expected: { projectId: string; stageKey: StageKey; boardRevision: number },
portal/workers/background/src/lib/automatic-stage.ts:64:  const boardPosition = typeof row.board_position === "number" ? row.board_position : Number(row.board_position);
portal/workers/background/src/lib/automatic-stage.ts:65:  const boardRevision = typeof row.board_revision === "number" ? row.board_revision : Number(row.board_revision);
portal/workers/background/src/lib/automatic-stage.ts:66:  if (!Number.isFinite(boardPosition) || !Number.isInteger(boardRevision) || boardRevision !== expected.boardRevision) return null;
portal/workers/background/src/lib/automatic-stage.ts:69:    row: { projectId: row.id, stageKey: row.stage_key as StageKey, boardPosition, boardRevision },
portal/workers/background/src/lib/automatic-stage.ts:100:    const tokenRevision = token?.editing_entry_board_revision ?? token?.stage_entry_board_revision;
portal/workers/background/src/lib/automatic-stage.ts:106:    return typeof source?.stage_entry_board_revision === "number"
portal/workers/background/src/lib/automatic-stage.ts:107:      && source.stage_entry_board_revision === stageRevision;
portal/workers/background/src/lib/automatic-stage.ts:172:    boardRevision: oldBoardRevision + 1,
portal/workers/background/src/lib/automatic-stage.ts:176:  if (!marker || marker.id !== input.auditId || !workflowTailAgrees(results, input.workflow.kind, offsetWorkflowIndexes(bundle.indexes.workflow, offset), winner.row.boardRevision)) {
portal/workers/background/src/lib/automatic-stage.ts:210:    "SELECT stage_entry_board_revision AS stageEntryBoardRevision FROM jobs WHERE id = ? AND project_id = ? AND kind = ? AND json_valid(payload_json) AND CAST(json_extract(payload_json, '$.projectId') AS TEXT) = ? AND json_extract(payload_json, '$.stageEntrySourceJobId') = id AND CAST(COALESCE(json_extract(payload_json, '$.stageEntryGeneration'), json_extract(payload_json, '$.generation')) AS INTEGER) = ? AND stage_entry_board_revision IS NOT NULL",
portal/apps/web/src/screens/dashboard-routing.test.ts:9:  receivedCount: 0, expectedCount: null, priority: null, boardPosition: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
portal/apps/web/src/screens/dashboard-routing.test.ts:10:  boardRevision: 0,
portal/apps/web/src/screens/dashboard-routing.test.ts:23:			{ ...project, id: "b", boardPosition: 10, authorizedBoardOrder: { awaiting_raw: ["a", "b", "c"] } },
portal/apps/web/src/screens/dashboard-routing.test.ts:24:			{ ...project, id: "c", boardPosition: 10, authorizedBoardOrder: { awaiting_raw: ["a", "b", "c"] } },
portal/apps/web/src/screens/dashboard-routing.test.ts:25:			{ ...project, id: "a", boardPosition: 2, authorizedBoardOrder: { awaiting_raw: ["a", "b", "c"] } },
portal/apps/web/src/screens/dashboard-routing.test.ts:51:      { ...project, id: "null-date", street: "Null Street", shootDate: null, boardPosition: 0 },
portal/apps/web/src/screens/dashboard-routing.test.ts:52:      { ...project, id: "late", street: "Late Street", shootDate: "2026-03-01", boardPosition: 1 },
portal/apps/web/src/screens/dashboard-routing.test.ts:53:      { ...project, id: "invalid-date", street: "Invalid Street", shootDate: "tomorrow", boardPosition: 2 },
portal/apps/web/src/screens/dashboard-routing.test.ts:54:      { ...project, id: "early", street: "Early Street", shootDate: "2026-01-01", boardPosition: 3 },
portal/apps/web/src/screens/dashboard-routing.test.ts:72:      { ...project, id: "priority-first", priority: 1, boardPosition: 0, shootDate: "2026-03-01" },
portal/apps/web/src/screens/dashboard-routing.test.ts:73:      { ...project, id: "unprioritized-earlier", priority: null, boardPosition: 50, shootDate: "2026-01-01" },
portal/workers/background/test/autohdr-versioning.test.ts:61:  await bindings.DB.prepare("UPDATE autohdr_handoffs SET editing_entry_board_revision = 0 WHERE id = ?")
portal/workers/background/test/raw-stage.test.ts:39:    const row = await database.DB.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = ?").bind(projectId).first();
portal/workers/background/test/raw-stage.test.ts:40:    expect(row).toMatchObject({ stage_key: "raw_review", board_revision: 1 });
```

### A4

```text
$ rg -n 'priorityInsertNeighbors|manualInsertNeighbors|renumberedInsertPosition|priority.*board_position|priority.*boardPosition' portal -g '*.ts'
portal/apps/web/src/screens/dashboard-routing.test.ts:9:  receivedCount: 0, expectedCount: null, priority: null, boardPosition: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
portal/apps/web/src/screens/dashboard-routing.test.ts:72:      { ...project, id: "priority-first", priority: 1, boardPosition: 0, shootDate: "2026-03-01" },
portal/apps/web/src/screens/dashboard-routing.test.ts:73:      { ...project, id: "unprioritized-earlier", priority: null, boardPosition: 50, shootDate: "2026-01-01" },
portal/workers/app/test/kanban-ordering.integration.test.ts:39:  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, board_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
portal/workers/app/test/kanban-ordering.integration.test.ts:40:    .bind(id, id, stageKey, priority, boardPosition, now, now).run();
portal/workers/app/test/kanban-ordering.integration.test.ts:62:    expect(await database.DB.prepare("SELECT priority, board_position, board_revision FROM projects WHERE id = ?").bind(target).first()).toEqual({ priority: 2, board_position: 4096, board_revision: 0 });
portal/workers/app/src/lib/project-board-order.ts:118:    SELECT id, stage_key AS stageKey, priority, board_position AS boardPosition,
portal/workers/app/src/lib/project-board-order.ts:126:    SELECT id, stage_key AS stageKey, priority, board_position AS boardPosition,
portal/workers/app/src/lib/external-project-query.ts:150:    rows.sort((left, right) => (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0) || left.boardPosition - right.boardPosition || left.id.localeCompare(right.id));
portal/workers/app/test/project-board-order.test.ts:5:  id, stageKey: "raw_review", priority, boardPosition, boardRevision: 0,
portal/packages/db/test/tb5a-migration-proof.test.ts:47:  return db.prepare("SELECT id, stage_key, priority, board_position, board_revision, archived_at FROM projects WHERE stage_key = ? AND archived_at IS NULL ORDER BY board_position, id").all(stageKey) as SqliteRow[];
portal/packages/db/test/tb5a-migration-proof.test.ts:99:        { id: "a-tie-a", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/tb5a-migration-proof.test.ts:100:        { id: "a-tie-b", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/tb5a-migration-proof.test.ts:101:        { id: "a-fraction", stageKey: "awaiting_raw", priority: 1, boardPosition: 4.5 },
portal/packages/db/test/tb5a-migration-proof.test.ts:102:        { id: "a-null", stageKey: "awaiting_raw", priority: null, boardPosition: -100 },
portal/packages/db/test/tb5a-migration-proof.test.ts:103:        { id: "b-priority", stageKey: "raw_review", priority: 1, boardPosition: 9 },
portal/packages/db/test/tb5a-migration-proof.test.ts:104:        { id: "inactive-occupant", stageKey: "edited_review", priority: 1, boardPosition: 99 },
portal/packages/db/test/tb5a-migration-proof.test.ts:105:        { id: "delivered-project", stageKey: "delivered", priority: null, boardPosition: 7 },
portal/packages/db/test/tb5a-migration-proof.test.ts:106:        { id: "archived-project", stageKey: "awaiting_raw", priority: 1, boardPosition: 123.25, archivedAt: FIXTURE_NOW + 1 },
portal/packages/db/test/tb5a-migration-proof.test.ts:107:        { id: "archived-noncanonical", stageKey: "legacy_archived", priority: null, boardPosition: 987.5, archivedAt: FIXTURE_NOW + 2 },
portal/packages/db/test/tb5a-migration-proof.test.ts:110:      const archivedBefore = db.prepare("SELECT id, stage_key, priority, board_position, archived_at FROM projects WHERE archived_at IS NOT NULL ORDER BY id").all();
portal/packages/db/test/tb5a-migration-proof.test.ts:120:      expect(db.prepare("SELECT id, stage_key, priority, board_position, archived_at FROM projects WHERE archived_at IS NOT NULL ORDER BY id").all()).toEqual(archivedBefore);
portal/packages/db/test/tb5a-migration-proof.test.ts:184:          { id: "valid-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 },
portal/packages/db/test/tb5a-migration-proof.test.ts:185:          { id: "valid-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 },
portal/packages/db/test/tb5a-migration-proof.test.ts:195:        const before = db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all();
portal/packages/db/test/tb5a-migration-proof.test.ts:201:        expect(db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all()).toEqual(before);
portal/packages/db/test/tb5a-migration-proof.test.ts:216:        { id: "rollback-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 },
portal/packages/db/test/tb5a-migration-proof.test.ts:217:        { id: "rollback-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 },
portal/packages/db/test/tb5a-migration-proof.test.ts:219:      const original = db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all();
portal/packages/db/test/tb5a-migration-proof.test.ts:224:      expect(db.prepare("SELECT id, stage_key, priority, board_position FROM projects ORDER BY id").all()).toEqual(original);
portal/packages/db/test/tb5a-migration-proof.test.ts:233:        seedLegacyProject(drifted, { id: "drift-a", stageKey: "awaiting_raw", priority: 1, boardPosition: 20 });
portal/packages/db/test/tb5a-migration-proof.test.ts:234:        seedLegacyProject(drifted, { id: "drift-b", stageKey: "awaiting_raw", priority: 2, boardPosition: 10 });
portal/packages/shared/test/external-project-policy.test.ts:78:    for (const field of ["priority", "boardPosition", "hiddenProjectIds", "hiddenCount"] as const) {
portal/workers/app/src/routes/projects.ts:204:function authorizedInternalBoardOrder(rows: Array<{ project: { id: string; stageKey: string; priority: number | null; boardPosition: number } }>, role: Role): Partial<Record<StageTransportKey, string[]>> {
portal/workers/app/src/routes/projects.ts:205:  const groups = new Map<StageTransportKey, Array<{ id: string; priority: number | null; boardPosition: number }>>();
portal/workers/app/src/routes/projects.ts:214:    group.sort((left, right) => (left.priority === null ? 1 : 0) - (right.priority === null ? 1 : 0) || left.boardPosition - right.boardPosition || left.id.localeCompare(right.id));
portal/workers/app/src/routes/projects.ts:247:    stageKey: "awaiting_raw", priority: null, boardPosition: 0, boardRevision: 0, orderNo: data.orderNo ?? null, orderId: data.orderId ?? null,
portal/workers/app/src/routes/projects.ts:410:    SELECT id, stage_key AS stageKey, priority, board_position AS boardPosition, board_revision AS boardRevision
portal/workers/app/src/routes/projects.ts:412:  `).bind(id).first<{ id: string; stageKey: StageKey; priority: number | null; boardPosition: number; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:430:  `).bind(data.priority, now, id, target.stageKey, target.boardPosition, target.boardRevision);
portal/workers/app/src/routes/projects.ts:438:    const current = await c.env.DB.prepare("SELECT priority, stage_key AS stageKey, board_position AS boardPosition, board_revision AS boardRevision FROM projects WHERE id = ? AND archived_at IS NULL").bind(id).first<{ priority: number | null; stageKey: StageKey; boardPosition: number; boardRevision: number }>();
portal/workers/app/src/routes/projects.ts:439:    if (current && current.priority === data.priority && current.stageKey === target.stageKey && current.boardPosition === target.boardPosition && current.boardRevision === target.boardRevision) return c.json({ priority: current.priority, boardRevision: current.boardRevision });
portal/packages/db/test/dashboard-order.characterization.test.ts:41:      sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, shoot_date TEXT, priority INTEGER, board_position REAL NOT NULL)");
portal/packages/db/test/dashboard-order.characterization.test.ts:42:      sqlite.exec("INSERT INTO projects (id, shoot_date, priority, board_position) VALUES ('null-priority', '2026-07-22', NULL, 4096), ('priority-midpoint', '2026-07-21', 2, 1536), ('priority-tie', '2026-07-20', 1, 1536), ('no-date', NULL, NULL, 0)");
portal/packages/db/test/migration-0037.test.ts:119:  { id: "a-tie-1", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/migration-0037.test.ts:120:  { id: "a-tie-2", stageKey: "awaiting_raw", priority: 5, boardPosition: 4 },
portal/packages/db/test/migration-0037.test.ts:121:  { id: "a-fraction", stageKey: "awaiting_raw", priority: 1, boardPosition: 4.5 },
portal/packages/db/test/migration-0037.test.ts:122:  { id: "a-null", stageKey: "awaiting_raw", priority: null, boardPosition: 8 },
portal/packages/db/test/migration-0037.test.ts:123:  { id: "b-priority-10", stageKey: "raw_review", priority: 10, boardPosition: 2 },
portal/packages/db/test/migration-0037.test.ts:124:  { id: "b-priority-5", stageKey: "raw_review", priority: 5, boardPosition: 2 },
portal/packages/db/test/migration-0037.test.ts:125:  { id: "b-null", stageKey: "raw_review", priority: null, boardPosition: -100 },
portal/packages/db/test/migration-0037.test.ts:126:  { id: "inactive-stage", stageKey: "edited_review", priority: 5, boardPosition: 99 },
portal/packages/db/test/migration-0037.test.ts:127:  { id: "delivered-project", stageKey: "delivered", priority: null, boardPosition: 7 },
portal/packages/db/test/migration-0037.test.ts:128:  { id: "archived-project", stageKey: "awaiting_raw", priority: 1, boardPosition: 123.25, archivedAt: FIXTURE_NOW + 1 },
portal/packages/db/test/migration-0037.test.ts:129:  { id: "archived-noncanonical", stageKey: "legacy_archived", priority: null, boardPosition: 987.5, archivedAt: FIXTURE_NOW + 2 },
portal/packages/db/test/migration-0037.test.ts:137:  const insert = db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
portal/packages/db/test/migration-0037.test.ts:139:    insert.run(project.id, `${project.id} Street`, project.stageKey, project.priority, project.boardPosition, project.archivedAt ?? null, FIXTURE_NOW, FIXTURE_NOW);
portal/packages/db/test/migration-0037.test.ts:144:  return db.prepare("SELECT id, stage_key, priority, board_position, archived_at FROM projects ORDER BY id").all() as SqliteRow[];
portal/packages/db/test/migration-0037.test.ts:257:    const after = db.prepare("SELECT id, stage_key, priority, board_position, board_revision, archived_at FROM projects ORDER BY id").all() as SqliteRow[];
portal/packages/db/test/migration-0037.test.ts:288:      seedProjects(db, [{ id: "invalid-stage", stageKey: "not_a_stage", priority: 1, boardPosition: 42 }]);
portal/packages/db/test/tb5a-proof-support.ts:147:  db.prepare("INSERT INTO projects (id, street, stage_key, priority, board_position, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
portal/packages/db/test/tb5a-proof-support.ts:148:    .run(project.id, `${project.id} Street`, project.stageKey, project.priority ?? null, project.boardPosition ?? 0, project.archivedAt ?? null, FIXTURE_NOW, FIXTURE_NOW);
portal/packages/db/test/tb5a-proof-support.ts:152:  db.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, priority, board_position, board_revision, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
portal/packages/db/test/tb5a-proof-support.ts:153:    .run(project.id, `${project.id} Street`, project.shootDate ?? null, project.stageKey, project.priority ?? null, project.boardPosition ?? 0, project.boardRevision ?? 0, project.archivedAt ?? null, FIXTURE_NOW, FIXTURE_NOW);
```

### A5

```text
$ rg -n 'project\.stage\.changed|notifyProject\(.*delivered|notifyProject\(.*sent_to_editing|project\.priority\.changed' portal -g '*.ts'
portal/packages/db/test/migration-0034.test.ts:51:    const valid = ["activity-1", 1, "project.priority.changed", "priority", "tb4c-project", "user", "tb4c-existing-user", now, "project_priority", "tb4c-project", "project-priority:tb4c-project:change:activity", '{"priority":3}', "project", "/projects/tb4c-project", now];
portal/packages/db/test/migration-0034.test.ts:58:    expect(() => db.prepare("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES ('duplicate-source', 1, 'project.priority.changed', 'priority', 'tb4c-project', 'user', 'tb4c-existing-user', ?, 'project_priority', 'tb4c-project', 'project-priority:tb4c-project:change:activity', '{\"priority\":3}', 'project', '/projects/tb4c-project', ?)").run(now, now)).toThrow();
portal/packages/db/test/migration-0034.test.ts:69:    const dedupe = planDetails(db, "SELECT id FROM project_activity_events WHERE event_type = ? AND source_key = ?", "project.priority.changed", "source");
portal/packages/shared/src/project-activity.ts:18:  "project.priority.changed",
portal/packages/shared/src/project-activity.ts:35:  "project.stage.changed",
portal/packages/shared/src/project-activity.ts:77:  "project.priority.changed": z.object({ priority: z.number().int().min(1).max(10).nullable() }).strict(),
portal/packages/shared/src/project-activity.ts:95:  "project.stage.changed": emptyPayload,
portal/packages/shared/src/project-activity.ts:166:  "project.priority.changed": live("priority", "project priority route", ["workers/app/src/routes/projects.ts#priority"], "project_priority", "project-priority:<projectId>:change:<activityId>", "project", payloadSchemas["project.priority.changed"]),
portal/packages/shared/src/project-activity.ts:183:  "project.stage.changed": live("stage", "moveProjectStage", ["workers/app/src/lib/project-stage.ts#moveProjectStage"], "project_stage", "project-stage:<projectId>:transition:<activityId>", "project", payloadSchemas["project.stage.changed"]),
portal/packages/shared/src/project-activity.ts:252:    case "project.priority.changed": return oneToken("project-priority:", ":change:");
portal/packages/shared/src/project-activity.ts:274:    case "project.stage.changed": return projectId !== undefined && key === `project-stage:${projectId}:transition:${sourceId}`;
portal/packages/shared/src/project-activity.ts:415:    case "project.priority.changed": return { title: "Project priority changed", body: `${actor}${projectLabel} priority changed.` };
portal/packages/shared/src/project-activity.ts:433:    case "project.stage.changed":
portal/packages/shared/src/external-project-policy.ts:32:  "project.priority.changed": suppressed("priority_withheld"),
portal/packages/shared/src/external-project-policy.ts:50:  "project.stage.changed": allowed("safe_activity"),
portal/packages/shared/src/external-notification.ts:78:  "project.priority.changed": null,
portal/packages/shared/src/external-notification.ts:96:  "project.stage.changed": { title: "Project stage updated", body: "The assigned project stage was updated." },
portal/packages/shared/src/external-notification.ts:115:  "project.priority.changed": [], "project.details.changed": ["in_app"], "project.archived": [], "project.restored": [],
portal/packages/shared/src/external-notification.ts:121:  "project.collection.raw_sync_completed": ["in_app"], "project.checklist.schedule_changed": ["in_app"], "project.stage.changed": ["in_app"],
portal/packages/db/src/stage-board-bundles.ts:718:  const activityType: ProjectActivityType = "project.stage.changed";
portal/packages/shared/test/project-activity.test.ts:26:    "project.priority.changed": `project-priority:${sourceId}:change:activity`,
portal/packages/shared/test/project-activity.test.ts:43:    "project.stage.changed": `project-stage:${projectId}:transition:${sourceId}`,
portal/packages/shared/test/project-activity.test.ts:58:    "project.priority.changed": { priority: 3 },
portal/packages/shared/test/project-activity.test.ts:75:    "project.stage.changed": {},
portal/packages/shared/test/project-activity.test.ts:86:  const sourceId = type.startsWith("project.") && ["project.archived", "project.restored", "project.priority.changed", "project.details.changed", "project.deadline.schedule_changed"].includes(type)
portal/packages/shared/test/project-activity.test.ts:103:    const entry = PROJECT_ACTIVITY_REGISTRY["project.stage.changed"];
portal/packages/shared/test/project-activity.test.ts:117:    expect(renderProjectActivityNotification("project.stage.changed", {}, "Maple House")).toEqual({ title: "Project activity", body: "Maple House has a project update." });
portal/packages/shared/test/project-activity.test.ts:118:    expect(projectExternalActivityPayload("project.stage.changed", {})).toEqual({ type: "project.stage.changed", payload: {} });
portal/packages/shared/test/project-activity.test.ts:149:    expect(projectActivityDeepLink("project.priority.changed", projectId)).toEqual({ kind: "project", path: `/projects/${projectId}` });
portal/packages/shared/test/project-activity.test.ts:160:    expect(parseProjectActivityIntent({ ...intentFor("project.priority.changed"), activity: { ...intentFor("project.priority.changed").activity, safePayload: { priority: 1, checklistTitle: "not allowed" } } })).toBeNull();
portal/packages/shared/test/project-activity.test.ts:170:    expect(parseProjectActivityIntent(intentFor("project.priority.changed", { actorId: PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID }))).toBeNull();
portal/packages/shared/test/project-activity.test.ts:221:    const intent = intentFor("project.priority.changed");
portal/packages/db/test/project-activity.test.ts:43:function intent(type: "project.priority.changed" | "project.comment.edited", id: string, occurredAt: number, auditId: string): ProjectActivityIntent {
portal/packages/db/test/project-activity.test.ts:91:    const bundle = buildProjectActivityStatements({ db: localD1(db), intent: intent("project.priority.changed", "tb4d-activity", now, "tb4d-audit"), winnerAuditId: "tb4d-audit", createdAt: now, broadMode: "activity_only" });
portal/packages/db/test/project-activity.test.ts:112:    const first = buildProjectActivityStatements({ db: d1, intent: intent("project.priority.changed", "priority-activity", now, "winning-audit") , winnerAuditId: "winning-audit", createdAt: now });
portal/packages/shared/test/external-project-policy.test.ts:19:    expect(externalProjectActivityAudience("project.priority.changed")).toBe("internal");
portal/packages/shared/test/external-project-policy.test.ts:32:    expect(externalNotificationCopy({ type: "project.priority.changed" })).toBeNull();
portal/packages/shared/test/external-project-policy.test.ts:33:    expect(externalNotificationChannels("project.priority.changed")).toEqual([]);
portal/workers/app/src/routes/projects.ts:419:    activity: { id: activityId, type: "project.priority.changed", projectId: id, actorId: c.get("user").id, occurredAt: now, source: { kind: "project_priority", id, key: `project-priority:${id}:change:${activityId}` }, safePayload: { priority: data.priority }, deepLink: projectActivityDeepLink("project.priority.changed", id) },
portal/workers/app/src/routes/projects.ts:420:    broadDelivery: { registryKey: "project.priority.changed", sourceActivityId: activityId, coalesce: null },
portal/workers/background/src/workflows/autohdr-api-send.ts:187:          await notifyProject(this.env, input.projectId, "sent_to_editing");
portal/workers/background/src/workflows/autohdr.ts:316:              await notifyProject(this.env, input.projectId, "sent_to_editing");
portal/workers/background/src/autohdr/claims.ts:154:      await notifyProject(env, input.projectId, "sent_to_editing");
portal/workers/background/src/autohdr/claims.ts:695:        await notifyProject(env, projectId, "sent_to_editing");
portal/workers/background/src/autohdr/claims.ts:960:      await notifyProject(env, projectId, "sent_to_editing");
portal/workers/background/test/notification-delivery.integration.test.ts:302:    // project.stage.changed became a live type in TB5A Slice 1; project.workflow.raw_ready is still reserved.
portal/workers/app/test/kanban-ordering.integration.test.ts:86:    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.stage.changed'").bind(target).first()).toEqual({ count: 1 });
```

### A6

```text
$ rg -n -U '\.select\(\)\s*\.from\((schema\.)?projects\)' portal/workers -g '*.ts'
(no matches)```

### A7

```text
$ rg -n 'admin\.board_position_backfill|backfill-board-position' portal -g '*.ts'
(no matches)```

### A8

```text
$ rg -n 'project_board_order_0037|_tb5a_0037|projects_stage_archive_board_order_idx' portal/packages/db/src/schema.ts portal/packages/db/migrations/meta/0037_snapshot.json
(no matches)```


## Verification command output

The available baseline before Slice 8 was DB 22 files / 94 tests, web 18 files / 115 Node tests
plus 33 files / 318 DOM tests, shared 16 files / 99 tests, and webhook 1 file / 13 tests. Worker
suites were not collected in this managed sandbox because Wrangler/Miniflare cannot write the
user Wrangler log or listen on `127.0.0.1).

After Slice 8: DB 24 files / 101 tests, web 18 / 115 Node plus 33 / 318 DOM, shared 16 / 99, and
webhook 1 / 13. The two new DB files add seven tests total. Worker suites remain uncollected for
the same sandbox restriction.

### typecheck — exit 0

```text
$ cd portal && npm run typecheck

> typecheck
> npm run typecheck --workspaces --if-present


> typecheck
> tsc -p tsconfig.json


> typecheck
> tsc -p tsconfig.json


> typecheck
> tsc -p tsconfig.json


> typecheck
> tsc -p tsconfig.json


> typecheck
> tsc -p tsconfig.json


> typecheck
> tsc -p tsconfig.json

```

### build — exit 0

```text
$ cd portal && npm run build -w @quincy/web

> build
> tsc -p tsconfig.json && vite build

vite v8.1.5 building client environment for production...
transforming...✓ 383 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                     0.40 kB │ gzip:   0.27 kB
dist/assets/index-DsD_qghF.css    124.08 kB │ gzip:  21.55 kB
dist/assets/index-CEQpD1MM.js   1,177.44 kB │ gzip: 351.41 kB

[plugin builtin:vite-reporter] 
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 552ms
```

### worker-app — exit 1

```text
$ cd portal && npm test -w @quincy/worker-app

> test
> vitest run --config vitest.config.ts


 RUN  v4.1.10 /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/workers/app

Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
✘ [ERROR] Failed to write to log file Error: EPERM: operation not permitted, open '/Users/tingruilee/.wrangler/logs/wrangler-2026-08-29_00-39-17_052.log'

      at open (node:internal/fs/promises:1281:25)
      at writeFile (node:internal/fs/promises:1899:14)
      at /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/node_modules/wrangler/wrangler-dist/cli.js:59866:7
      at Mutex.runWith (/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/node_modules/miniflare/dist/src/index.js:71860:48)
      at appendToDebugLogFile (/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/node_modules/wrangler/wrangler-dist/cli.js:59863:3) {
    errno: -1,
    code: 'EPERM',
    syscall: 'open',
    path: '/Users/tingruilee/.wrangler/logs/wrangler-2026-08-29_00-39-17_052.log'
  }


✘ [ERROR] Would have written: 

  --- 2026-08-29T00:39:17.462Z debug
  🪵  Writing logs to "/Users/tingruilee/.wrangler/logs/wrangler-2026-08-29_00-39-17_052.log"
  ---
  


🪵  Logs were written to "/Users/tingruilee/.wrangler/logs/wrangler-2026-08-29_00-39-17_052.log"
node:events:487
      throw er; // Unhandled 'error' event
      ^

Error: listen EPERM: operation not permitted 127.0.0.1
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at node:net:2274:7
    at processTicksAndRejections (node:internal/process/task_queues:90:21)
Emitted 'error' event on Server instance at:
    at emitErrorNT (node:net:2044:8)
    at processTicksAndRejections (node:internal/process/task_queues:90:21) {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '127.0.0.1'
}

Node.js v25.9.0
npm error Lifecycle script `test` failed with error:
npm error code 1
npm error path /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/workers/app
npm error workspace @quincy/worker-app
npm error location /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/workers/app
npm error command failed
npm error command sh -c vitest run --config vitest.config.ts
```

### worker-background — exit 1

```text
$ cd portal && npm test -w @quincy/worker-background

> test
> vitest run --config vitest.config.ts


 RUN  v4.1.10 /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/workers/background

Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
Using secrets defined in .dev.vars
node:events:487
      throw er; // Unhandled 'error' event
      ^

Error: listen EPERM: operation not permitted 127.0.0.1
    at Server.setupListenHandle [as _listen2] (node:net:1986:21)
    at listenInCluster (node:net:2065:12)
    at node:net:2274:7
    at processTicksAndRejections (node:internal/process/task_queues:90:21)
Emitted 'error' event on Server instance at:
    at emitErrorNT (node:net:2044:8)
    at processTicksAndRejections (node:internal/process/task_queues:90:21) {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '127.0.0.1'
}

Node.js v25.9.0
npm error Lifecycle script `test` failed with error:
npm error code 1
npm error path /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/workers/background
npm error workspace @quincy/worker-background
npm error location /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/workers/background
npm error command failed
npm error command sh -c vitest run --config vitest.config.ts
```

### db — exit 0

```text
$ cd portal && npm test -w @quincy/db

> test
> vitest run --config vitest.config.ts


 RUN  v4.1.10 /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/packages/db


 Test Files  24 passed (24)
      Tests  101 passed (101)
   Start at  08:39:15
   Duration  3.42s (transform 4.98s, setup 0ms, import 13.98s, tests 5.89s, environment 61ms)

```

### web — exit 0

```text
$ cd portal && npm test -w @quincy/web

> test
> vitest run --config vitest.config.ts && vitest run --config vitest.dom.config.ts


 RUN  v4.1.10 /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/apps/web


 Test Files  18 passed (18)
      Tests  115 passed (115)
   Start at  08:39:15
   Duration  2.28s (transform 9.60s, setup 0ms, import 15.39s, tests 179ms, environment 12ms)


 RUN  v4.1.10 /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/apps/web

AggregateError: 
    at internalConnectMultiple (node:net:1193:18)
    at internalConnectMultiple (node:net:1269:5)
    at internalConnectMultiple (node:net:1269:5)
    at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
    at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
  code: 'EPERM',
  [errors]: [
    Error: connect EPERM ::1:3000 - Local (:::0)
        at internalConnectMultiple (node:net:1265:16)
        at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
        at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
        at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
      errno: -1,
      code: 'EPERM',
      syscall: 'connect',
      address: '::1',
      port: 3000
    },
    Error: connect EPERM 127.0.0.1:3000 - Local (0.0.0.0:0)
        at internalConnectMultiple (node:net:1265:16)
        at internalConnectMultiple (node:net:1269:5)
        at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
        at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
        at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
      errno: -1,
      code: 'EPERM',
      syscall: 'connect',
      address: '127.0.0.1',
      port: 3000
    }
  ]
}
(node:61181) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
AggregateError: 
    at internalConnectMultiple (node:net:1193:18)
    at internalConnectMultiple (node:net:1269:5)
    at internalConnectMultiple (node:net:1269:5)
    at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
    at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
  code: 'EPERM',
  [errors]: [
    Error: connect EPERM ::1:3000 - Local (:::0)
        at internalConnectMultiple (node:net:1265:16)
        at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
        at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
        at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
      errno: -1,
      code: 'EPERM',
      syscall: 'connect',
      address: '::1',
      port: 3000
    },
    Error: connect EPERM 127.0.0.1:3000 - Local (0.0.0.0:0)
        at internalConnectMultiple (node:net:1265:16)
        at internalConnectMultiple (node:net:1269:5)
        at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
        at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
        at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
      errno: -1,
      code: 'EPERM',
      syscall: 'connect',
      address: '127.0.0.1',
      port: 3000
    }
  ]
}
AggregateError: 
    at internalConnectMultiple (node:net:1193:18)
    at internalConnectMultiple (node:net:1269:5)
    at internalConnectMultiple (node:net:1269:5)
    at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
    at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
  code: 'EPERM',
  [errors]: [
    Error: connect EPERM ::1:3000 - Local (:::0)
        at internalConnectMultiple (node:net:1265:16)
        at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
        at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
        at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
      errno: -1,
      code: 'EPERM',
      syscall: 'connect',
      address: '::1',
      port: 3000
    },
    Error: connect EPERM 127.0.0.1:3000 - Local (0.0.0.0:0)
        at internalConnectMultiple (node:net:1265:16)
        at internalConnectMultiple (node:net:1269:5)
        at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
        at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
        at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
      errno: -1,
      code: 'EPERM',
      syscall: 'connect',
      address: '127.0.0.1',
      port: 3000
    }
  ]
}
AggregateError: 
    at internalConnectMultiple (node:net:1193:18)
    at internalConnectMultiple (node:net:1269:5)
    at internalConnectMultiple (node:net:1269:5)
    at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
    at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
  code: 'EPERM',
  [errors]: [
    Error: connect EPERM ::1:3000 - Local (:::0)
        at internalConnectMultiple (node:net:1265:16)
        at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
        at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
        at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
      errno: -1,
      code: 'EPERM',
      syscall: 'connect',
      address: '::1',
      port: 3000
    },
    Error: connect EPERM 127.0.0.1:3000 - Local (0.0.0.0:0)
        at internalConnectMultiple (node:net:1265:16)
        at internalConnectMultiple (node:net:1269:5)
        at defaultTriggerAsyncIdScope (node:internal/async_hooks:473:12)
        at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1611:7)
        at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:133:8) {
      errno: -1,
      code: 'EPERM',
      syscall: 'connect',
      address: '127.0.0.1',
      port: 3000
    }
  ]
}
(node:61262) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  33 passed (33)
      Tests  318 passed (318)
   Start at  08:39:18
   Duration  4.67s (transform 5.02s, setup 0ms, import 10.29s, tests 11.61s, environment 7.62s)

```

### shared — exit 0

```text
$ cd portal && npx vitest run --config packages/shared/vitest.config.ts

 RUN  v4.1.10 /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/packages/shared


 Test Files  16 passed (16)
      Tests  99 passed (99)
   Start at  08:39:16
   Duration  9.06s (transform 3.32s, setup 0ms, import 4.58s, tests 8.94s, environment 1ms)

```

### webhook — exit 0

```text
$ cd portal && npm test -w @quincy/worker-webhook-ingress

> test
> vitest run


 RUN  v4.1.10 /Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/workers/webhook-ingress


 Test Files  1 passed (1)
      Tests  13 passed (13)
   Start at  08:39:15
   Duration  905ms (transform 105ms, setup 0ms, import 200ms, tests 241ms, environment 0ms)

```


The exact `npm run test --workspaces` wrapper was also run. It reports the known
`@quincy/shared` “Missing script: test” condition, then continues through the workspaces; the
individual DB, web, shared, webhook, app, and background commands above are the authoritative
gate records. Shared was explicitly run with its Vitest config because the workspace wrapper
does not cover it.

### generate (first) — exit 0

```text

> generate
> drizzle-kit generate

No config path provided, using default 'drizzle.config.ts'
Reading config file '/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/packages/db/drizzle.config.ts'
54 tables
account 13 columns 1 indexes 1 fks
agencies 5 columns 0 indexes 0 fks
agents 7 columns 1 indexes 1 fks
annotations 10 columns 1 indexes 2 fks
asset_ingest_identities 5 columns 2 indexes 2 fks
asset_renditions 10 columns 2 indexes 1 fks
asset_review_state 8 columns 1 indexes 2 fks
assets 27 columns 11 indexes 2 fks
audit_log 7 columns 2 indexes 1 fks
autohdr_fetch_claims 17 columns 3 indexes 5 fks
autohdr_final_associations 6 columns 2 indexes 2 fks
autohdr_handoffs 21 columns 4 indexes 4 fks
autohdr_manual_ingest_leases 5 columns 0 indexes 1 fks
autohdr_output_mappings 14 columns 3 indexes 3 fks
autohdr_path_claims 13 columns 3 indexes 4 fks
autohdr_sent_files 6 columns 2 indexes 2 fks
autohdr_scaffold_claims 8 columns 3 indexes 2 fks
client_links 8 columns 2 indexes 1 fks
collection_links 8 columns 3 indexes 1 fks
collections 8 columns 1 indexes 1 fks
document_uploads 28 columns 7 indexes 3 fks
download_selection_tickets 6 columns 1 indexes 2 fks
dropbox_monitor_health 15 columns 1 indexes 1 fks
edited_source_claims 9 columns 2 indexes 3 fks
external_edited_upload_parts 10 columns 0 indexes 1 fks
external_edited_upload_sessions 22 columns 3 indexes 3 fks
feature_flags 4 columns 1 indexes 1 fks
integration_connections 10 columns 0 indexes 0 fks
jobs 11 columns 3 indexes 1 fks
notice_board_post_mentions 4 columns 1 indexes 2 fks
notice_board_posts 6 columns 1 indexes 1 fks
notification_delivery_ledger 16 columns 5 indexes 2 fks
notification_outbox 24 columns 7 indexes 0 fks
notification_preferences 3 columns 0 indexes 1 fks
notifications 12 columns 2 indexes 2 fks
pipeline_stages 4 columns 0 indexes 0 fks
premium_unlocks 6 columns 0 indexes 2 fks
project_activity_events 15 columns 1 indexes 1 fks
project_comment_mentions 4 columns 1 indexes 2 fks
project_comment_read_markers 5 columns 1 indexes 2 fks
project_comments 7 columns 1 indexes 2 fks
project_deadline_occurrences 17 columns 3 indexes 1 fks
project_members 5 columns 2 indexes 2 fks
project_subtasks 23 columns 2 indexes 3 fks
projects 36 columns 3 indexes 3 fks
publishes 6 columns 1 indexes 3 fks
raw_reconciliation_claims 8 columns 1 indexes 2 fks
rendition_dlq_events 5 columns 2 indexes 0 fks
selections 6 columns 1 indexes 2 fks
session 9 columns 2 indexes 1 fks
upload_manifests 7 columns 1 indexes 2 fks
user 13 columns 1 indexes 0 fks
verification 6 columns 0 indexes 0 fks
webhook_events 8 columns 1 indexes 0 fks

No schema changes, nothing to migrate 😴
```

### generate (second) — exit 0

```text

> generate
> drizzle-kit generate

No config path provided, using default 'drizzle.config.ts'
Reading config file '/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal/packages/db/drizzle.config.ts'
54 tables
account 13 columns 1 indexes 1 fks
agencies 5 columns 0 indexes 0 fks
agents 7 columns 1 indexes 1 fks
annotations 10 columns 1 indexes 2 fks
asset_ingest_identities 5 columns 2 indexes 2 fks
asset_renditions 10 columns 2 indexes 1 fks
asset_review_state 8 columns 1 indexes 2 fks
assets 27 columns 11 indexes 2 fks
audit_log 7 columns 2 indexes 1 fks
autohdr_fetch_claims 17 columns 3 indexes 5 fks
autohdr_final_associations 6 columns 2 indexes 2 fks
autohdr_handoffs 21 columns 4 indexes 4 fks
autohdr_manual_ingest_leases 5 columns 0 indexes 1 fks
autohdr_output_mappings 14 columns 3 indexes 3 fks
autohdr_path_claims 13 columns 3 indexes 4 fks
autohdr_sent_files 6 columns 2 indexes 2 fks
autohdr_scaffold_claims 8 columns 3 indexes 2 fks
client_links 8 columns 2 indexes 1 fks
collection_links 8 columns 3 indexes 1 fks
collections 8 columns 1 indexes 1 fks
document_uploads 28 columns 7 indexes 3 fks
download_selection_tickets 6 columns 1 indexes 2 fks
dropbox_monitor_health 15 columns 1 indexes 1 fks
edited_source_claims 9 columns 2 indexes 3 fks
external_edited_upload_parts 10 columns 0 indexes 1 fks
external_edited_upload_sessions 22 columns 3 indexes 3 fks
feature_flags 4 columns 1 indexes 1 fks
integration_connections 10 columns 0 indexes 0 fks
jobs 11 columns 3 indexes 1 fks
notice_board_post_mentions 4 columns 1 indexes 2 fks
notice_board_posts 6 columns 1 indexes 1 fks
notification_delivery_ledger 16 columns 5 indexes 2 fks
notification_outbox 24 columns 7 indexes 0 fks
notification_preferences 3 columns 0 indexes 1 fks
notifications 12 columns 2 indexes 2 fks
pipeline_stages 4 columns 0 indexes 0 fks
premium_unlocks 6 columns 0 indexes 2 fks
project_activity_events 15 columns 1 indexes 1 fks
project_comment_mentions 4 columns 1 indexes 2 fks
project_comment_read_markers 5 columns 1 indexes 2 fks
project_comments 7 columns 1 indexes 2 fks
project_deadline_occurrences 17 columns 3 indexes 1 fks
project_members 5 columns 2 indexes 2 fks
project_subtasks 23 columns 2 indexes 3 fks
projects 36 columns 3 indexes 3 fks
publishes 6 columns 1 indexes 3 fks
raw_reconciliation_claims 8 columns 1 indexes 2 fks
rendition_dlq_events 5 columns 2 indexes 0 fks
selections 6 columns 1 indexes 2 fks
session 9 columns 2 indexes 1 fks
upload_manifests 7 columns 1 indexes 2 fks
user 13 columns 1 indexes 0 fks
verification 6 columns 0 indexes 0 fks
webhook_events 8 columns 1 indexes 0 fks

No schema changes, nothing to migrate 😴
```

### migration/schema diff — exit 0

```text
?? packages/db/test/tb5a-compaction-benchmark.test.ts
?? packages/db/test/tb5a-migration-proof.test.ts
?? packages/db/test/tb5a-proof-support.ts
?? ../qa-evidence/
```


The migration/schema diff command exited 0. The two Drizzle generations both reported
`No schema changes, nothing to migrate`; no migration, snapshot, or `schema.ts` drift was
produced.

## Scratch-D1 proof result

The consolidated proof passed in the DB workspace. It applies every migration file numbered
`0000` through `0037`, enables SQLite foreign keys, verifies an empty `PRAGMA foreign_key_check`
and `PRAGMA quick_check = ok`, and confirms the permanent rollback table/runtime indexes while
temporary `_tb5a_0037_*` objects are absent.

The normalization fixture produced the frozen visible sequences:

| Stage | Visible order after normalization | Positions |
|---|---|---|
| `awaiting_raw` | `a-tie-a, a-tie-b, a-fraction, a-null` | `0, 1024, 2048, 3072` |
| `raw_review` | `b-priority` | `0` |
| inactive `edited_review` | `inactive-occupant` | `0` |
| `delivered` | `delivered-project` | `0` |

All seven unarchived rows received revision 1; both archived rows retained their original
Stage/Priority/position/archive values and revision 0. The noncanonical unarchived preflight
aborted before capture and left the journal tail at migration 0036. The postflight trigger
case rolled back all migration work and also left the journal at 0036. The drifted-row
pre-enable rollback rejected the batch with no position changes.

The valid compacting winner returned three rows and incremented each changed row exactly once.
Malformed plans for duplicate expected ID, duplicate changed-plan ID, sibling-as-target, stale
tuple, missing changed row, extra changed row, and wrong count each returned zero winner rows,
zero audit rows, and left all project rows unchanged. Both non-compacting and compacting
`EXPLAIN QUERY PLAN` outputs contained `MATERIALIZE fence`.

## Compaction benchmark

The benchmark seeds the requested number of `edited_review` destination rows, inserts the
target at the top, measures `performance.now()` around the D1/SQLite batch, and proves the
full `0,1024,2048,…` sequence plus one revision bump for every returned row.

| Destination rows | changedPlanJson bytes | expectedTargetJson bytes | batch execution ms | RETURNING rows | revisions incremented |
|---:|---:|---:|---:|---:|---:|
| 25 | 3,657 | 2,979 | 3.226 | 26 | 26 |
| 100 | 14,312 | 11,984 | 33.684 | 101 | 101 |
| 250 | 35,912 | 30,284 | 196.645 | 251 | 251 |
| 500 | 71,912 | 60,784 | 792.545 | 501 | 501 |

These are best-effort local SQLite timings, not a service-level latency guarantee. The largest
production destination column must be no larger than the largest green benchmark size (500)
during preflight; if it is larger, rollout stops for fresh performance review.

A full-column compaction invalidates every other client's optimistic token for that column, so
TB5A intentionally expects `409` churn and does not auto-retry.

## Deployment readiness

The operator checklist is in
`docs/plans/tb5a/slice-8-deploy-runbook.md`. It covers the seeded-OFF inert mechanism, the
pre-0037 freeze, recovery export and journal-tail checks, migration/deploy order, flag-OFF
verification, enablement/resume, and the exact rollback/fix-forward paths.

