import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getDashboardSearchSnapshotForTest,
  __resetDashboardSearchStoreForTest,
  clearDashboardSearch,
  commitDashboardSearchNow,
  DASHBOARD_SEARCH_DEBOUNCE_MS,
  dropDashboardSearchOwnership,
  getDashboardSearchSnapshotForPrincipal,
  resetDashboardSearchForPrincipal,
  setDashboardSearchDraft,
  setDashboardSearchUrlWriter,
  syncDashboardSearchDraftFromLocation,
} from "./dashboard-search-store";

// Compile-time probe: callers may not silently omit the principal identity.
if (false) {
  // @ts-expect-error viewerId is required for ownership-sensitive writes.
  setDashboardSearchDraft("orphaned");
  // @ts-expect-error viewerId is required for ownership-sensitive writes.
  commitDashboardSearchNow();
  // @ts-expect-error viewerId is required for ownership-sensitive writes.
  clearDashboardSearch();
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetDashboardSearchStoreForTest();
});

afterEach(() => {
  __resetDashboardSearchStoreForTest();
  vi.useRealTimers();
});

describe("dashboard search ownership adversarial probes (#217)", () => {
  it("debounces the latest draft and never lets popstate adoption be overwritten", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("s", "principal-a");
    vi.advanceTimersByTime(150);
    setDashboardSearchDraft("smith", "principal-a");
    syncDashboardSearchDraftFromLocation("backward", "principal-a");
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 1);

    expect(writer).not.toHaveBeenCalled();
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "backward", principalId: "principal-a" });
    unregister();
  });

  it("drops a timer armed by A when ownership changes before it fires", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("a-secret", "principal-a");
    resetDashboardSearchForPrincipal("principal-b");
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 1);

    expect(writer).not.toHaveBeenCalled();
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "", principalId: "principal-b" });
    unregister();
  });

  it("clears the draft immediately and writes an empty query through the writer on Escape-style clear", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith", "principal-a");
    commitDashboardSearchNow("principal-a");
    clearDashboardSearch("principal-a");

    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "", principalId: "principal-a" });
    expect(writer).toHaveBeenLastCalledWith("");
    unregister();
  });

  it("returns a stable empty render-time snapshot to the wrong principal without waiting for an effect", () => {
    setDashboardSearchDraft("smith", "principal-a");
    commitDashboardSearchNow("principal-a");
    const first = getDashboardSearchSnapshotForPrincipal("principal-b");
    const second = getDashboardSearchSnapshotForPrincipal("principal-b");

    expect(first).toBe(second);
    expect(first).toEqual({ draft: "", principalId: "principal-b" });
    expect(getDashboardSearchSnapshotForPrincipal("principal-a").draft).toBe("smith");
  });

  it("drops ownership on sign-out even when the next sign-in uses the same id", () => {
    setDashboardSearchDraft("smith", "principal-a");
    commitDashboardSearchNow("principal-a");
    dropDashboardSearchOwnership();
    resetDashboardSearchForPrincipal("principal-a");

    expect(__getDashboardSearchSnapshotForTest()).toEqual({ draft: "", principalId: "principal-a" });
  });
});
