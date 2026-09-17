import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminAttentionResponse, EditorFolderAttentionDto } from "@quincy/shared";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiGet: (path: string) => apiGetMock(path) }));

import { AdminAttention } from "./AdminAttention";
import { EditorFolderAttentionNotice } from "./EditorFolderAttentionNotice";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(node: React.ReactNode) {
  await act(async () => { root!.render(node); });
  for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
}

const stuck: EditorFolderAttentionDto = {
  kind: "editor_folder_move_stuck", headline: "Editor pipeline paused: the folder moved in Dropbox but the Portal could not record the move.",
  code: "editor_folder_move_stuck", detail: "Last failure: UNIQUE constraint failed", updatedAt: Date.UTC(2026, 8, 17, 1),
};

function response(overrides: Partial<AdminAttentionResponse> = {}): AdminAttentionResponse {
  return { items: [], truncated: false, provisioningFreeze: null, ...overrides };
}

beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  apiGetMock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host.remove();
});

describe("AdminAttention", () => {
  it("lists each stuck project with a link to it, its state and the diagnostic", async () => {
    apiGetMock.mockResolvedValue(response({ items: [{ ...stuck, projectId: "p-1", projectLabel: "12 Example St, Suburb" }] }));
    await render(<AdminAttention />);
    expect(apiGetMock).toHaveBeenCalledWith("/api/admin/attention");
    const row = host.querySelector("[data-testid=admin-attention-item]")!;
    expect(row.querySelector("a")?.getAttribute("href")).toBe("/projects/p-1");
    expect(row.textContent).toContain("Pipeline paused");
    expect(row.textContent).toContain("UNIQUE constraint failed");
  });

  it("shows the provisioning freeze even when no project is stuck, and points to where it is released", async () => {
    apiGetMock.mockResolvedValue(response({ provisioningFreeze: { frozenAt: Date.UTC(2026, 8, 17), attempts: 5, jobId: "job-9" } }));
    await render(<AdminAttention />);
    const freeze = host.querySelector("[data-testid=admin-attention-freeze]")!;
    expect(freeze.textContent).toContain("after 5 attempts");
    expect(freeze.textContent).toContain("job-9");
    expect(freeze.textContent).toContain("Admin → Users");
    expect(host.textContent).not.toContain("Nothing needs attention");
  });

  it("says so when nothing is latched", async () => {
    apiGetMock.mockResolvedValue(response());
    await render(<AdminAttention />);
    expect(host.textContent).toContain("Nothing needs attention");
  });

  it("never reports a failed load as nothing needing attention", async () => {
    apiGetMock.mockRejectedValue(new Error("Network down"));
    await render(<AdminAttention />);
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Network down");
    expect(host.textContent).not.toContain("Nothing needs attention");
  });

  it("warns when the list was cut short", async () => {
    apiGetMock.mockResolvedValue(response({ truncated: true, items: [{ ...stuck, projectId: "p-1", projectLabel: "One" }] }));
    await render(<AdminAttention />);
    expect(host.textContent).toContain("more are stuck");
  });
});

describe("EditorFolderAttentionNotice", () => {
  it("shows the diagnostic when the server sent one", async () => {
    await render(<EditorFolderAttentionNotice attention={stuck} />);
    const notice = host.querySelector("[data-testid=editor-folder-attention]")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("UNIQUE constraint failed");
  });

  it("shows only the headline, and where to look, when the detail is withheld", async () => {
    await render(<EditorFolderAttentionNotice attention={{ ...stuck, kind: "editor_folder_move_blocked", detail: null }} />);
    const notice = host.querySelector("[data-testid=editor-folder-attention]")!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(stuck.headline);
    expect(notice.textContent).toContain("Admin → Pipeline");
    expect(notice.textContent).not.toContain("editor_folder_move_stuck");
  });
});
