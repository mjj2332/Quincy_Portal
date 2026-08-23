import { assets, collections, jobs, projects, selections } from "@quincy/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { isAcceptedPhotoFilename } from "@quincy/shared";

import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { setJobStatus } from "../lib/jobs";
import { isWorkflowAlreadyExists } from "./claims";

export const AUTOHDR_API_SEND_JOB_KIND = "autohdr_api_send";

export type AutoHdrApiSendErrorCode =
  | "ERR_PROJECT_NOT_FOUND"
  | "ERR_PROJECT_ARCHIVED"
  | "ERR_STAGE_NOT_READY"
  | "ERR_NO_RAW_SELECTION"
  | "ERR_SEND_IN_PROGRESS"
  | "ERR_PROVIDER_NOT_CONFIGURED"
  | "ERR_SEND_SETUP_FAILED";

export type AutoHdrApiSendResult =
  | { ok: true; jobId: string; workflowId: string }
  | { ok: false; code: AutoHdrApiSendErrorCode; message: string };

export type AutoHdrApiSendJobPayload = {
  provider: "autohdr_api_v4";
  assetIds: string[];
  initiatedBy: string;
  address?: string;
  phase: "queued" | "created" | "finalized";
  uid?: string;
};

export type AutoHdrApiSendInput = {
  projectId: string;
  assetIds: string[];
  jobId: string;
  initiatedBy: string;
  address?: string;
};

function projectAddress(project: { street: string; suburb: string | null; postcode: string | null }): string {
  return [project.street, project.suburb, project.postcode].filter((part): part is string => Boolean(part?.trim())).join(", ");
}

function parseJobPayload(value: string | null): AutoHdrApiSendJobPayload | null {
  try {
    const payload = JSON.parse(value ?? "null") as Partial<AutoHdrApiSendJobPayload> | null;
    if (!payload || payload.provider !== "autohdr_api_v4" || !Array.isArray(payload.assetIds) || typeof payload.initiatedBy !== "string") return null;
    if (!payload.assetIds.every((assetId) => typeof assetId === "string")) return null;
    return {
      provider: "autohdr_api_v4",
      assetIds: payload.assetIds,
      initiatedBy: payload.initiatedBy,
      ...(typeof payload.address === "string" ? { address: payload.address } : {}),
      phase: payload.phase === "created" || payload.phase === "finalized" ? payload.phase : "queued",
      ...(typeof payload.uid === "string" ? { uid: payload.uid } : {}),
    };
  } catch {
    return null;
  }
}

function sameAssetIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function workflowIdFor(jobId: string): string {
  return `autohdr-api-send-${jobId}`;
}

async function ensureWorkflow(env: Env, projectId: string, jobId: string, payload: AutoHdrApiSendJobPayload): Promise<AutoHdrApiSendResult> {
  const workflowId = workflowIdFor(jobId);
  try {
    await env.AUTOHDR_API_SEND_WORKFLOW.create({
      id: workflowId,
      params: {
        projectId,
        assetIds: payload.assetIds,
        jobId,
        initiatedBy: payload.initiatedBy,
        ...(payload.address ? { address: payload.address } : {}),
      },
    });
    return { ok: true, jobId, workflowId };
  } catch (error) {
    if (isWorkflowAlreadyExists(error)) return { ok: true, jobId, workflowId };
    const message = errorMessage(error);
    await setJobStatus(dbFor(env), jobId, "failed", message);
    return { ok: false, code: "ERR_SEND_SETUP_FAILED", message };
  }
}

export async function claimAutoHdrApiSend(env: Env, projectId: string, initiatedBy?: string): Promise<AutoHdrApiSendResult> {
  if (!initiatedBy) return { ok: false, code: "ERR_SEND_SETUP_FAILED", message: "AutoHDR send requires an initiating staff identity" };
  if (!env.AUTOHDR_API_KEY?.trim()) {
    return { ok: false, code: "ERR_PROVIDER_NOT_CONFIGURED", message: "The AutoHDR API key is not configured on the background Worker" };
  }

  const db = dbFor(env);
  const project = await db.select({
    street: projects.street,
    suburb: projects.suburb,
    postcode: projects.postcode,
    stageKey: projects.stageKey,
    archivedAt: projects.archivedAt,
  }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return { ok: false, code: "ERR_PROJECT_NOT_FOUND", message: "Project not found" };
  if (project.archivedAt) return { ok: false, code: "ERR_PROJECT_ARCHIVED", message: "Project is archived" };
  if (project.stageKey !== "raw_review") {
    return { ok: false, code: "ERR_STAGE_NOT_READY", message: "AutoHDR sends can only start from Raw Review" };
  }

  const selected = await db.select({ assetId: assets.id, filename: assets.originalFilename })
    .from(selections)
    .innerJoin(assets, eq(selections.assetId, assets.id))
    .innerJoin(collections, and(eq(assets.collectionId, collections.id), eq(collections.projectId, projectId), eq(collections.kind, "raw")))
    .where(and(eq(selections.state, "selected_for_editing"), isNull(assets.supersededAt)))
    .all();
  selected.sort((left, right) => left.assetId.localeCompare(right.assetId));
  if (!selected.length) return { ok: false, code: "ERR_NO_RAW_SELECTION", message: "Select at least one RAW asset before sending to AutoHDR" };
  const filenames = new Set<string>();
  for (const row of selected) {
    if (!isAcceptedPhotoFilename(row.filename)) {
      return { ok: false, code: "ERR_NO_RAW_SELECTION", message: `Unsupported selected photo: ${row.filename}` };
    }
    const key = row.filename.toLowerCase();
    if (filenames.has(key)) {
      return { ok: false, code: "ERR_NO_RAW_SELECTION", message: `Duplicate selected filename: ${row.filename}` };
    }
    filenames.add(key);
  }

  const assetIds = selected.map((row) => row.assetId);
  const payload: AutoHdrApiSendJobPayload = {
    provider: "autohdr_api_v4",
    assetIds,
    initiatedBy,
    address: projectAddress(project),
    phase: "queued",
  };
  const jobId = crypto.randomUUID();
  const correlationId = `autohdr_api_send:${projectId}`;
  const now = Date.now();
  const inserted = await env.DB.prepare(
    "INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, created_at, updated_at) " +
    "SELECT ?, ?, 'queued', ?, ?, ?, 0, ?, ? " +
    "WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL AND stage_key = 'raw_review') " +
    "AND NOT EXISTS (SELECT 1 FROM jobs WHERE project_id = ? AND kind = ? AND status IN ('queued','running'))",
  ).bind(
    jobId, AUTOHDR_API_SEND_JOB_KIND, correlationId, projectId, JSON.stringify(payload), now, now,
    projectId, projectId, AUTOHDR_API_SEND_JOB_KIND,
  ).run();

  if ((inserted.meta.changes ?? 0) === 1) return ensureWorkflow(env, projectId, jobId, payload);

  const active = await db.select({ id: jobs.id, payloadJson: jobs.payloadJson })
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.kind, AUTOHDR_API_SEND_JOB_KIND), inArray(jobs.status, ["queued", "running"])))
    .get();
  const activePayload = active ? parseJobPayload(active.payloadJson) : null;
  if (active && activePayload) {
    if (!sameAssetIds(activePayload.assetIds, assetIds)) {
      return { ok: false, code: "ERR_SEND_IN_PROGRESS", message: "A different AutoHDR send is already queued or running" };
    }
    return ensureWorkflow(env, projectId, active.id, activePayload);
  }

  const current = await db.select({ stageKey: projects.stageKey, archivedAt: projects.archivedAt })
    .from(projects).where(eq(projects.id, projectId)).get();
  if (!current) return { ok: false, code: "ERR_PROJECT_NOT_FOUND", message: "Project not found" };
  if (current.archivedAt) return { ok: false, code: "ERR_PROJECT_ARCHIVED", message: "Project is archived" };
  if (current.stageKey !== "raw_review") return { ok: false, code: "ERR_STAGE_NOT_READY", message: "AutoHDR sends can only start from Raw Review" };
  return { ok: false, code: "ERR_SEND_SETUP_FAILED", message: "The AutoHDR send could not be claimed" };
}
