import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createDb } from "@quincy/db";
import { projects } from "@quincy/db/schema";
import {
  EDITOR_INPUT_FOLDER,
  EDITOR_NOTES_FOLDER,
  EDITOR_OUTPUT_FOLDER,
  EDITOR_ROOT,
  deriveEditorProjectFolderName,
  editorDayFolderName,
  editorFolderChildPath,
  editorFolderPath,
  editorMonthFolderName,
  isValidShootDate,
} from "../src/editor-folders/paths";
import { editorReconcileNote, reconcileEditorFolder, reconcileEditorFolderOutcome } from "../src/editor-folders/scaffold";
import { handleEditorReconcileMessage } from "../src/editor-folders/queue";
import { getEditorFolderMapping, reserveEditorFolderMapping, acquireEditorFolderProvisionLease, linkExistingEditorFolder, recordEditorFolderProvision, retargetPendingEditorFolderMapping } from "../src/editor-folders/mapping";

declare const __PORTAL_MIGRATION_SQL__: string;

const database = env as unknown as { DB: D1Database };
const db = createDb(database.DB);

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

describe("Editor folder paths", () => {
  it("keeps the established September folder and uses year-aware later months", () => {
    expect(editorMonthFolderName("2026-09-01")).toBe("09. September");
    expect(editorDayFolderName("2026-09-01")).toBe("01");
    expect(editorMonthFolderName("2026-10-02")).toBe("2026-10 October");
    expect(editorMonthFolderName("2027-01-03")).toBe("2027-01 January");
    expect(editorFolderPath({ shootDate: "2026-10-02", projectFolderName: "123 Example St" }))
      .toBe(`${EDITOR_ROOT}/2026-10 October/02/123 Example St`);
  });

  it("validates literal civil dates and exact path segments", () => {
    expect(isValidShootDate("2026-02-29")).toBe(false);
    expect(isValidShootDate("2026-09-31")).toBe(false);
    expect(isValidShootDate("2026-9-01")).toBe(false);
    expect(() => editorFolderPath({ shootDate: "2026-10-02", projectFolderName: "../escape" })).toThrow();
    expect(deriveEditorProjectFolderName("/Tonomo/Raw Files/123 Example St/Listing Images")).toBe("123 Example St");
    expect(deriveEditorProjectFolderName("/Tonomo/Raw Files/123 Example St/LISTING IMAGES")).toBe("123 Example St");
    expect(() => deriveEditorProjectFolderName("/Tonomo/Raw Files/../escape")).toThrow();
  });
});

type DropboxFolder = {
  ".tag": "folder";
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
};

function folder(path: string, id: string): DropboxFolder {
  return {
    ".tag": "folder",
    id,
    name: path.split("/").at(-1)!,
    path_lower: path.toLowerCase(),
    path_display: path,
  };
}

async function fixture(shootDate = "2026-10-02") {
  const suffix = crypto.randomUUID();
  const connectionId = `connection-${suffix}`;
  const userId = `photographer-${suffix}`;
  const projectId = `project-${suffix}`;
  const rawFolderPath = `/Tonomo/Raw Files/Studio/${suffix}/Listing Images`;
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Photographer', ?, 1, 'photographer', 1, ?, ?)").bind(userId, `${suffix}@test.invalid`, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, '123 Example St', ?, 'awaiting_raw', ?, ?, ?)").bind(projectId, shootDate, rawFolderPath, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(`membership-${suffix}`, projectId, userId, now),
  ]);
  return { connectionId, projectId, rawFolderPath, suffix, userId };
}

function dependencies(data: Awaited<ReturnType<typeof fixture>>, options: {
  rootExists?: boolean;
  inputConflict?: boolean;
  failOutputOnce?: { value: boolean };
}) {
  const created: string[] = [];
  const metadata = new Map<string, DropboxFolder>();
  const rootPath = editorFolderPath({ shootDate: "2026-10-02", projectFolderName: data.suffix });
  const inputPath = editorFolderChildPath(rootPath, EDITOR_INPUT_FOLDER);
  const outputPath = editorFolderChildPath(rootPath, EDITOR_OUTPUT_FOLDER);
  const notesPath = editorFolderChildPath(rootPath, EDITOR_NOTES_FOLDER);
  metadata.set(data.rawFolderPath, folder(data.rawFolderPath, `id:raw-${data.suffix}`));
  if (options.rootExists) metadata.set(rootPath, folder(rootPath, `id:root-existing-${data.suffix}`));
  const getMetadata = async (_env: unknown, _db: typeof db, path: string) => {
    const value = metadata.get(path);
    if (!value) throw new Error("Dropbox path/not_found");
    return value;
  };
  const createFolder = async (_env: unknown, _db: typeof db, path: string) => {
    created.push(path);
  };
  const createFolderStrict = async (_env: unknown, _db: typeof db, path: string) => {
    if (options.inputConflict && path === inputPath) {
      throw new Error("Dropbox /files/create_folder_v2 failed (409): path/conflict");
    }
    if (options.failOutputOnce?.value && path === outputPath) {
      options.failOutputOnce.value = false;
      throw new Error("Dropbox network timeout");
    }
    const value = folder(path, `id:${path === rootPath ? "root" : path.split("/").at(-1)!.toLowerCase()}-${data.suffix}`);
    metadata.set(path, value);
    return value;
  };
  if (options.inputConflict) metadata.set(inputPath, folder(inputPath, `id:input-existing-${data.suffix}`));
  return {
    created,
    metadata,
    getMetadata,
    createFolder,
    createFolderStrict,
    canonicalDropboxConnectionId: async () => data.connectionId,
    now: () => new Date("2026-10-02T00:00:00.000Z"),
  };
}

describe("Editor folder reconciliation", () => {
  it("does not scaffold an unassigned Project", async () => {
    const data = await fixture();
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ?").bind(data.projectId).run();
    const ops = dependencies(data, {});
    expect(await reconcileEditorFolder(env as never, data.projectId, { db, ...ops })).toBeNull();
    expect(ops.created).toEqual([]);
  });

  it("keeps the claimed folder after a reschedule and says on the job that it was not moved", async () => {
    const data = await fixture();
    const ops = dependencies(data, {});
    const first = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(data.projectId).run();
    const again = await reconcileEditorFolderOutcome(env as never, data.projectId, { db, ...ops });
    expect(again).toMatchObject({ status: "skipped", reason: "editor_folder_not_moved", mapping: { state: "ready", rootPath: first?.rootPath, shootDate: "2026-10-02" } });
    expect(editorReconcileNote(again)).toBe(`editor_folder_not_moved: Shoot date changed from 2026-10-02 to 2027-01-15; the Editor tree is still at ${first?.rootPath}. Moving it lands with the reschedule-move change; until then move the folder by hand and link the new path if the day matters`);
    expect(ops.created).toHaveLength(2);
    // The same date again is a plain ready tree, and a date that is not a calendar date says nothing.
    await database.DB.prepare("UPDATE projects SET shoot_date = '2026-10-02' WHERE id = ?").bind(data.projectId).run();
    expect(await reconcileEditorFolderOutcome(env as never, data.projectId, { db, ...ops })).toMatchObject({ status: "mapped" });
    await database.DB.prepare("UPDATE projects SET shoot_date = 'Thursday, 15 Jan, 2027' WHERE id = ?").bind(data.projectId).run();
    expect(await reconcileEditorFolderOutcome(env as never, data.projectId, { db, ...ops })).toMatchObject({ status: "mapped" });
  });

  it("leaves a hand-linked root alone after a reschedule", async () => {
    const data = await fixture("2026-09-01");
    const rootPath = `${EDITOR_ROOT}/${editorMonthFolderName("2026-09-01")}/${editorDayFolderName("2026-09-01")}/Legacy ${data.suffix}`;
    const ops = dependencies(data, {});
    const linked = await linkExistingEditorFolder(db, {
      projectId: data.projectId, connectionId: data.connectionId, rootPath, shootDate: "2026-09-01", reviewed: true, reviewedBy: data.userId,
      rootFolder: folder(rootPath, `id:legacy-${data.suffix}`),
      inputRoots: [{ path: `${rootPath}/0. Input`, section: null, folderId: "id:input", metadata: folder(`${rootPath}/0. Input`, "id:input") }],
      outputRoots: [{ path: `${rootPath}/1. Output`, section: null, folderId: "id:output", metadata: folder(`${rootPath}/1. Output`, "id:output") }],
    });
    expect(linked.state).toBe("ready");
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(data.projectId).run();
    expect(await reconcileEditorFolderOutcome(env as never, data.projectId, { db, ...ops })).toMatchObject({ status: "mapped", mapping: { rootPath } });
  });

  it("re-points a reserved tree that created nothing at the new day folder, and marks a held new root for review", async () => {
    const data = await fixture();
    const ops = dependencies(data, {});
    const reserved = await reserveEditorFolderMapping(db, { projectId: data.projectId, connectionId: data.connectionId, shootDate: "2026-10-02", projectFolderName: data.suffix });
    expect(reserved.state).toBe("pending");
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(data.projectId).run();
    const outcome = await reconcileEditorFolderOutcome(env as never, data.projectId, { db, ...ops });
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: data.suffix });
    expect(outcome).toMatchObject({ status: "mapped", mapping: { state: "ready", shootDate: "2027-01-15", rootPath: newRoot, editingNotesPath: editorFolderChildPath(newRoot, EDITOR_NOTES_FOLDER) } });
    expect((outcome as { mapping: { recoveryProof: { diagnostics: string[] } } }).mapping.recoveryProof.diagnostics.at(-1)).toBe(`Retargeted from ${reserved.rootPath} to ${newRoot} after the shoot date changed to 2027-01-15`);
    expect(ops.created).toEqual([newRoot.split("/").slice(0, -2).join("/"), newRoot.split("/").slice(0, -1).join("/")]);
    expect((await getEditorFolderMapping(db, data.projectId))?.rootPathKey).toBe(newRoot.toLowerCase());

    const other = await fixture();
    const otherOps = dependencies(other, {});
    const held = await reserveEditorFolderMapping(db, { projectId: other.projectId, connectionId: other.connectionId, shootDate: "2026-10-02", projectFolderName: other.suffix });
    const squatter = await fixture();
    await reserveEditorFolderMapping(db, { projectId: squatter.projectId, connectionId: other.connectionId, shootDate: "2027-01-15", projectFolderName: other.suffix });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(other.projectId).run();
    const conflict = await reconcileEditorFolderOutcome(env as never, other.projectId, { db, ...otherOps });
    expect(conflict).toMatchObject({ status: "needs_review", reason: "Editor root for the new shoot date is already mapped to another Project", mapping: { id: held.id, rootPath: held.rootPath, shootDate: "2026-10-02" } });
    expect(otherOps.created).toEqual([]);
  });

  it("tells a lost retarget fence and a started tree apart from a held root", async () => {
    const data = await fixture();
    const reserved = await reserveEditorFolderMapping(db, { projectId: data.projectId, connectionId: data.connectionId, shootDate: "2026-10-02", projectFolderName: data.suffix });
    const lease = await acquireEditorFolderProvisionLease(db, reserved.id);
    expect(await retargetPendingEditorFolderMapping(db, reserved.id, { shootDate: "2027-01-15", leaseToken: "not-the-lease" })).toEqual({ status: "stale" });
    expect((await getEditorFolderMapping(db, data.projectId))?.shootDate).toBe("2026-10-02");
    await recordEditorFolderProvision(db, reserved.id, { role: "root", path: reserved.rootPath, folderId: `id:root-${data.suffix}`, leaseToken: lease!.token });
    expect(await retargetPendingEditorFolderMapping(db, reserved.id, { shootDate: "2027-01-15", leaseToken: lease!.token })).toEqual({ status: "started" });
  });

  it("fences concurrent provisioning and reserves a path for only one Project", async () => {
    const first = await fixture();
    const second = await fixture();
    const input = { projectId: first.projectId, connectionId: first.connectionId, shootDate: "2026-10-02", projectFolderName: first.suffix };
    const reserved = await reserveEditorFolderMapping(db, input);
    expect(await acquireEditorFolderProvisionLease(db, reserved.id)).not.toBeNull();
    expect(await acquireEditorFolderProvisionLease(db, reserved.id)).toBeNull();
    await expect(reserveEditorFolderMapping(db, { ...input, projectId: second.projectId })).rejects.toThrow(/already mapped/);
  });

  it("links reviewed legacy roots using exact folder identity without a create", async () => {
    const data = await fixture("2026-09-01");
    const rootPath = editorFolderPath({ shootDate: "2026-09-01", projectFolderName: data.suffix });
    const inputPath = `${rootPath}/0. Input`;
    const outputPath = `${rootPath}/1. Output`;
    const linked = await linkExistingEditorFolder(db, {
      projectId: data.projectId, connectionId: data.connectionId, rootPath, shootDate: "2026-09-01", reviewed: true, reviewedBy: data.userId,
      rootFolder: folder(rootPath, "id:verified-root"),
      inputRoots: [{ path: inputPath, section: null, folderId: "id:input", metadata: folder(inputPath, "id:input") }],
      outputRoots: [{ path: outputPath, section: null, folderId: "id:output", metadata: folder(outputPath, "id:output") }],
    });
    expect(linked.state).toBe("ready");
    expect(linked.inputRoots[0]?.path).toBe(inputPath);
    expect(linked.reviewedBy).toBe(data.userId);
  });

  it("allows a reviewed alternate for an uncreated reservation but freezes an established root", async () => {
    const data = await fixture();
    await reserveEditorFolderMapping(db, { projectId: data.projectId, connectionId: data.connectionId, shootDate: "2026-10-02", projectFolderName: data.suffix });
    const reviewed = (rootPath: string) => ({
      projectId: data.projectId, connectionId: data.connectionId, rootPath, shootDate: "2026-10-02", reviewed: true as const, reviewedBy: data.userId,
      rootFolder: folder(rootPath, "id:established"),
      inputRoots: [{ path: `${rootPath}/Input`, section: null, folderId: "id:input", metadata: folder(`${rootPath}/Input`, "id:input") }],
      outputRoots: [{ path: `${rootPath}/Output`, section: null, folderId: "id:output", metadata: folder(`${rootPath}/Output`, "id:output") }],
    });
    const legacy = `${EDITOR_ROOT}/09. September/30/${data.suffix}`;
    const linked = await linkExistingEditorFolder(db, reviewed(legacy));
    expect(linked.rootPath).toBe(legacy);
    const swapped = reviewed(legacy);
    swapped.inputRoots = [{ path: `${legacy}/0. Input`, section: null, folderId: "id:replacement", metadata: folder(`${legacy}/0. Input`, "id:replacement") }];
    await expect(linkExistingEditorFolder(db, swapped)).rejects.toThrow(/I\/O roots replaced/);
    await expect(linkExistingEditorFolder(db, reviewed(`${EDITOR_ROOT}/2026-10 October/03/${data.suffix}`))).rejects.toThrow(/cannot be moved/);
  });

  it("rejects a reviewed link when the Project snapshot changed before commit", async () => {
    const data = await fixture();
    const rootPath = editorFolderPath({ shootDate: "2026-10-02", projectFolderName: data.suffix });
    await expect(linkExistingEditorFolder(db, {
      projectId: data.projectId, connectionId: data.connectionId, rootPath, shootDate: "2026-10-02", reviewed: true, reviewedBy: data.userId,
      expectedProjectSnapshot: { shootDate: "2026-10-01", rawFolderPath: data.rawFolderPath, rawFolderLink: null },
      rootFolder: folder(rootPath, "id:review-root"),
      inputRoots: [{ path: `${rootPath}/Input`, section: null, folderId: "id:input", metadata: folder(`${rootPath}/Input`, "id:input") }],
      outputRoots: [{ path: `${rootPath}/Output`, section: null, folderId: "id:output", metadata: folder(`${rootPath}/Output`, "id:output") }],
    })).rejects.toThrow(/not persisted/);
    expect(await getEditorFolderMapping(db, data.projectId)).toBeNull();
  });

  it("creates the owned project tree and records explicit Input/Output roots", async () => {
    const data = await fixture();
    const ops = dependencies(data, {});
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(mapping?.state).toBe("ready");
    expect(ops.created).toEqual([
      "/Editor/01_ACTIVE EDITS/2026-10 October",
      "/Editor/01_ACTIVE EDITS/2026-10 October/02",
    ]);
    expect(mapping?.rootFolderId).toMatch(/^id:root-/);
    expect(mapping?.inputRoots).toHaveLength(1);
    expect(mapping?.outputRoots).toHaveLength(1);
    expect(mapping?.inputRoots[0]?.path.endsWith("/0. Input")).toBe(true);
    expect(mapping?.outputRoots[0]?.path.endsWith("/1. Output")).toBe(true);
    expect(mapping?.editingNotesFolderId).toMatch(/^id:editing notes-/);
  });

  it("marks an existing project-root conflict for review without adopting it", async () => {
    const data = await fixture();
    const ops = dependencies(data, { rootExists: true });
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(mapping?.state).toBe("needs_review");
    expect(mapping?.rootFolderId).toBeNull();
    expect(ops.created).toHaveLength(2);
    expect(mapping?.recoveryProof?.conflict?.role).toBe("root");
  });

  it("resumes a partial tree after a transient child failure", async () => {
    const data = await fixture();
    const failOutputOnce = { value: true };
    const ops = dependencies(data, { failOutputOnce });
    await expect(reconcileEditorFolder(env as never, data.projectId, { db, ...ops })).rejects.toThrow("network timeout");
    const pending = await getEditorFolderMapping(db, data.projectId);
    expect(pending?.state).toBe("pending");
    expect(pending?.rootFolderId).toMatch(/^id:root-/);
    expect(pending?.inputRoots[0]?.folderId).toMatch(/^id:0\. input-/);
    const resumed = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(resumed?.state).toBe("ready");
  });

  it("resumes a tree that recorded a plain Input child before the numbered names, without a numbered sibling", async () => {
    const data = await fixture();
    const ops = dependencies(data, {});
    const rootPath = editorFolderPath({ shootDate: "2026-10-02", projectFolderName: data.suffix });
    const legacyInputPath = `${rootPath}/Input`;
    const reserved = await reserveEditorFolderMapping(db, { projectId: data.projectId, connectionId: data.connectionId, shootDate: "2026-10-02", projectFolderName: data.suffix });
    await recordEditorFolderProvision(db, reserved.id, { role: "root", path: rootPath, folderId: "id:root-legacy" });
    await recordEditorFolderProvision(db, reserved.id, { role: "input", path: legacyInputPath, folderId: "id:input-legacy" });
    ops.metadata.set(rootPath, folder(rootPath, "id:root-legacy"));
    ops.metadata.set(legacyInputPath, folder(legacyInputPath, "id:input-legacy"));

    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(mapping?.state).toBe("ready");
    expect(mapping?.inputRoots).toEqual([{ path: legacyInputPath, section: null, folderId: "id:input-legacy" }]);
    expect(mapping?.outputRoots[0]?.path).toBe(`${rootPath}/1. Output`);
    expect(ops.metadata.has(`${rootPath}/0. Input`)).toBe(false);
    expect(mapping?.recoveryProof?.created.find((entry) => entry.role === "input")?.folderId).toBe("id:input-legacy");
  });

  it("adopts an exact child conflict only below a claimed root", async () => {
    const data = await fixture();
    const ops = dependencies(data, { inputConflict: true });
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(mapping?.state).toBe("ready");
    expect(mapping?.inputRoots[0]?.folderId).toBe(`id:input-existing-${data.suffix}`);
    expect(mapping?.recoveryProof?.created.find((entry) => entry.role === "input")?.method).toBe("verified_existing_child");
  });
});

describe("Editor folder reconciliation when the Tonomo RAW folder is missing", () => {
  const STORED = "/tonomo/raw files/igor melo/04-09-2026/72 victoria st, paddington nsw 2021, australia";
  const MOVED = "/tonomo/raw files/christian quinlan/15-09-2026/72 victoria st, paddington nsw 2021, australia";
  const MOVED_DISPLAY = "/Tonomo/Raw Files/Christian Quinlan/15-09-2026/72 Victoria St, Paddington NSW 2021, Australia";

  async function missingFixture(options: { link?: string | null; orderId?: string | null; formattedAddress?: string | null; storedPath?: string } = {}) {
    const data = await fixture();
    const storedPath = options.storedPath ?? STORED;
    const orderId = options.orderId === undefined ? `order-${data.suffix}` : options.orderId;
    await database.DB.prepare("UPDATE projects SET raw_folder_path = ?, raw_folder_link = ?, order_id = ?, street = '72 Victoria Street', suburb = 'Paddington' WHERE id = ?")
      .bind(storedPath, options.link ?? null, orderId, data.projectId).run();
    if (orderId && options.formattedAddress) {
      await database.DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'processed', ?)")
        .bind(crypto.randomUUID(), `event-${data.suffix}`, JSON.stringify({ id: orderId, street: "72 Victoria Street", property_address: { formatted_address: options.formattedAddress } }), Date.now()).run();
    }
    const ops = dependencies({ ...data, rawFolderPath: storedPath }, {});
    ops.metadata.delete(storedPath);
    return { data, ops, storedPath };
  }

  function rootFor(name: string) {
    return editorFolderPath({ shootDate: "2026-10-02", projectFolderName: name });
  }

  it("re-points the Project at the folder the RAW shared link now finds under the RAW root, scans it, and leaves the tree to the next pass", async () => {
    const { data, ops, storedPath } = await missingFixture({ link: "https://www.dropbox.com/scl/fo/abc/xyz" });
    ops.metadata.set(MOVED, { ".tag": "folder", id: `id:moved-${data.suffix}`, name: "72 Victoria St, Paddington NSW 2021, Australia", path_lower: MOVED, path_display: MOVED_DISPLAY });
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops, resolveRawFolderPath: async () => MOVED });
    // A ready tree would take RAW intake away from the recovered folder before the queued sync reads it.
    expect(mapping).toBeNull();
    expect(ops.created).toHaveLength(0);
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(data.projectId).first()).toEqual({ raw_folder_path: MOVED });
    const audit = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE target_id = ? AND action = 'project.raw_folder_path.changed'").bind(data.projectId).first<{ meta_json: string }>();
    expect(JSON.parse(audit!.meta_json)).toMatchObject({ actor: "editor_scaffold", previousRawFolderPath: storedPath, rawFolderPath: MOVED });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM jobs WHERE project_id = ? AND kind = 'dropbox_sync'").bind(data.projectId).first()).toEqual({ count: 1 });

    // The test runtime consumes that queue message in-process, so settle the job explicitly (the
    // in-flight deferral itself is covered below); the stored path is now a plain Tonomo folder.
    await database.DB.prepare("UPDATE jobs SET status = 'done' WHERE project_id = ? AND kind = 'dropbox_sync'").bind(data.projectId).run();
    const next = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops, resolveRawFolderPath: async () => MOVED });
    expect(next?.state).toBe("ready");
    expect(next?.projectFolderName).toBe("72 Victoria St, Paddington NSW 2021, Australia");
    expect(next?.tonomoRawFolderPath).toBe(MOVED);
    expect(next?.photographerEvidence).toMatchObject({ rawSource: "tonomo", nameSource: "tonomo_path_display", tonomoFolderId: `id:moved-${data.suffix}` });
  });

  it("does not provision a reserved tree while a RAW sync for the project is queued or running", async () => {
    const data = await fixture();
    const jobId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'dropbox_sync', 'running', ?, ?, ?)")
      .bind(jobId, data.projectId, Date.now(), Date.now()).run();
    const ops = dependencies(data, {});
    const deferred = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(deferred?.state).toBe("pending");
    expect(ops.created).toHaveLength(0);
    // A job untouched for hours is stuck, not in flight, and must not block the tree forever.
    await database.DB.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").bind(Date.now() - 3 * 60 * 60 * 1000, jobId).run();
    expect((await reconcileEditorFolder(env as never, data.projectId, { db, ...ops }))?.state).toBe("ready");
  });

  it("never adopts a link that resolves to the Tonomo RAW root itself", async () => {
    const { data, ops, storedPath } = await missingFixture({ link: "https://www.dropbox.com/scl/fo/abc/xyz", storedPath: "/tonomo/raw files/igor melo/04-09-2026/raw files" });
    const root = "/tonomo/raw files";
    ops.metadata.set(root, { ".tag": "folder", id: `id:root-${data.suffix}`, name: "Raw Files", path_lower: root, path_display: "/Tonomo/Raw Files" });
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops, resolveRawFolderPath: async () => root });
    expect(mapping).toBeNull();
    expect(ops.created).toHaveLength(0);
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(data.projectId).first()).toEqual({ raw_folder_path: storedPath });
  });

  it("does not create a tree for a delivered Project whose RAW folder is gone", async () => {
    const { data, ops } = await missingFixture({ link: null, orderId: null });
    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(data.projectId).run();
    expect(await reconcileEditorFolder(env as never, data.projectId, { db, ...ops })).toBeNull();
    expect(ops.created).toHaveLength(0);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM editor_folder_mappings WHERE project_id = ?").bind(data.projectId).first()).toEqual({ count: 0 });
  });

  it("does not adopt a link-resolved folder whose address leaf differs from the stored path", async () => {
    const { data, ops, storedPath } = await missingFixture({ link: "https://www.dropbox.com/scl/fo/abc/xyz" });
    const other = "/tonomo/raw files/christian quinlan/15-09-2026/74 victoria st, paddington nsw 2021, australia";
    ops.metadata.set(other, { ".tag": "folder", id: `id:other-${data.suffix}`, name: "74 victoria st", path_lower: other, path_display: other });
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops, resolveRawFolderPath: async () => other });
    expect(mapping).toBeNull();
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(data.projectId).first()).toEqual({ raw_folder_path: storedPath });
  });

  it("treats a transient failure while resolving the link as an error, not as a missing folder", async () => {
    const { data, ops } = await missingFixture({ link: "https://www.dropbox.com/scl/fo/abc/xyz", formattedAddress: "72 Victoria St, Paddington NSW 2021, Australia" });
    await expect(reconcileEditorFolder(env as never, data.projectId, { db, ...ops, resolveRawFolderPath: async () => { throw new Error("Dropbox shared-link resolution failed; the Dropbox sharing.read scope may be missing: 503"); } }))
      .rejects.toThrow(/503/);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM editor_folder_mappings WHERE project_id = ?").bind(data.projectId).first()).toEqual({ count: 0 });
  });

  it("reports and never adopts a RAW folder the link finds outside the Tonomo RAW root", async () => {
    const { data, ops, storedPath } = await missingFixture({ link: "https://www.dropbox.com/scl/fo/abc/xyz" });
    const archived = "/archive/2026/72 victoria st, paddington nsw 2021, australia";
    ops.metadata.set(archived, { ".tag": "folder", id: `id:archived-${data.suffix}`, name: "72 victoria st", path_lower: archived, path_display: archived });
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops, resolveRawFolderPath: async () => archived });
    expect(mapping).toBeNull();
    expect(ops.created).toHaveLength(0);
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(data.projectId).first()).toEqual({ raw_folder_path: storedPath });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM editor_folder_mappings WHERE project_id = ?").bind(data.projectId).first()).toEqual({ count: 0 });
  });

  it("creates the tree from Tonomo's original-cased formatted address when the folder is gone", async () => {
    const { data, ops, storedPath } = await missingFixture({ link: "https://www.dropbox.com/scl/fo/abc/xyz", formattedAddress: "72 Victoria St, Paddington NSW 2021, Australia" });
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops, resolveRawFolderPath: async () => { throw new Error("Dropbox shared-link resolution failed: path/not_found"); } });
    expect(mapping?.state).toBe("ready");
    expect(mapping?.projectFolderName).toBe("72 Victoria St, Paddington NSW 2021, Australia");
    expect(mapping?.rootPath).toBe(rootFor("72 Victoria St, Paddington NSW 2021, Australia"));
    expect(mapping?.tonomoRawFolderPath).toBe(storedPath);
    expect(mapping?.photographerEvidence).toMatchObject({ rawSource: "missing", nameSource: "tonomo_formatted_address" });
    expect((mapping?.photographerEvidence as { tonomoFolderId?: string }).tonomoFolderId).toBeUndefined();
    expect(mapping?.inputRoots[0]?.path.endsWith("/0. Input")).toBe(true);
    expect(await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(data.projectId).first()).toEqual({ raw_folder_path: storedPath });
  });

  it("reads the formatted address from Tonomo's array-wrapped and changed-envelope payloads", async () => {
    const { data, ops } = await missingFixture({ link: null });
    const orderId = `order-${data.suffix}`;
    const insert = (payload: unknown, receivedAt: number) => database.DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'processed', ?)")
      .bind(crypto.randomUUID(), crypto.randomUUID(), JSON.stringify(payload), receivedAt).run();
    await insert([{ order_id: orderId, property_address: { formatted_address: "72 Victoria St, Paddington NSW 2021, Australia" } }], Date.now() - 2000);
    await insert([{ action: "changed", orderId, order: { orderId, property_address: { formatted_address: "72 Victoria St, Paddington NSW 2021, Australia" } } }], Date.now() - 1000);
    await insert({ id: "other-order", property_address: { formatted_address: "1 Elsewhere St, Bondi NSW 2026, Australia" } }, Date.now());
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(mapping?.state).toBe("ready");
    expect(mapping?.projectFolderName).toBe("72 Victoria St, Paddington NSW 2021, Australia");
    expect(mapping?.photographerEvidence).toMatchObject({ rawSource: "missing", nameSource: "tonomo_formatted_address" });
  });

  it("names each way the RAW identity stops a tree", async () => {
    const outside = "/archive/2026/72 victoria st, paddington nsw 2021, australia";
    const other = "/tonomo/raw files/christian quinlan/15-09-2026/74 victoria st, paddington nsw 2021, australia";
    const { data: a, ops: opsA } = await missingFixture({ link: "https://www.dropbox.com/scl/fo/abc/xyz" });
    opsA.metadata.set(outside, { ".tag": "folder", id: `id:a-${a.suffix}`, name: "72 victoria st", path_lower: outside, path_display: "/Archive/2026/72 Victoria St, Paddington NSW 2021, Australia" });
    const outsideRoot = await reconcileEditorFolderOutcome(env as never, a.projectId, { db, ...opsA, resolveRawFolderPath: async () => outside });
    expect(outsideRoot).toMatchObject({ status: "skipped", reason: "raw_outside_root", mapping: null });
    expect((outsideRoot as { detail: string }).detail).toContain("/Archive/2026/72 Victoria St, Paddington NSW 2021, Australia");
    expect((outsideRoot as { detail: string }).detail).toContain("completed and delivered outside the Portal");

    const { data: b, ops: opsB } = await missingFixture({ link: "https://www.dropbox.com/scl/fo/abc/xyz" });
    opsB.metadata.set(other, { ".tag": "folder", id: `id:b-${b.suffix}`, name: "74 victoria st", path_lower: other, path_display: other });
    expect(await reconcileEditorFolderOutcome(env as never, b.projectId, { db, ...opsB, resolveRawFolderPath: async () => other })).toMatchObject({ status: "skipped", reason: "raw_leaf_mismatch" });

    const { data: c, ops: opsC } = await missingFixture({ link: "https://www.dropbox.com/scl/fo/abc/xyz" });
    opsC.metadata.set(MOVED, { ".tag": "folder", id: `id:c-${c.suffix}`, name: "72 Victoria St, Paddington NSW 2021, Australia", path_lower: MOVED, path_display: MOVED_DISPLAY });
    expect(await reconcileEditorFolderOutcome(env as never, c.projectId, { db, ...opsC, resolveRawFolderPath: async () => MOVED })).toMatchObject({ status: "skipped", reason: "raw_path_recovered" });

  });

  it("names each missing Project prerequisite", async () => {
    const d = await fixture();
    await database.DB.prepare("UPDATE projects SET shoot_date = NULL WHERE id = ?").bind(d.projectId).run();
    expect(await reconcileEditorFolderOutcome(env as never, d.projectId, { db, ...dependencies(d, {}) })).toMatchObject({ status: "skipped", reason: "no_shoot_date" });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2026-10-02' WHERE id = ?").bind(d.projectId).run();
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ?").bind(d.projectId).run();
    expect(await reconcileEditorFolderOutcome(env as never, d.projectId, { db, ...dependencies(d, {}) })).toMatchObject({ status: "skipped", reason: "no_active_photographer" });
    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(d.projectId).run();
    expect(await reconcileEditorFolderOutcome(env as never, d.projectId, { db, ...dependencies(d, {}) })).toMatchObject({ status: "skipped", reason: "project_inactive" });

  });

  it("reports deferrals, conflicts and success as their own outcomes", async () => {
    const e = await fixture();
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'dropbox_sync', 'queued', ?, ?, ?)").bind(crypto.randomUUID(), e.projectId, Date.now(), Date.now()).run();
    const inFlight = await reconcileEditorFolderOutcome(env as never, e.projectId, { db, ...dependencies(e, {}) });
    expect(inFlight).toMatchObject({ status: "skipped", reason: "raw_sync_in_flight" });
    expect((inFlight as { mapping: { state: string } }).mapping.state).toBe("pending");

    const f = await fixture();
    const conflict = await reconcileEditorFolderOutcome(env as never, f.projectId, { db, ...dependencies(f, { rootExists: true }) });
    expect(conflict).toMatchObject({ status: "needs_review" });
    expect((conflict as { reason: string }).reason).toMatch(/operator review/);
    expect((conflict as { mapping: { state: string } }).mapping.state).toBe("needs_review");

    const g = await fixture();
    expect(await reconcileEditorFolderOutcome(env as never, g.projectId, { db, ...dependencies(g, {}) })).toMatchObject({ status: "mapped", mapping: { state: "ready" } });
  });

  it("falls back to the Project's own address when no Tonomo payload is stored", async () => {
    const { data, ops } = await missingFixture({ link: null, orderId: null });
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(mapping?.state).toBe("ready");
    expect(mapping?.projectFolderName).toBe("72 Victoria Street, Paddington");
    expect(mapping?.photographerEvidence).toMatchObject({ rawSource: "missing", nameSource: "project_address" });
  });
});

describe("editor_reconcile queue consumer", () => {
  async function job(projectId: string) {
    const id = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'editor_reconcile', 'queued', ?, ?, ?)").bind(id, projectId, Date.now(), Date.now()).run();
    return id;
  }
  const jobRow = (id: string) => database.DB.prepare("SELECT status, error FROM jobs WHERE id = ?").bind(id).first<{ status: string; error: string | null }>();

  it("formats every non-ready outcome as a prefixed note and nothing for a ready tree", () => {
    const mapping = { state: "ready" } as never;
    expect(editorReconcileNote({ status: "mapped", mapping })).toBeUndefined();
    expect(editorReconcileNote({ status: "needs_review", mapping, reason: "An existing Dropbox project folder requires explicit operator review" })).toBe("needs_review: An existing Dropbox project folder requires explicit operator review");
    expect(editorReconcileNote({ status: "skipped", mapping: null, reason: "raw_outside_root", detail: "RAW folder now lives elsewhere" })).toBe("raw_outside_root: RAW folder now lives elsewhere");
  });

  it("records why a pass created no tree on a done job, and keeps failures and disabled automation as failed", async () => {
    const data = await fixture();
    await database.DB.prepare("UPDATE projects SET shoot_date = NULL WHERE id = ?").bind(data.projectId).run();
    const skipped = await job(data.projectId);
    await handleEditorReconcileMessage(env as never, { projectId: data.projectId, jobId: skipped });
    expect(await jobRow(skipped)).toEqual({ status: "done", error: "no_shoot_date: Project has no shoot date" });

    const tooOld = await job(data.projectId);
    await handleEditorReconcileMessage({ ...(env as object), EDITOR_AUTOCREATE_AFTER_MS: String(Date.now() + 86_400_000) } as never, { projectId: data.projectId, jobId: tooOld });
    expect((await jobRow(tooOld))?.status).toBe("done");
    expect((await jobRow(tooOld))?.error).toMatch(/^autocreate_not_allowed:/);

    const disabled = await job(data.projectId);
    await handleEditorReconcileMessage({ ...(env as object), DROPBOX_EDITOR_AUTOMATION_ENABLED: "0" } as never, { projectId: data.projectId, jobId: disabled });
    expect(await jobRow(disabled)).toEqual({ status: "failed", error: "Editor automation is disabled" });
  });
});
