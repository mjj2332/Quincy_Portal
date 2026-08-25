import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import { getProjectQueryRuntime } from "./project-query-sync";
import { QuincyQueryProvider, createQuincyQueryClient } from "./query-client";
import { ProjectCollaborationPanel } from "../components/ProjectCollaborationPanel";
import { CollectionPanel } from "../components/CollectionPanel";
import { SubtaskChecklist } from "../components/SubtaskChecklist";

const apiGetMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), apiGet: apiGetMock }));
vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1", role: "editor" } }, isPending: false }) }));
vi.mock("../lib/capabilities", () => ({ useCapabilities: () => ({ role: "editor", capabilities: ["collaborateOnProject"], can: (capability: string) => capability === "collaborateOnProject" }) }));
vi.mock("../components/RichTextEditor", () => ({ RichTextEditor: () => <div data-testid="rich-text-editor" /> }));

function ClientSeed({ onClient }: { onClient: (client: ReturnType<typeof createQuincyQueryClient>) => void }) {
  const client = useQueryClient();
  onClient(client);
  return null;
}

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(node: React.ReactNode, onClient: (client: ReturnType<typeof createQuincyQueryClient>) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<QuincyQueryProvider principalId="user-1" role="editor"><ClientSeed onClient={onClient} />{node}</QuincyQueryProvider>);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; document.body.replaceChildren(); apiGetMock.mockReset();
});

describe("manual project-data owners terminate the principal on a real 401", () => {
  it("clears the client when ProjectCollaborationPanel comments load returns 401", async () => {
    let client: ReturnType<typeof createQuincyQueryClient> | undefined;
    apiGetMock.mockRejectedValue(new ApiError("Session expired", 401));
    await render(<ProjectCollaborationPanel projectId="project-1" />, (value) => {
      client = value; value.setQueryData(["private"], "secret");
    });
    expect(getProjectQueryRuntime(client!)?.principalTerminal).toBe(true);
    expect(client!.getQueryCache().getAll()).toHaveLength(0);
  });

  it("clears the client when CollectionPanel links load returns 401", async () => {
    let client: ReturnType<typeof createQuincyQueryClient> | undefined;
    apiGetMock.mockRejectedValue(new ApiError("Session expired", 401));
    await render(<CollectionPanel projectId="project-1" collection="video" assets={[]} canManage={false} canApprove={false} onReview={async () => undefined} onToast={() => undefined} />, (value) => {
      client = value; value.setQueryData(["private"], "secret");
    });
    expect(getProjectQueryRuntime(client!)?.principalTerminal).toBe(true);
    expect(client!.getQueryCache().getAll()).toHaveLength(0);
  });

  it("clears the client when SubtaskChecklist bootstrap returns 401", async () => {
    let client: ReturnType<typeof createQuincyQueryClient> | undefined;
    apiGetMock.mockRejectedValue(new ApiError("Session expired", 401));
    await render(<SubtaskChecklist projectId="project-1" />, (value) => {
      client = value; value.setQueryData(["private"], "secret");
    });
    expect(getProjectQueryRuntime(client!)?.principalTerminal).toBe(true);
    expect(client!.getQueryCache().getAll()).toHaveLength(0);
  });
});
