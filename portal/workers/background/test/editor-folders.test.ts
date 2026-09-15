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
import { reconcileEditorFolder } from "../src/editor-folders/scaffold";
import { getEditorFolderMapping, reserveEditorFolderMapping, acquireEditorFolderProvisionLease, linkExistingEditorFolder } from "../src/editor-folders/mapping";

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

  it("keeps the claimed folder after a reschedule", async () => {
    const data = await fixture();
    const ops = dependencies(data, {});
    const first = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(data.projectId).run();
    const again = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(again?.rootPath).toBe(first?.rootPath);
    expect(ops.created).toHaveLength(2);
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

  it("adopts an exact child conflict only below a claimed root", async () => {
    const data = await fixture();
    const ops = dependencies(data, { inputConflict: true });
    const mapping = await reconcileEditorFolder(env as never, data.projectId, { db, ...ops });
    expect(mapping?.state).toBe("ready");
    expect(mapping?.inputRoots[0]?.folderId).toBe(`id:input-existing-${data.suffix}`);
    expect(mapping?.recoveryProof?.created.find((entry) => entry.role === "input")?.method).toBe("verified_existing_child");
  });
});
