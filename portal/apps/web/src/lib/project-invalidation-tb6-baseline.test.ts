import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { beginAssetOptimisticMutation, beginProjectMembershipMutation, invalidateProjectResources, projectDataKeys } from "./project-data";
import { createProjectDataInvalidationMessage, ProjectQueryRuntime } from "./project-query-sync";

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function receive(runtime: ProjectQueryRuntime, resources: Parameters<typeof createProjectDataInvalidationMessage>[1]) {
  (runtime as unknown as { receive: (value: unknown) => void }).receive({
    ...createProjectDataInvalidationMessage("project-1", resources),
    sourceTabId: "other-tab",
  });
}

describe("TB6 Slice 0 project invalidation characterization", () => {
  it("defers a local subtasks invalidation while SubtaskChecklist owns the key, then flushes once on release", async () => {
    // Slice 3a: local senders are now owner-deferred.
    const client = queryClient();
    const runtime = new ProjectQueryRuntime(client, "local-subtasks");
    const key = projectDataKeys.subtasks("project-1");
    client.setQueryData(key, []);
    const release = runtime.acquireOwner(key);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await invalidateProjectResources(client, { projectId: "project-1", resources: [{ kind: "subtasks" }] });

    expect(invalidate).not.toHaveBeenCalled();
    release();
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true, refetchType: "active" });
    runtime.dispose(); client.clear();
  });

  it("defers a local detail invalidation while ProjectDeadlineControl owns the key, then flushes once on release", async () => {
    // Slice 3a: local senders are now owner-deferred.
    const client = queryClient();
    const runtime = new ProjectQueryRuntime(client, "local-detail");
    const key = projectDataKeys.detail("project-1");
    client.setQueryData(key, { id: "project-1" });
    const release = runtime.acquireOwner(key);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await invalidateProjectResources(client, { projectId: "project-1", resources: [{ kind: "detail" }] });

    expect(invalidate).not.toHaveBeenCalled();
    release();
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true, refetchType: "active" });
    runtime.dispose(); client.clear();
  });

  it.each([
    { label: "subtasks", resource: { kind: "subtasks" } as const, key: projectDataKeys.subtasks("project-1") },
    { label: "detail", resource: { kind: "detail" } as const, key: projectDataKeys.detail("project-1") },
  ])("defers a cross-tab $label invalidation while its active owner holds the key, then flushes on release", async ({ resource, key }) => {
    // Before Slice 3: receive() uses invalidateOrDefer for owned keys and releases exactly once.
    const client = queryClient();
    const runtime = new ProjectQueryRuntime(client, `remote-${resource.kind}`);
    client.setQueryData(key, []);
    const release = runtime.acquireOwner(key);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    receive(runtime, [resource]);
    expect(invalidate).not.toHaveBeenCalled();
    release();
    await Promise.resolve();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true, refetchType: "active" });
    runtime.dispose(); client.clear();
  });

  it("withholds cross-tab publish while asset and membership ledgers are pending, then publishes once on release", async () => {
    // Before Slice 3: queueLedgerInvalidation stores queuedPublish until the optimistic ledger settles.
    const client = queryClient();
    const runtime = new ProjectQueryRuntime(client, "ledger-owner");
    const publish = vi.spyOn(runtime, "publish");
    const assetKey = projectDataKeys.assets("project-1", "raw");
    client.setQueryData(assetKey, [{ id: "asset-1", selected: false }]);
    const assetMutation = await beginAssetOptimisticMutation(client, "project-1", "raw", "asset-1", { selected: true });

    await invalidateProjectResources(client, { projectId: "project-1", resources: [{ kind: "assets", collectionKind: "raw" }] });
    expect(publish).not.toHaveBeenCalled();
    await assetMutation.commit();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ type: "project-data-invalidated", projectId: "project-1", resources: [{ kind: "assets", collectionKind: "raw" }] });

    publish.mockClear();
    const detailKey = projectDataKeys.detail("project-1");
    const summaryKey = projectDataKeys.collaborationSummary("project-1");
    client.setQueryData(detailKey, { id: "project-1", members: [] });
    client.setQueryData(summaryKey, { project: { id: "project-1" }, members: [] });
    const membershipMutation = await beginProjectMembershipMutation(client, "project-1", "photographer", "user-1", "add", {
      id: "cycle-1", userId: "user-1", roleOnProject: "photographer", name: "User", email: "user@example.test", globalRole: "photographer", active: true, assignedSubtaskCount: 0,
    });

    await invalidateProjectResources(client, { projectId: "project-1", resources: [{ kind: "detail" }] });
    expect(publish).not.toHaveBeenCalled();
    await membershipMutation.commit();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ type: "project-data-invalidated", projectId: "project-1", resources: [{ kind: "detail" }] });
    runtime.dispose(); client.clear();
  });
});
