import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { confirmStore } from "../lib/confirm";
import { ConfirmModalHost } from "./ConfirmDialog";
import { ProjectTeamControl } from "./ProjectTeamControl";

const apiGetMock = vi.hoisted(() => vi.fn());
const apiDeleteMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiDeleteWithBody: (path: string, body: unknown) => apiDeleteMock(path, body) };
});

const projectId = "11111111-1111-4111-8111-111111111111";
const member = { id: "44444444-4444-4444-8444-444444444444", userId: "55555555-5555-4555-8555-555555555555", roleOnProject: "editor" as const, name: "Inactive Editor", email: "inactive@example.test", globalRole: "editor" as const, active: false, assignedSubtaskCount: 2 };
let root: Root | null = null;
let queryClient: QueryClient | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// `Modal` delays its own unmount by 120ms (`--dur-fast`) after `open` goes false (§6.0).
async function waitForClose() {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue({ photographers: [], editors: [] });
  apiDeleteMock.mockReset().mockRejectedValue(new ApiError("confirm", 422, { code: "subtask_assignment_confirmation_required", assignmentCount: 2 }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  confirmStore.resolve(false);
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; queryClient?.clear(); queryClient = null; document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ProjectTeamControl real confirmation boundary", () => {
  it("cancels after the unconfirmed probe without sending a retry", async () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => {
      root!.render(<QueryClientProvider client={queryClient!}><><ProjectTeamControl projectId={projectId} members={[member]} canEdit /><ConfirmModalHost /></></QueryClientProvider>);
      await Promise.resolve();
    });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="project-member-remove"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();
    expect(apiDeleteMock).toHaveBeenCalledOnce();
    expect(apiDeleteMock.mock.calls[0]?.[1]).toEqual({ membershipCycle: member.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!.click();
    await waitForClose();
    expect(apiDeleteMock).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="confirm-modal"]')).toBeNull();
  });
});
