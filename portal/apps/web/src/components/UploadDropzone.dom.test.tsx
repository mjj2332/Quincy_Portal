import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueryClient } from "@tanstack/react-query";
import { UploadDropzone } from "./UploadDropzone";
import { QuincyQueryProvider } from "../lib/query-client";
import { getProjectQueryRuntime } from "../lib/project-query-sync";

const apiPostMock = vi.hoisted(() => vi.fn());
const uploadMultipartFileMock = vi.hoisted(() => vi.fn());

// Without this the real better-auth client polls /api/auth/get-session over the network (#167).
// `data: null` is what these tests already ran against — the real session never resolved — so the
// capability-derived branches keep the coverage they had. A test needing a role sets one here.
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiPost: apiPostMock }));
vi.mock("../lib/multipart-upload", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/multipart-upload")>()), uploadMultipartFile: uploadMultipartFileMock }));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(times = 10) {
  for (let index = 0; index < times; index += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

describe("UploadDropzone publication access termination", () => {
  let host: HTMLElement;
  let fetchMock: ReturnType<typeof vi.fn>;
  let queryClient: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient> | undefined;

  beforeEach(() => {
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    queryClient = undefined;
    apiPostMock.mockReset().mockImplementation((path: string) => {
      if (path.includes("/upload-manifest")) return Promise.resolve({ manifestId: "manifest-1" });
      if (path === "/api/uploads/presign") return Promise.resolve({ key: "uploads/photo.jpg", devDirect: true });
      if (path === "/api/uploads/complete") return Promise.resolve({ assetId: "asset-1", jobId: "job-1", publishStatus: "pending" });
      return Promise.resolve({});
    });
    uploadMultipartFileMock.mockResolvedValue({});
    fetchMock = vi.fn().mockResolvedValue({ status: 401, ok: false });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null; host.remove(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it("terminates the principal when the publication poll receives 401", async () => {
    await act(async () => {
      root!.render(<QuincyQueryProvider principalId="user-1" role="admin"><UploadDropzone projectId="p1" onComplete={() => undefined} onToast={() => undefined} /><ClientCapture onClient={(client) => { queryClient = client; }} /></QuincyQueryProvider>);
      await Promise.resolve();
    });
    queryClient!.setQueryData(["private", "fixture"], { secret: true });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    await flush(20);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/manual-upload-jobs", { credentials: "same-origin" });
    expect(getProjectQueryRuntime(queryClient!)?.principalTerminal).toBe(true);
    expect(queryClient!.getQueryCache().getAll()).toHaveLength(0);
  });
});

function ClientCapture({ onClient }: { onClient: (client: ReturnType<typeof import("../lib/query-client").createQuincyQueryClient>) => void }) {
  onClient(useQueryClient());
  return null;
}
