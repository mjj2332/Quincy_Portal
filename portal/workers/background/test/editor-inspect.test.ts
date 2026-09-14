import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/dropbox/client", () => ({
  getMetadata: vi.fn(),
  listFolder: vi.fn(),
  listFolderContinue: vi.fn(),
  getSharedLinkMetadata: vi.fn(),
}));

import type { Env } from "../src/env";
import { getMetadata, getSharedLinkMetadata, listFolder, listFolderContinue, type DropboxFolder } from "../src/dropbox/client";
import { derivedEditorRootPath, discoverEditorCandidate, inspectEditorCandidate, previewEditorBackfill } from "../src/editor-folders/backfill";
import { EDITOR_ROOT, editorFolderPathKey } from "../src/editor-folders/paths";

declare const __PORTAL_MIGRATION_SQL__: string;

const bindings = env as unknown as { DB: D1Database };

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const statements = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (const statement of statements) await bindings.DB.exec(`${statement};`);
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
});

beforeEach(() => {
  vi.clearAllMocks();
});

function localEnv(): Env {
  return { DB: bindings.DB } as unknown as Env;
}

const SHOOT_DATE = "2026-09-11";
const RAW_FOLDER_PATH = "/tonomo/raw files/x/11-09-2026/22-16-18 rosemont ave, woollahra nsw 2025, australia";
const RAW_LEAF = "22-16-18 rosemont ave, woollahra nsw 2025, australia";

type Fixture = { projectId: string; connectionId: string; shootDate: string; rawFolderPath: string | null };

async function fixture(overrides: { shootDate?: string; rawFolderPath?: string | null; rawFolderLink?: string | null } = {}): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const connectionId = `connection-${suffix}`;
  const projectId = `project-${suffix}`;
  const shootDate = overrides.shootDate ?? SHOOT_DATE;
  const rawFolderPath = overrides.rawFolderPath === undefined ? RAW_FOLDER_PATH : overrides.rawFolderPath;
  const rawFolderLink = overrides.rawFolderLink ?? null;
  const now = Date.now();
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    bindings.DB.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, raw_folder_path, raw_folder_link, created_at, updated_at) VALUES (?, '123 Example St', ?, 'awaiting_raw', ?, ?, ?, ?)")
      .bind(projectId, shootDate, rawFolderPath, rawFolderLink, now, now),
  ]);
  return { projectId, connectionId, shootDate, rawFolderPath };
}

type FolderSpec = { name: string; id?: string };

/** Wires the mocked Dropbox client so `getMetadata` resolves exactly `root.path` and `listFolder`
 * resolves the children registered for a path (keyed case-insensitively, like Dropbox itself). */
function configureDropbox(root: { path: string; id: string; pathLowerOverride?: string }, childrenByPath: Record<string, FolderSpec[]>): void {
  const rootFolder: DropboxFolder = {
    ".tag": "folder",
    id: root.id,
    name: root.path.split("/").at(-1)!,
    path_lower: root.pathLowerOverride ?? root.path.toLowerCase(),
    path_display: root.path,
  };
  const byKey: Record<string, FolderSpec[]> = {};
  for (const [path, specs] of Object.entries(childrenByPath)) byKey[editorFolderPathKey(path)] = specs;
  vi.mocked(getMetadata).mockImplementation(async (_env, _db, path) => {
    if (editorFolderPathKey(path) === editorFolderPathKey(root.path)) return rootFolder;
    throw new Error("Dropbox /files/get_metadata failed (409): path/not_found");
  });
  vi.mocked(listFolder).mockImplementation(async (_env, _db, path) => {
    const specs = byKey[editorFolderPathKey(path)] ?? [];
    return {
      entries: specs.map((spec) => ({
        ".tag": "folder" as const,
        id: spec.id ?? `id:${spec.name}`,
        name: spec.name,
        path_lower: `${path}/${spec.name}`.toLowerCase(),
        path_display: `${path}/${spec.name}`,
      })),
      cursor: "cursor",
      has_more: false,
    };
  });
  vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
}

describe("inspectEditorCandidate", () => {
  it("accepts a reviewed alternate root with plain Input/Output, echoing Dropbox's own path_display", async () => {
    const data = await fixture();
    const properCaseRoot = `${EDITOR_ROOT}/09. September/11/22 16-18 Rosemont Avenue, Woollahra`;
    const requestRoot = `${EDITOR_ROOT}/09. September/11/22 16-18 rosemont avenue, woollahra`;
    configureDropbox({ path: properCaseRoot, id: "id:root" }, {
      [properCaseRoot]: [{ name: "Input" }, { name: "Output" }, { name: "Quincy Edits" }, { name: "extras" }],
    });
    const result = await inspectEditorCandidate(localEnv(), data.projectId, requestRoot);
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") throw new Error("unreachable");
    expect(result.matchesDerived).toBe(false);
    expect(result.derivedRootPath).not.toBeNull();
    expect(result.derivedRootPath?.endsWith(RAW_LEAF)).toBe(true);
    expect(result.candidate.expectedShootDate).toBe("2026-09-11");
    // rootPath comes from Dropbox's path_display, not the caller's request casing.
    expect(result.candidate.rootPath).toBe(properCaseRoot);
    expect(result.candidate.inputRoots).toEqual([{ path: `${requestRoot}/Input`, section: null, folderId: "id:Input" }]);
    expect(result.candidate.outputRoots).toEqual([{ path: `${requestRoot}/Output`, section: null, folderId: "id:Output" }]);
  });

  it("accepts the 0. Input / 1. Output naming variant", async () => {
    const data = await fixture();
    const rootPath = `${EDITOR_ROOT}/09. September/11/22 16-18 Rosemont Avenue, Woollahra`;
    configureDropbox({ path: rootPath, id: "id:root" }, {
      [rootPath]: [{ name: "0. Input" }, { name: "1. Output" }],
    });
    const result = await inspectEditorCandidate(localEnv(), data.projectId, rootPath);
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") throw new Error("unreachable");
    expect(result.candidate.inputRoots).toEqual([{ path: `${rootPath}/0. Input`, section: null, folderId: "id:0. Input" }]);
    expect(result.candidate.outputRoots).toEqual([{ path: `${rootPath}/1. Output`, section: null, folderId: "id:1. Output" }]);
  });

  it("honours Day/Input and Dusk/Input sections alongside a root Output", async () => {
    const data = await fixture();
    const rootPath = `${EDITOR_ROOT}/09. September/11/22 16-18 Rosemont Avenue, Woollahra`;
    configureDropbox({ path: rootPath, id: "id:root" }, {
      [rootPath]: [{ name: "Day" }, { name: "Dusk" }, { name: "Output" }],
      [`${rootPath}/Day`]: [{ name: "Input" }],
      [`${rootPath}/Dusk`]: [{ name: "Input" }],
    });
    const result = await inspectEditorCandidate(localEnv(), data.projectId, rootPath);
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") throw new Error("unreachable");
    expect(result.candidate.outputRoots).toEqual([{ path: `${rootPath}/Output`, section: null, folderId: "id:Output" }]);
    expect(result.candidate.inputRoots).toHaveLength(2);
    expect(result.candidate.inputRoots).toEqual(expect.arrayContaining([
      { path: `${rootPath}/Day/Input`, section: "Day", folderId: "id:Input" },
      { path: `${rootPath}/Dusk/Input`, section: "Dusk", folderId: "id:Input" },
    ]));
  });

  it("rejects a root outside the Editor workspace without calling Dropbox", async () => {
    const data = await fixture();
    const rootPath = "/Editor/_ARCHIVE/2020/09/Old Project";
    const result = await inspectEditorCandidate(localEnv(), data.projectId, rootPath);
    expect(result.status).toBe("needs_review");
    if (result.status !== "needs_review") throw new Error("unreachable");
    expect(result.reason).toBe("Reviewed Editor root must be a project folder under /Editor/01_ACTIVE EDITS");
    expect(getMetadata).not.toHaveBeenCalled();
  });

  it("rejects roots at the wrong depth without calling Dropbox", async () => {
    const data = await fixture();
    const tooShallow = `${EDITOR_ROOT}/09. September/11`;
    const tooDeep = `${EDITOR_ROOT}/09. September/11/Some Project/Extra Segment`;
    for (const rootPath of [tooShallow, tooDeep]) {
      const result = await inspectEditorCandidate(localEnv(), data.projectId, rootPath);
      expect(result.status).toBe("needs_review");
      if (result.status !== "needs_review") throw new Error("unreachable");
      expect(result.reason).toBe("Reviewed Editor root must be a project folder under /Editor/01_ACTIVE EDITS");
    }
    expect(getMetadata).not.toHaveBeenCalled();
    expect(listFolder).not.toHaveBeenCalled();
  });

  it("rejects a Dropbox path_lower mismatch", async () => {
    const data = await fixture();
    const rootPath = `${EDITOR_ROOT}/09. September/11/22 16-18 Rosemont Avenue, Woollahra`;
    configureDropbox({ path: rootPath, id: "id:root", pathLowerOverride: `${EDITOR_ROOT.toLowerCase()}/09. september/11/some other folder` }, {
      [rootPath]: [{ name: "Input" }, { name: "Output" }],
    });
    const result = await inspectEditorCandidate(localEnv(), data.projectId, rootPath);
    expect(result.status).toBe("needs_review");
    if (result.status !== "needs_review") throw new Error("unreachable");
    expect(result.reason).toBe("Exact Project folder could not be verified");
  });

  it("requires a verified Output folder", async () => {
    const data = await fixture();
    const rootPath = `${EDITOR_ROOT}/09. September/11/22 16-18 Rosemont Avenue, Woollahra`;
    configureDropbox({ path: rootPath, id: "id:root" }, {
      [rootPath]: [{ name: "Input" }],
    });
    const result = await inspectEditorCandidate(localEnv(), data.projectId, rootPath);
    expect(result.status).toBe("needs_review");
    if (result.status !== "needs_review") throw new Error("unreachable");
    expect(result.reason).toBe("Verified Input and Output folders are required");
  });

  it("rejects two ambiguous Input variants", async () => {
    const data = await fixture();
    const rootPath = `${EDITOR_ROOT}/09. September/11/22 16-18 Rosemont Avenue, Woollahra`;
    configureDropbox({ path: rootPath, id: "id:root" }, {
      [rootPath]: [{ name: "Input" }, { name: "0. Input" }, { name: "Output" }],
    });
    const result = await inspectEditorCandidate(localEnv(), data.projectId, rootPath);
    expect(result.status).toBe("needs_review");
    if (result.status !== "needs_review") throw new Error("unreachable");
    expect(result.reason).toBe("Ambiguous Input/Output variants require manual review");
  });

  it("rejects an invalid root for a link-only Project without resolving the link", async () => {
    const data = await fixture({ rawFolderPath: null, rawFolderLink: "https://www.dropbox.com/scl/fo/abc123/h?rlkey=x" });
    const result = await inspectEditorCandidate(localEnv(), data.projectId, "/Editor/_ARCHIVE/2020/09/Old Project");
    expect(result.status).toBe("needs_review");
    if (result.status !== "needs_review") throw new Error("unreachable");
    expect(result.reason).toBe("Reviewed Editor root must be a project folder under /Editor/01_ACTIVE EDITS");
    expect(result.derivedRootPath).toBeNull();
    expect(getSharedLinkMetadata).not.toHaveBeenCalled();
    expect(getMetadata).not.toHaveBeenCalled();
    expect(listFolder).not.toHaveBeenCalled();
  });

  it("derives the root from a RAW link that resolves without Dropbox", async () => {
    const data = await fixture({
      rawFolderPath: null,
      rawFolderLink: "https://www.dropbox.com/home/tonomo/raw%20files/x/11-09-2026/22-16-18%20rosemont%20ave%2C%20woollahra%20nsw%202025%2C%20australia",
    });
    const rootPath = `${EDITOR_ROOT}/09. September/11/22 16-18 Rosemont Avenue, Woollahra`;
    configureDropbox({ path: rootPath, id: "id:root" }, {
      [rootPath]: [{ name: "Input" }, { name: "Output" }],
    });
    const result = await inspectEditorCandidate(localEnv(), data.projectId, rootPath);
    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") throw new Error("unreachable");
    expect(result.derivedRootPath).not.toBeNull();
    expect(result.derivedRootPath?.endsWith(RAW_LEAF)).toBe(true);
    expect(getSharedLinkMetadata).not.toHaveBeenCalled();
  });
});

describe("discoverEditorCandidate without an override", () => {
  it("still inspects the derived path", async () => {
    const data = await fixture();
    const derivedRootPath = derivedEditorRootPath(data.shootDate, data.rawFolderPath);
    expect(derivedRootPath).not.toBeNull();
    configureDropbox({ path: derivedRootPath!, id: "id:root" }, {
      [derivedRootPath!]: [{ name: "Input" }, { name: "Output" }],
    });
    await discoverEditorCandidate(localEnv(), data.projectId);
    expect(getMetadata).toHaveBeenCalledWith(expect.anything(), expect.anything(), derivedRootPath, expect.any(String));
  });
});

describe("previewEditorBackfill", () => {
  it("includes derivedRootPath on a needs_review item from a Dropbox conflict", async () => {
    const data = await fixture();
    const derivedRootPath = derivedEditorRootPath(data.shootDate, data.rawFolderPath);
    // An unconfigured mock resolves undefined; force the 409 so the row lands in needs_review.
    vi.mocked(getMetadata).mockRejectedValue(new Error("Dropbox /files/get_metadata failed (409): path/conflict"));
    vi.mocked(listFolder).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
    vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
    const result = await previewEditorBackfill(localEnv());
    const item = result.items.find((entry) => entry.projectId === data.projectId);
    expect(item).toBeDefined();
    expect(item).toMatchObject({ status: "needs_review", derivedRootPath });
  });

  it("preview carries derivedRootPath for a link-only Project when inspection fails", async () => {
    const linkOnlyRawPath = "/tonomo/raw files/x/11-09-2026/22-16-18 rosemont ave, woollahra nsw 2025, australia";
    const data = await fixture({
      rawFolderPath: null,
      rawFolderLink: `https://www.dropbox.com/home/tonomo/raw%20files/x/11-09-2026/${encodeURIComponent(RAW_LEAF)}`,
    });
    const derivedRootPath = derivedEditorRootPath(data.shootDate, linkOnlyRawPath);
    expect(derivedRootPath).not.toBeNull();
    vi.mocked(getMetadata).mockRejectedValue(new Error("Dropbox /files/get_metadata failed (409): path/conflict"));
    vi.mocked(listFolder).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
    vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
    const result = await previewEditorBackfill(localEnv());
    const item = result.items.find((entry) => entry.projectId === data.projectId);
    expect(item).toBeDefined();
    expect(item).toMatchObject({ status: "needs_review", derivedRootPath });
    expect((item as { derivedRootPath: string | null }).derivedRootPath?.endsWith(RAW_LEAF)).toBe(true);
  });
});
