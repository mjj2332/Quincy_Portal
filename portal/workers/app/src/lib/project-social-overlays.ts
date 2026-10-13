import {
  projectSocialOverlaysResponseSchema, socialOverlayImagePath,
  type ProjectSocialOverlayChoice, type ProjectSocialOverlayPreview, type ProjectSocialOverlaysResponse,
} from "@quincy/shared";
import { auditMeta, type AuditPrincipal } from "./audit";
import { newId } from "./ids";

/**
 * A Project's Social overlays (#870). `resolveProjectSocialOverlays` is the one rule the Video viewer (#871) and the guest payload (#872) consume: the Project's selected overlays that are not
 * archived, else the non-archived Default, else nothing (an empty library). It reads library order (Default first, then name ignoring case, then id), never selection order. A fallback is never stored.
 * `setProjectSocialOverlays` is one `db.batch`: an audit row whose `WHERE` carries the whole fence (Project unarchived, stored set still the one the caller saw, every wanted overlay real and either
 * selectable or already stored), then the deletes and inserts, each fenced on that audit row's id. A refused fence writes nothing and leaves no audit row.
 */
export type Principal = NonNullable<AuditPrincipal>;

/** Seam for the race tests: runs after admission and before the batch. Always cleared by the test that sets it. */
export const projectSocialOverlayTestHooks: { beforeWrite?: () => Promise<void> } = {};

type ChoiceRow = { id: string; name: string; platform_label: string; is_default: number; archived_at: number | null };
type PreviewRow = ChoiceRow & { image_key: string; width: number; height: number };
const ORDER = "ORDER BY is_default DESC, name COLLATE NOCASE, id";
const choice = (row: ChoiceRow): ProjectSocialOverlayChoice => ({ id: row.id, name: row.name, platformLabel: row.platform_label, isDefault: row.is_default === 1, archivedAt: row.archived_at });
const uuidOfKey = (key: string): string => key.slice(key.lastIndexOf("/") + 1, -".png".length);
const preview = (row: PreviewRow): ProjectSocialOverlayPreview => ({ ...{ id: row.id, name: row.name, platformLabel: row.platform_label, isDefault: row.is_default === 1 }, imageUrl: socialOverlayImagePath(row.id, uuidOfKey(row.image_key)), width: row.width, height: row.height });

const COLUMNS = "id, name, platform_label, is_default, archived_at";
const RESOLVED = `WITH chosen AS (SELECT o.* FROM project_social_overlays p JOIN social_overlays o ON o.id = p.overlay_id WHERE p.project_id = ?1 AND o.archived_at IS NULL)
  SELECT id, name, platform_label, is_default, archived_at, image_key, width, height FROM chosen
  UNION ALL SELECT id, name, platform_label, is_default, archived_at, image_key, width, height FROM social_overlays
    WHERE is_default = 1 AND archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM chosen)
  ${ORDER}`;

/** The picker's list, the stored selection (archived joins included) and the resolution, read in one batch so they share a snapshot. */
export async function readProjectSocialOverlays(db: D1Database, projectId: string): Promise<ProjectSocialOverlaysResponse> {
  const [available, selected, resolved] = await db.batch([
    db.prepare(`SELECT ${COLUMNS} FROM social_overlays WHERE archived_at IS NULL ${ORDER}`),
    db.prepare(`SELECT ${COLUMNS} FROM social_overlays WHERE id IN (SELECT overlay_id FROM project_social_overlays WHERE project_id = ?1) ${ORDER}`).bind(projectId),
    db.prepare(RESOLVED).bind(projectId),
  ]);
  return projectSocialOverlaysResponseSchema.parse({
    available: (available!.results as ChoiceRow[]).map(choice),
    selected: (selected!.results as ChoiceRow[]).map(choice),
    resolved: (resolved!.results as PreviewRow[]).map(preview),
  });
}

/** What the Video viewer lays over a Video in this Project. */
export async function resolveProjectSocialOverlays(db: D1Database, projectId: string): Promise<ProjectSocialOverlayPreview[]> {
  return (await db.prepare(RESOLVED).bind(projectId).all<PreviewRow>()).results.map(preview);
}

export type SetOutcome =
  | { kind: "set"; state: ProjectSocialOverlaysResponse }
  | { kind: "conflict"; state: ProjectSocialOverlaysResponse }
  | { kind: "archived" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));
const projectState = async (db: D1Database, projectId: string): Promise<"missing" | "archived" | "live"> => {
  const row = await db.prepare("SELECT archived_at FROM projects WHERE id = ?1").bind(projectId).first<{ archived_at: number | null }>();
  return row === null ? "missing" : row.archived_at === null ? "live" : "archived";
};

export async function setProjectSocialOverlays(db: D1Database, input: { projectId: string; overlayIds: string[]; expectedOverlayIds: string[]; principal: Principal; now: number }): Promise<SetOutcome> {
  const { projectId, overlayIds, expectedOverlayIds } = input;
  const project = await projectState(db, projectId);
  if (project === "missing") return { kind: "not_found" };
  if (project === "archived") return { kind: "archived" };
  const current = await readProjectSocialOverlays(db, projectId);
  const stored = current.selected.map((row) => row.id);
  if (!sameSet(stored, expectedOverlayIds)) return { kind: "conflict", state: current };
  // Every wanted overlay must exist, and one that is archived may only be there because the Project already holds it.
  const known = new Map((await db.prepare(`SELECT id, archived_at FROM social_overlays WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(overlayIds)).all<{ id: string; archived_at: number | null }>()).results.map((row) => [row.id, row.archived_at]));
  for (const id of overlayIds) if (!known.has(id) || (known.get(id) !== null && !stored.includes(id))) return { kind: "unavailable" };
  const wanted = overlayIds.filter((id) => known.get(id) === null);
  const activeStored = current.selected.filter((row) => row.archivedAt === null).map((row) => row.id);
  if (sameSet(activeStored, wanted)) return { kind: "set", state: current };
  const archivedStored = current.selected.filter((row) => row.archivedAt !== null).map((row) => row.id);
  await projectSocialOverlayTestHooks.beforeWrite?.();

  const auditId = newId(), wantedJson = JSON.stringify(overlayIds), expectedJson = JSON.stringify(expectedOverlayIds);
  const meta = auditMeta(input.principal, { before: [...stored].sort(), after: [...archivedStored, ...wanted].sort() });
  await db.batch([
    db.prepare(
      `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
       SELECT ?1, ?2, 'project.social_overlays_set', 'project', ?3, ?4, ?5
       WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?3 AND archived_at IS NULL)
         AND (SELECT count(*) FROM project_social_overlays WHERE project_id = ?3) = json_array_length(?6)
         AND NOT EXISTS (SELECT 1 FROM project_social_overlays WHERE project_id = ?3 AND overlay_id NOT IN (SELECT value FROM json_each(?6)))
         AND NOT EXISTS (SELECT 1 FROM json_each(?7) j WHERE NOT EXISTS (
           SELECT 1 FROM social_overlays o WHERE o.id = j.value AND (o.archived_at IS NULL OR EXISTS (SELECT 1 FROM project_social_overlays p WHERE p.project_id = ?3 AND p.overlay_id = o.id))))`,
    ).bind(auditId, input.principal.id, projectId, meta, input.now, expectedJson, wantedJson),
    db.prepare(
      `DELETE FROM project_social_overlays WHERE project_id = ?1 AND overlay_id NOT IN (SELECT value FROM json_each(?2))
         AND overlay_id IN (SELECT id FROM social_overlays WHERE archived_at IS NULL) AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?3)`,
    ).bind(projectId, wantedJson, auditId),
    db.prepare(
      `INSERT INTO project_social_overlays (project_id, overlay_id)
       SELECT ?1, o.id FROM social_overlays o WHERE o.id IN (SELECT value FROM json_each(?2)) AND o.archived_at IS NULL AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?3)
       ON CONFLICT DO NOTHING`,
    ).bind(projectId, wantedJson, auditId),
  ]);
  const state = await readProjectSocialOverlays(db, projectId);
  if (await db.prepare("SELECT 1 AS one FROM audit_log WHERE id = ?1").bind(auditId).first()) return { kind: "set", state };
  // Nothing was written: say why, from a fresh read.
  const now = await projectState(db, projectId);
  if (now !== "live") return now === "missing" ? { kind: "not_found" } : { kind: "archived" };
  if (!sameSet(state.selected.map((row) => row.id), expectedOverlayIds)) return { kind: "conflict", state };
  return { kind: "unavailable" };
}
