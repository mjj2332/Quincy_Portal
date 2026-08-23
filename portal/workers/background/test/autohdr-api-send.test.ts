import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { claimAutoHdrApiSend, type AutoHdrApiSendInput, type AutoHdrApiSendJobPayload } from "../src/autohdr/api-send";
import type { Env } from "../src/env";
import { AutoHdrApiSend } from "../src/workflows/autohdr-api-send";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(() => executeSql(__PORTAL_MIGRATION_SQL__));
afterEach(() => vi.unstubAllGlobals());

async function fixture(options: { selected?: number; withJob?: boolean } = {}) {
  const now = Date.now();
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const assetIds = Array.from({ length: options.selected ?? 2 }, () => crypto.randomUUID());
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Admin', ?, 1, 'admin', 1, ?, ?)")
      .bind(userId, `${userId}@test.invalid`, now, now),
    // Deliberately no raw_folder_path: the direct AutoHDR API send must not depend on Dropbox.
    database.DB.prepare("INSERT INTO projects (id, street, suburb, postcode, stage_key, created_at, updated_at) VALUES (?, '1 Quincy Street', 'Sydney', '2000', 'raw_review', ?, ?)")
      .bind(projectId, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'received', ?, ?, ?)")
      .bind(collectionId, projectId, assetIds.length, now, now),
    ...assetIds.map((assetId, index) => database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, 3, 'upload', ?, ?)")
      .bind(assetId, collectionId, `tests/${assetId}.jpg`, `capture-${index + 1}.jpg`, now, now)),
    ...assetIds.map((assetId) => database.DB.prepare("INSERT INTO selections (id, asset_id, selected_by, state, created_at) VALUES (?, ?, ?, 'selected_for_editing', ?)")
      .bind(crypto.randomUUID(), assetId, userId, now)),
  ]);
  for (const assetId of assetIds) await database.MEDIA.put(`tests/${assetId}.jpg`, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/jpeg" } });
  return { userId, projectId, collectionId, assetIds };
}

function workflow(envForRun: Env) {
  const instance = Object.create(AutoHdrApiSend.prototype) as AutoHdrApiSend;
  Object.defineProperty(instance, "env", { value: envForRun, writable: true });
  return instance;
}

function directStep() {
  return {
    do: async (_name: string, callback: () => Promise<unknown>) => callback(),
    sleep: async () => undefined,
  };
}

describe("direct AutoHDR API send claim", () => {
  it("freezes the current selection, creates one job, and reuses it for a duplicate click", async () => {
    const data = await fixture();
    const create = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("workflow instance already exists (409)"));
    const localEnv = {
      DB: database.DB,
      AUTOHDR_API_KEY: "test-key",
      AUTOHDR_API_SEND_WORKFLOW: { create },
    } as unknown as Env;

    const first = await claimAutoHdrApiSend(localEnv, data.projectId, data.userId);
    expect(first).toMatchObject({ ok: true, jobId: expect.any(String), workflowId: expect.stringMatching(/^autohdr-api-send-/) });
    const second = await claimAutoHdrApiSend(localEnv, data.projectId, data.userId);
    expect(second).toEqual(first);

    const rows = await database.DB.prepare("SELECT id, kind, status, payload_json FROM jobs WHERE project_id = ? AND kind = 'autohdr_api_send'")
      .bind(data.projectId).all<{ id: string; kind: string; status: string; payload_json: string }>();
    expect(rows.results).toHaveLength(1);
    const payload = JSON.parse(rows.results[0]!.payload_json) as AutoHdrApiSendJobPayload;
    expect(payload).toMatchObject({ provider: "autohdr_api_v4", assetIds: [...data.assetIds].sort(), phase: "queued" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("blocks a changed selection while the first API send is active", async () => {
    const data = await fixture();
    const create = vi.fn(async () => undefined);
    const localEnv = { DB: database.DB, AUTOHDR_API_KEY: "test-key", AUTOHDR_API_SEND_WORKFLOW: { create } } as unknown as Env;
    await expect(claimAutoHdrApiSend(localEnv, data.projectId, data.userId)).resolves.toMatchObject({ ok: true });

    const extraId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'changed.jpg', 3, 'upload', ?, ?)")
        .bind(extraId, data.collectionId, `tests/${extraId}.jpg`, now, now),
      database.DB.prepare("INSERT INTO selections (id, asset_id, selected_by, state, created_at) VALUES (?, ?, ?, 'selected_for_editing', ?)")
        .bind(crypto.randomUUID(), extraId, data.userId, now),
    ]);
    await expect(claimAutoHdrApiSend(localEnv, data.projectId, data.userId)).resolves.toMatchObject({
      ok: false,
      code: "ERR_SEND_IN_PROGRESS",
    });
  });

  it("refuses to queue work when the background Worker has no AutoHDR key", async () => {
    const data = await fixture();
    const result = await claimAutoHdrApiSend({ DB: database.DB } as unknown as Env, data.projectId, data.userId);
    expect(result).toEqual({
      ok: false,
      code: "ERR_PROVIDER_NOT_CONFIGURED",
      message: "The AutoHDR API key is not configured on the background Worker",
    });
  });
});

describe("AutoHdrApiSend.run", () => {
  it("uploads selected R2 bytes, finalizes once, advances the stage, and never requests edited photos", async () => {
    const data = await fixture();
    const jobId = crypto.randomUUID();
    const now = Date.now();
    const queuedPayload: AutoHdrApiSendJobPayload = {
      provider: "autohdr_api_v4",
      assetIds: data.assetIds,
      initiatedBy: data.userId,
      address: "1 Quincy Street, Sydney, 2000",
      phase: "queued",
    };
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, created_at, updated_at) VALUES (?, 'autohdr_api_send', 'queued', ?, ?, ?, 0, ?, ?)")
      .bind(jobId, `autohdr_api_send:${data.projectId}`, data.projectId, JSON.stringify(queuedPayload), now, now).run();

    const uploads: number[][] = [];
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith("/create-photoshoot-with-presigned-urls")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty("upload_callback_url");
        expect(body).not.toHaveProperty("status_callback_url");
        return new Response(JSON.stringify({
          uid: "shoot-123",
          uploaded_files: data.assetIds.map((_, index) => `https://uploads.example/${index + 1}`),
        }), { status: 201 });
      }
      if (url.startsWith("https://uploads.example/")) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        uploads.push([...new Uint8Array(await new Response(init?.body).arrayBuffer())]);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/finalize-photoshoot-upload")) return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
      throw new Error(`Unexpected AutoHDR request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const input: AutoHdrApiSendInput = {
      projectId: data.projectId,
      assetIds: data.assetIds,
      jobId,
      initiatedBy: data.userId,
      address: "1 Quincy Street, Sydney, 2000",
    };
    const localEnv = {
      DB: database.DB,
      MEDIA: database.MEDIA,
      AUTOHDR_API_KEY: "secret-key",
      APP_ORIGIN: "https://portal.test",
    } as unknown as Env;
    await workflow(localEnv).run({ payload: input, timestamp: new Date(), instanceId: "api-send", workflowName: "autohdr-api-send" }, directStep() as never);

    expect(uploads).toEqual([[1, 2, 3], [1, 2, 3]]);
    expect(fetchMock.mock.calls.map(([request]) => String(request))).toEqual([
      "https://quantumreachadvertising.com/external-api/v2/create-photoshoot-with-presigned-urls",
      "https://uploads.example/1",
      "https://uploads.example/2",
      "https://quantumreachadvertising.com/external-api/v2/finalize-photoshoot-upload",
    ]);
    expect(fetchMock.mock.calls.some(([request]) => String(request).includes("get-processed-photos"))).toBe(false);
    await expect(database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(data.projectId).first()).resolves.toEqual({ stage_key: "editing_autohdr" });
    const job = await database.DB.prepare("SELECT status, error, payload_json FROM jobs WHERE id = ?").bind(jobId)
      .first<{ status: string; error: string | null; payload_json: string }>();
    expect(job).toMatchObject({ status: "done", error: null });
    expect(JSON.parse(job!.payload_json)).toMatchObject({ phase: "finalized", uid: "shoot-123", assetIds: data.assetIds });
    const audit = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'project.autohdr_api_send.finalized' AND target_id = ?")
      .bind(data.projectId).first<{ meta_json: string }>();
    expect(JSON.parse(audit!.meta_json)).toMatchObject({ retrievalEnabled: false, uid: "shoot-123", assetCount: 2 });
  });

  it("leaves Raw Review unchanged and fails the job when an upload is rejected", async () => {
    const data = await fixture({ selected: 1 });
    const jobId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, retries, created_at, updated_at) VALUES (?, 'autohdr_api_send', 'queued', ?, '{}', 0, ?, ?)")
      .bind(jobId, data.projectId, now, now).run();
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith("/create-photoshoot-with-presigned-urls")) {
        return new Response(JSON.stringify({ uid: "shoot-failed", uploaded_files: ["https://uploads.example/fail"] }), { status: 201 });
      }
      return new Response("upload refused", { status: 500 });
    }));
    const localEnv = { DB: database.DB, MEDIA: database.MEDIA, AUTOHDR_API_KEY: "secret-key", APP_ORIGIN: "https://portal.test" } as unknown as Env;
    const input: AutoHdrApiSendInput = { projectId: data.projectId, assetIds: data.assetIds, jobId, initiatedBy: data.userId };
    await expect(workflow(localEnv).run({ payload: input, timestamp: new Date(), instanceId: "api-send-fail", workflowName: "autohdr-api-send" }, directStep() as never))
      .rejects.toThrow("photo upload failed");
    await expect(database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(data.projectId).first()).resolves.toEqual({ stage_key: "raw_review" });
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first()).resolves.toEqual({ status: "failed" });
  });
});
