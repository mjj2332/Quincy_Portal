import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, focusManager, onlineManager, useQueryClient } from "@tanstack/react-query";
import type { Role } from "@quincy/shared";
import type { WorkspaceAsset } from "../components/PhotoGrid";
import { ApiError } from "./api";
import { getProjectQueryRuntime, ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "./project-query-sync";
import { projectDataKeys, usePassiveRawAssetsQuery, useProjectAssetsQuery, useProjectDetailQuery } from "./project-data";
import { createQuincyQueryClient, QuincyQueryProvider } from "./query-client";

const apiGetMock = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), apiGet: apiGetMock }));

function asset(id: string): WorkspaceAsset {
  return { id, collectionId: "c", kind: "photo", originalFilename: `${id}.jpg`, bytes: 1, width: null, height: null, ratingFromMetadata: null, section: null, renditionStatus: "ready", createdAt: "2026-08-25T00:00:00.000Z", sourceRawAssetId: null, version: 1, versionGroupId: null, supersedesAssetId: null, review: null, selected: false };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; host?.remove(); host = null;
  apiGetMock.mockReset();
  vi.useRealTimers();
});

function render(value: ReactNode) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  return act(async () => { root!.render(value); await Promise.resolve(); });
}

function CacheProbe({ onClient }: { onClient: (client: ReturnType<typeof createQuincyQueryClient>) => void }) {
  const queryClient = useQueryClient();
  onClient(queryClient);
  return <span data-cache={String(queryClient.getQueryData(["role-scope"]) ?? "empty")} />;
}

function PassiveRawProbe({ projectId }: { projectId: string }) {
  const query = usePassiveRawAssetsQuery(projectId, true);
  return <span data-asset={query.data?.[0]?.id ?? "none"} />;
}

function DetailProbe({ onClient }: { onClient: (client: ReturnType<typeof createQuincyQueryClient>) => void }) {
  const queryClient = useQueryClient();
  const query = useProjectDetailQuery("p1", true, false);
  onClient(queryClient);
  return <span data-detail-status={query.status} />;
}

function PollingProbe({ owns, onClient }: { owns: boolean; onClient: (client: ReturnType<typeof createQuincyQueryClient>) => void }) {
  const queryClient = useQueryClient();
  const query = useProjectAssetsQuery("p1", "edited", true, owns);
  onClient(queryClient);
  return <span data-polling-status={query.status} />;
}

describe("QuincyQueryProvider scope and passive RAW retention", () => {
  it("clears the old client when the same principal changes role", async () => {
    let firstClient: ReturnType<typeof createQuincyQueryClient> | undefined;
    let secondClient: ReturnType<typeof createQuincyQueryClient> | undefined;
    const renderScoped = (role: Role, onClient: (client: ReturnType<typeof createQuincyQueryClient>) => void) => render(<QuincyQueryProvider key={`u1:${role}`} principalId="u1" role={role}><CacheProbe onClient={onClient} /></QuincyQueryProvider>);
    await renderScoped("admin", (client) => { firstClient = client; client.setQueryData(["role-scope"], "admin-private"); });
    expect(firstClient?.getQueryData(["role-scope"])).toBe("admin-private");
    await act(async () => { root!.render(<QuincyQueryProvider key="u1:photographer" principalId="u1" role="photographer"><CacheProbe onClient={(client) => { secondClient = client; }} /></QuincyQueryProvider>); await Promise.resolve(); });
    expect(secondClient).not.toBe(firstClient);
    expect(firstClient?.getQueryCache().getAll()).toHaveLength(0);
    expect(secondClient?.getQueryData(["role-scope"])).toBeUndefined();
  });

  it("keeps the subscribed passive RAW entry beyond production GC and reacts to exact updates", async () => {
    vi.useFakeTimers();
    const queryClient = createQuincyQueryClient();
    const runtime = new ProjectQueryRuntime(queryClient, "test-tab");
    const key = projectDataKeys.assets("p1", "raw");
    queryClient.setQueryData(key, [asset("raw-before")]);
    await render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><PassiveRawProbe projectId="p1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
    await act(async () => { vi.advanceTimersByTime(5 * 60_000 + 1); await Promise.resolve(); });
    expect(queryClient.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount()).toBe(1);
    expect(queryClient.getQueryData(key)).toEqual([expect.objectContaining({ id: "raw-before" })]);
    await act(async () => { queryClient.setQueryData(key, [asset("raw-after")]); await Promise.resolve(); await Promise.resolve(); vi.runOnlyPendingTimers(); await Promise.resolve(); });
    expect(host?.querySelector("[data-asset]")?.getAttribute("data-asset")).toBe("raw-after");
    runtime.dispose(); queryClient.clear();
  });

  it("clears the whole client when a real project query receives a 401 and remains terminal after rerender", async () => {
    let queryClient: ReturnType<typeof createQuincyQueryClient> | undefined;
    let seeded = false;
    apiGetMock.mockRejectedValue(new ApiError("Session expired", 401));
    await render(<QuincyQueryProvider principalId="u1" role="editor"><DetailProbe onClient={(client) => { queryClient = client; if (!seeded) { seeded = true; client.setQueryData(["unrelated-private"], "secret"); } }} /></QuincyQueryProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(queryClient).toBeDefined();
    await act(async () => { root!.render(<QuincyQueryProvider principalId="u1" role="editor"><CacheProbe onClient={(client) => { queryClient = client; }} /></QuincyQueryProvider>); await Promise.resolve(); });
    expect(getProjectQueryRuntime(queryClient!)?.principalTerminal).toBe(true);
    expect(queryClient!.getQueryCache().getAll()).toHaveLength(0);
  });

  it("reopens the runtime channel after StrictMode's effect cleanup/remount cycle", async () => {
    class FakeChannel {
      static channels: FakeChannel[] = [];
      readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
      constructor(readonly name: string) { FakeChannel.channels.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) { this.listeners.add(listener); }
      close() { FakeChannel.channels = FakeChannel.channels.filter((item) => item !== this); this.listeners.clear(); }
      postMessage(_data: unknown) {}
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    await render(<StrictMode><QuincyQueryProvider principalId="u1" role="editor"><CacheProbe onClient={() => undefined} /></QuincyQueryProvider></StrictMode>);
    expect(FakeChannel.channels).toHaveLength(1);
    expect(FakeChannel.channels[0]?.listeners.size).toBe(1);
    vi.unstubAllGlobals();
  });

  it("polls active resources every 30 seconds, pauses hidden tabs, and refetches on focus and reconnect", async () => {
    vi.useFakeTimers();
    onlineManager.setOnline(true); focusManager.setFocused(true);
    const queryClient = createQuincyQueryClient(); const runtime = new ProjectQueryRuntime(queryClient, "polling-tab");
    apiGetMock.mockResolvedValue({ assets: [asset("edited")] });
    await render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><PollingProbe owns={false} onClient={() => undefined} /></QueryClientProvider></ProjectQueryRuntimeProvider>);
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    focusManager.setFocused(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    apiGetMock.mockClear(); focusManager.setFocused(true);
    await act(async () => { await Promise.resolve(); });
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    apiGetMock.mockClear();
    await queryClient.invalidateQueries({ queryKey: projectDataKeys.assets("p1", "edited"), exact: true, refetchType: "none" });
    onlineManager.setOnline(false);
    await act(async () => { await Promise.resolve(); });
    onlineManager.setOnline(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    runtime.dispose(); queryClient.clear(); focusManager.setFocused(true); onlineManager.setOnline(true);
  });

  it("transitions special ownership without a polling gap or a double poll", async () => {
    vi.useFakeTimers();
    onlineManager.setOnline(true); focusManager.setFocused(true);
    const queryClient = createQuincyQueryClient(); const runtime = new ProjectQueryRuntime(queryClient, "owner-transition-tab");
    apiGetMock.mockResolvedValue({ assets: [asset("edited")] });
    await render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><PollingProbe owns={true} onClient={() => undefined} /></QueryClientProvider></ProjectQueryRuntimeProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><PollingProbe owns={false} onClient={() => undefined} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><PollingProbe owns={true} onClient={() => undefined} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    runtime.dispose(); queryClient.clear();
  });
});
