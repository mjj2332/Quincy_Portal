import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { buildProjectActivityStatements, COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "@quincy/db";
import { assets, collections, projects } from "@quincy/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { projectActivityDeepLink, publishNotificationOutbox, type ProjectActivityIntent } from "@quincy/shared";

import { autoHdrManualUploadFolderChain, autoHdrManualUploadPath, deriveAutoHdrFolderName, rawManualUploadPath } from "../autohdr/paths";
import { pathFromRawFolderLink } from "../dropbox/sync";
import { createFolder, upload } from "../dropbox/client";
import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { setJobStatus } from "../lib/jobs";
import { enqueueManualEditedRenditions } from "../manual-edited-renditions";
import { getEditorFolderMapping, type EditorFolderMapping } from "../editor-folders/mapping";
import { automationFlag } from "../dropbox/monitor-state";
import { dropboxPathKey } from "../dropbox/paths";

export interface ManualEditedPublishInput {
  projectId: string;
  assetId: string;
  jobId: string;
}

type ManualDestination = {
  path: string;
  mapped: boolean;
  mappingId?: string;
  connectionId?: string;
};

function editorAutomationEnabled(value: string | boolean | undefined): boolean {
  return automationFlag(value);
}

function isManualCollectionKind(value: string): value is "raw" | "edited" {
  return value === "raw" || value === "edited";
}

function mappedManualUploadPath(mapping: EditorFolderMapping, collectionKind: "raw" | "edited", section: string | null, assetId: string, filename: string): string {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(assetId)
    || !filename || filename !== filename.trim() || /[\\/\u0000-\u001f\u007f]/u.test(filename)) {
    throw new Error("Invalid manual upload path segment");
  }
  const roots = collectionKind === "raw" ? mapping.inputRoots : mapping.outputRoots;
  const root = roots.find((candidate) => candidate.section === section)
    ?? roots.find((candidate) => candidate.section !== null && section?.startsWith(`${candidate.section}/`))
    ?? roots.find((candidate) => candidate.section === null)
    ?? roots[0];
  if (!root) throw new Error(`Editor folder mapping has no ${collectionKind === "raw" ? "Input" : "Output"} root`);
  return `${root.path}/Manual-Uploads/${assetId}/${filename}`;
}

function mappedManualUploadFolderChain(destination: string): string[] {
  const assetFolder = destination.slice(0, destination.lastIndexOf("/"));
  const manualFolder = assetFolder.slice(0, assetFolder.lastIndexOf("/"));
  if (!assetFolder || !manualFolder) throw new Error(`Invalid mapped manual upload destination: ${destination}`);
  return [manualFolder, assetFolder];
}

type ManualDestinationAsset = {
  id: string;
  originalFilename: string;
  section: string | null;
  collectionKind: "raw" | "edited";
  projectId: string;
};

/**
 * A Workflow may resume with a destination resolved before an Editor mapping changed state.
 * Re-read the mapping immediately before every provider-side write so a cached legacy path
 * cannot cross the cutover into a ready mapping. The final D1 write repeats this fence because
 * a mapping can become ready after this check but before Dropbox accepts the upload.
 */
async function assertManualDestinationCurrent(
  env: Env,
  asset: ManualDestinationAsset,
  destination: ManualDestination,
): Promise<void> {
  // Legacy publication must remain usable before migration 0041 exists. The
  // mapping table is only part of the runtime contract when Editor automation
  // is enabled or when a workflow already carries a mapped destination.
  if (!destination.mapped && !editorAutomationEnabled(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) return;

  const db = dbFor(env);
  const mapping = await getEditorFolderMapping(db, asset.projectId);
  if (destination.mapped) {
    if (!mapping || mapping.state !== "ready" || mapping.id !== destination.mappingId || mapping.connectionId !== destination.connectionId) {
      throw new Error(`Editor folder mapping for project ${asset.projectId} changed before manual publishing`);
    }
    let expectedPath: string;
    try {
      expectedPath = mappedManualUploadPath(mapping, asset.collectionKind, asset.section, asset.id, asset.originalFilename);
    } catch (error) {
      throw new Error(`Editor folder mapping for project ${asset.projectId} no longer has a valid manual upload root`, { cause: error });
    }
    if (dropboxPathKey(expectedPath) !== dropboxPathKey(destination.path)) {
      throw new Error(`Editor folder mapping for project ${asset.projectId} no longer owns the manual upload destination`);
    }
    return;
  }

  // RAW keeps its legacy Tonomo mirror during pending/review; Edited has no safe legacy
  // destination once any mapping reservation exists, because AutoHDR is not an Editor Output.
  if (asset.collectionKind === "raw" ? mapping?.state === "ready" : mapping !== null) {
    throw new Error(`Editor folder mapping for project ${asset.projectId} changed before manual publishing`);
  }
}

type DestinationGuard = {
  clause: string;
  bindings: unknown[];
};

/** SQL-side writer fence corresponding to assertManualDestinationCurrent(). */
function manualDestinationGuard(
  env: Env,
  projectId: string,
  collectionKind: "raw" | "edited",
  destination: ManualDestination,
): DestinationGuard {
  if (destination.mapped) {
    return {
      clause: " AND EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.id = ? AND m.project_id = ? AND m.connection_id = ? AND m.state = 'ready' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN ? = 'raw' THEN m.input_roots_json ELSE m.output_roots_json END) AS root WHERE lower(?) = lower(json_extract(root.value, '$.path') || '/Manual-Uploads/' || assets.id || '/' || assets.original_filename)))",
      bindings: [destination.mappingId, projectId, destination.connectionId, collectionKind, destination.path],
    };
  }
  if (!editorAutomationEnabled(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) return { clause: "", bindings: [] };
  return collectionKind === "raw"
    ? {
        clause: " AND NOT EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.project_id = ? AND m.state = 'ready')",
        bindings: [projectId],
      }
    : {
        clause: " AND NOT EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.project_id = ?)",
        bindings: [projectId],
      };
}

export class ManualEditedPublish extends WorkflowEntrypoint<Env, ManualEditedPublishInput> {
  async run(event: Readonly<WorkflowEvent<ManualEditedPublishInput>>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    try {
      await step.do("mark-manual-publish-running", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "running");
        return { status: "running" };
      });

      const asset = await step.do("load-manual-upload", async () => {
        const row = await dbFor(this.env).select({
          id: assets.id, collectionId: assets.collectionId, r2Key: assets.r2Key, originalFilename: assets.originalFilename,
          source: assets.source, sourcePath: assets.sourcePath, section: assets.section, publishStatus: assets.publishStatus, collectionKind: collections.kind,
          projectId: collections.projectId, archivedAt: projects.archivedAt, rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink,
        }).from(assets)
          .innerJoin(collections, eq(assets.collectionId, collections.id))
          .innerJoin(projects, eq(collections.projectId, projects.id))
          .where(and(eq(assets.id, input.assetId), eq(collections.projectId, input.projectId))).get();
        if (!row || !isManualCollectionKind(row.collectionKind) || row.source !== "upload") throw new Error("Manual upload is no longer available for Dropbox publishing");
        // Writer-side guard: archiving can race an already-created Workflow. Never write a
        // Dropbox delivery or promote an asset for an archived project.
        if (row.archivedAt) throw new Error(`Project ${input.projectId} is archived — manual publish refused`);
        if (!row.sourcePath && !row.rawFolderPath && !row.rawFolderLink) {
          const mapping = editorAutomationEnabled(this.env.DROPBOX_EDITOR_AUTOMATION_ENABLED)
            ? await getEditorFolderMapping(dbFor(this.env), input.projectId)
            : null;
          const mappedRoots = mapping?.state === "ready"
            && (row.collectionKind === "raw" ? mapping.inputRoots.length > 0 : mapping.outputRoots.length > 0);
          if (!mappedRoots) throw new Error(`Project ${input.projectId} has no Dropbox RAW folder configured`);
        }
        const collectionKind = row.collectionKind;
        return { ...row, collectionKind };
      });

      // The step result is durable across deploys. Older in-flight Workflows persisted the
      // legacy destination as a string, so normalize that value before any mapped-only access.
      const persistedDestination = await step.do("resolve-manual-destination", async (): Promise<ManualDestination | string> => {
        if (asset.sourcePath && (asset.collectionKind === "raw" || asset.publishStatus === "ready")) {
          // A published asset keeps its exact provider path forever. This also lets a retry repair
          // only the rendition handoff after an Editor mapping is later reviewed or changed.
          return { path: asset.sourcePath, mapped: false };
        }
        const mapping = editorAutomationEnabled(this.env.DROPBOX_EDITOR_AUTOMATION_ENABLED)
          ? await getEditorFolderMapping(dbFor(this.env), input.projectId)
          : null;
        if (mapping?.state === "ready") {
          return {
            path: mappedManualUploadPath(mapping, asset.collectionKind, asset.section, asset.id, asset.originalFilename),
            mapped: true,
            mappingId: mapping.id,
            connectionId: mapping.connectionId,
          };
        }
        // A pending/review mapping does not own RAW yet, so retain the legacy Tonomo mirror
        // during the operator-review window. Edited uploads stay fail-closed until Output is
        // reviewed because the legacy path is not an Editor delivery destination.
        if (mapping && asset.collectionKind !== "raw") throw new Error(`Editor folder mapping for project ${input.projectId} needs review before manual publishing`);
        const rawFolderPath = asset.rawFolderPath ?? await pathFromRawFolderLink(this.env, asset.rawFolderLink);
        if (!rawFolderPath) throw new Error(`Project ${input.projectId} has no resolvable Dropbox RAW folder path`);
        return {
          path: asset.collectionKind === "raw"
            ? rawManualUploadPath(rawFolderPath, asset.originalFilename)
            : autoHdrManualUploadPath(deriveAutoHdrFolderName(rawFolderPath), asset.id, asset.originalFilename),
          mapped: false,
        };
      });
      const destination: ManualDestination = typeof persistedDestination === "string"
        ? { path: persistedDestination, mapped: false }
        : persistedDestination;
      const alreadyPublished = asset.collectionKind === "edited"
        ? asset.publishStatus === "ready"
        : asset.sourcePath === destination.path;

      if (!alreadyPublished) {
        if (asset.collectionKind === "raw") {
          await step.do("ensure-manual-raw-folder", async () => {
            await assertManualDestinationCurrent(this.env, asset, destination);
            // Create only our child folder. Dropbox returns path/not_found if the Tonomo-owned
            // listing parent is absent; this Workflow must never create that external folder.
            const folders = destination.mapped
              ? mappedManualUploadFolderChain(destination.path)
              : [destination.path.slice(0, destination.path.lastIndexOf("/"))];
            for (const folder of folders) await createFolder(this.env, dbFor(this.env), folder, destination.connectionId);
            return { folders };
          });
        } else {
          await step.do("ensure-manual-edited-folder", async () => {
            await assertManualDestinationCurrent(this.env, asset, destination);
            // Unlike the Tonomo listing folder, the `/AutoHDR` subtree is Portal-owned, so create
            // the destination the same way the AutoHDR hand-off does instead of relying on the
            // provider's implicit parent creation. Every level is created because create_folder_v2
            // only guarantees the leaf, and each call absorbs path/conflict.
            const folders = destination.mapped
              ? mappedManualUploadFolderChain(destination.path)
              : autoHdrManualUploadFolderChain(destination.path);
            for (const folder of folders) await createFolder(this.env, dbFor(this.env), folder, destination.connectionId);
            return { folders };
          });
        }
        await step.do("publish-manual-upload", async () => {
          await assertManualDestinationCurrent(this.env, asset, destination);
          const object = await this.env.MEDIA.get(asset.r2Key);
          if (!object?.body) throw new Error(`Manual ${asset.collectionKind} upload ${asset.id} is missing from R2`);
          await upload(this.env, dbFor(this.env), destination.path, object.body, destination.connectionId);
          return { destination: destination.path };
        });
        await step.do("make-manual-upload-ready", async () => {
          const now = new Date();
          if (asset.collectionKind === "raw") {
            // The RAW asset is visible from R2 before this Workflow starts. This guarded write
            // only records the provider destination after Dropbox has durably accepted it.
            const destinationGuard = manualDestinationGuard(this.env, input.projectId, "raw", destination);
            await this.env.DB.batch([
              this.env.DB.prepare(`UPDATE assets SET source_path = ?, updated_at = ? WHERE id = ? AND source = 'upload' AND EXISTS (SELECT 1 FROM collections INNER JOIN projects ON collections.project_id = projects.id WHERE collections.id = assets.collection_id AND collections.kind = 'raw' AND projects.id = ? AND projects.archived_at IS NULL)${destinationGuard.clause}`).bind(destination.path, now.getTime(), input.assetId, input.projectId, ...destinationGuard.bindings),
              this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.manual_raw_mirror.ready', 'asset', ?, ?, ? WHERE changes() = 1").bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, destination: destination.path, ...(destination.mapped ? { editorFolderMappingId: destination.mappingId, connectionId: destination.connectionId } : {}) }), now.getTime()),
            ]);
            const mirrored = await dbFor(this.env).select({ sourcePath: assets.sourcePath })
              .from(assets)
              .innerJoin(collections, eq(assets.collectionId, collections.id))
              .innerJoin(projects, and(eq(collections.projectId, projects.id), eq(projects.id, input.projectId), isNull(projects.archivedAt)))
              .where(eq(assets.id, input.assetId)).get();
            if (mirrored?.sourcePath !== destination.path) throw new Error(`Manual RAW upload ${input.assetId} could not record its Dropbox mirror`);
            return { status: "ready" };
          }

          // Recheck the project in the promotion statement: archive/delete can happen after
          // Dropbox accepts the idempotent overwrite but before this final visibility change.
          const publishAuditId = crypto.randomUUID();
          const publishActivityId = crypto.randomUUID();
          const publishActivity: ProjectActivityIntent = {
            schemaVersion: 1,
            activity: { id: publishActivityId, type: "project.workflow.manual_edited_ready", projectId: input.projectId, actorId: null, actorKind: "system", occurredAt: now.getTime(), source: { kind: "project_manual_edited", id: input.assetId, key: `project-manual-edited:${input.jobId}:${input.assetId}:ready` }, safePayload: { collectionKind: "edited", count: 1 }, deepLink: projectActivityDeepLink("project.workflow.manual_edited_ready", input.projectId) },
            broadDelivery: { registryKey: "project.workflow.manual_edited_ready", sourceActivityId: publishActivityId, coalesce: null },
          };
          const publishActivityBundle = buildProjectActivityStatements({ db: this.env.DB, intent: publishActivity, winnerAuditId: publishAuditId, createdAt: now.getTime() });
          const destinationGuard = manualDestinationGuard(this.env, input.projectId, "edited", destination);
          const publishResults = await this.env.DB.batch([
            this.env.DB.prepare(`UPDATE assets SET publish_status = 'ready', source_path = ?, updated_at = ? WHERE id = ? AND publish_status = 'pending' AND EXISTS (SELECT 1 FROM collections INNER JOIN projects ON collections.project_id = projects.id WHERE collections.id = assets.collection_id AND projects.id = ? AND projects.archived_at IS NULL)${destinationGuard.clause}`).bind(destination.path, now.getTime(), input.assetId, input.projectId, ...destinationGuard.bindings),
            // `changes()` is connection-local, and D1 batches execute on one connection. The
            // audit row therefore exists only for the guarded pending -> ready promotion.
            this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.manual_publish.ready', 'asset', ?, ?, ? WHERE changes() = 1 RETURNING id").bind(publishAuditId, input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, destination: destination.path, ...(destination.mapped ? { editorFolderMappingId: destination.mappingId, connectionId: destination.connectionId } : {}) }), now.getTime()),
            this.env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(asset.collectionId, now.getTime())),
            ...publishActivityBundle.statements,
          ]);
          const publicationIds = ((publishResults[3 + publishActivityBundle.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
          if (publicationIds.length) await publishNotificationOutbox(this.env.NOTIFICATION_QUEUE, this.env.DB, publicationIds);
          const promoted = await dbFor(this.env).select({ publishStatus: assets.publishStatus })
            .from(assets)
            .innerJoin(collections, eq(assets.collectionId, collections.id))
            .innerJoin(projects, and(eq(collections.projectId, projects.id), eq(projects.id, input.projectId), isNull(projects.archivedAt)))
            .where(eq(assets.id, input.assetId)).get();
          if (promoted?.publishStatus !== "ready") throw new Error(`Manual edited upload ${input.assetId} could not be published`);
          return { status: "ready" };
        });
      }

      if (asset.collectionKind === "edited") {
        await step.do("enqueue-manual-edited-renditions", async () => {
          // Dropbox publication is already durable. Throwing preserves ready visibility and makes
          // the Workflow/job retryable; a replay skips upload/promotion and retries only enqueue.
          await enqueueManualEditedRenditions(this.env, input.assetId);
          return { queued: true };
        });
      }

      await step.do("complete-manual-publish", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "done");
        return { status: "done" };
      });
    } catch (error) {
      const message = errorMessage(error);
      const now = new Date();
      const asset = await dbFor(this.env).select({ collectionKind: collections.kind })
        .from(assets)
        .innerJoin(collections, eq(assets.collectionId, collections.id))
        .where(and(eq(assets.id, input.assetId), eq(collections.projectId, input.projectId)))
        .get();
      if (asset?.collectionKind === "raw") {
        await this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'asset.manual_raw_mirror.failed', 'asset', ?, ?, ?)")
          .bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, error: message }), now.getTime())
          .run();
      } else {
        await this.env.DB.batch([
          this.env.DB.prepare("UPDATE assets SET publish_status = 'failed', updated_at = ? WHERE id = ? AND publish_status = 'pending'").bind(now.getTime(), input.assetId),
          this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.manual_publish.failed', 'asset', ?, ?, ? WHERE changes() = 1").bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, error: message }), now.getTime()),
        ]);
      }
      await setJobStatus(dbFor(this.env), input.jobId, "failed", message);
      throw error;
    }
  }
}
