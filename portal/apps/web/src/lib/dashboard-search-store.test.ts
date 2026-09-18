/**
 * Dashboard search store — #217. Node-environment tests, fake timers: the debounce/commit/adopt
 * state machine in isolation, independent of any component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDashboardSearchStoreForTest,
  adoptDashboardSearchFromUrl,
  cancelPendingDashboardSearchWrite,
  clearDashboardSearch,
  commitDashboardSearchNow,
  DASHBOARD_SEARCH_DEBOUNCE_MS,
  getDashboardSearchSnapshot,
  resetDashboardSearchForPrincipal,
  setDashboardSearchDraft,
  setDashboardSearchUrlWriter,
  subscribeDashboardSearch,
} from "./dashboard-search-store";

beforeEach(() => {
  vi.useFakeTimers();
  __resetDashboardSearchStoreForTest();
});

afterEach(() => {
  __resetDashboardSearchStoreForTest();
  vi.useRealTimers();
});

describe("dashboard-search-store", () => {
  it("draft is live before the debounce fires", () => {
    setDashboardSearchDraft("smith");
    expect(getDashboardSearchSnapshot().draft).toBe("smith");
    expect(getDashboardSearchSnapshot().query).toBe("");
  });

  it("writes once per keystroke burst, after the debounce settles", () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));

    setDashboardSearchDraft("s");
    vi.advanceTimersByTime(100);
    setDashboardSearchDraft("sm");
    vi.advanceTimersByTime(100);
    setDashboardSearchDraft("smi");
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);

    expect(writes).toEqual(["smi"]);
    expect(getDashboardSearchSnapshot().query).toBe("smi");
    unregister();
  });

  it("commit-now beats the timer", () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));

    setDashboardSearchDraft("smith");
    commitDashboardSearchNow();
    expect(writes).toEqual(["smith"]);

    // The timer that commit-now cancelled must not fire a second, redundant write.
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);
    expect(writes).toEqual(["smith"]);
    unregister();
  });

  it("adopt cancels a pending write — the writer is never called", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);

    setDashboardSearchDraft("smith");
    adoptDashboardSearchFromUrl("from-url");
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 100);

    expect(writer).not.toHaveBeenCalled();
    expect(getDashboardSearchSnapshot()).toMatchObject({ draft: "from-url", query: "from-url" });
    unregister();
  });

  it("a principal change clears the store", () => {
    resetDashboardSearchForPrincipal("user-1");
    setDashboardSearchDraft("smith");
    commitDashboardSearchNow();
    expect(getDashboardSearchSnapshot().query).toBe("smith");

    resetDashboardSearchForPrincipal("user-2");
    expect(getDashboardSearchSnapshot()).toMatchObject({ draft: "", query: "", principalId: "user-2" });

    // Same principal again: no-op, does not clear an in-progress search.
    setDashboardSearchDraft("jones");
    commitDashboardSearchNow();
    resetDashboardSearchForPrincipal("user-2");
    expect(getDashboardSearchSnapshot().query).toBe("jones");
  });

  it("unregister never fires the writer being torn down", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith");
    unregister();
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);
    expect(writer).not.toHaveBeenCalled();
  });

  it("unregister FLUSHES the pending draft into query/lastWritten instead of dropping it (#217 fix round 1, item 3)", () => {
    // Re-registration (a view/Calendar-facet change) must not silently lose whatever was
    // mid-debounce: a caller synchronously reads the flushed `query` right after triggering the
    // transition that causes re-registration, and builds its own URL from it.
    const unregister = setDashboardSearchUrlWriter(vi.fn());
    setDashboardSearchDraft("smith");
    expect(getDashboardSearchSnapshot().query).toBe("");
    unregister();
    expect(getDashboardSearchSnapshot().query).toBe("smith");
    // The flush also cancelled the timer -- nothing left pending to fire later.
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);
    expect(getDashboardSearchSnapshot().query).toBe("smith");
  });

  it("snapshot identity is stable across a no-op set", () => {
    commitDashboardSearchNow();
    const before = getDashboardSearchSnapshot();
    // Committing again with no change queued is a no-op: notify() is only called when something
    // actually changes, so the cached snapshot object must not be replaced.
    commitDashboardSearchNow();
    expect(getDashboardSearchSnapshot()).toBe(before);
  });

  it("strips control characters from the draft", () => {
    setDashboardSearchDraft("smith" + String.fromCharCode(0) + "street" + String.fromCharCode(0x1f));
    expect(getDashboardSearchSnapshot().draft).toBe("smithstreet");
  });

  it("truncates the committed query to the 200-code-point cap", () => {
    const long = "a".repeat(250);
    setDashboardSearchDraft(long);
    commitDashboardSearchNow();
    expect(getDashboardSearchSnapshot().query.length).toBe(200);
  });

  it("clearDashboardSearch empties the draft and commits immediately", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith");
    commitDashboardSearchNow();
    clearDashboardSearch();
    expect(getDashboardSearchSnapshot()).toMatchObject({ draft: "", query: "" });
    expect(writer).toHaveBeenLastCalledWith("");
    unregister();
  });

  it("cancelPendingDashboardSearchWrite drops a queued write without committing it", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith");
    cancelPendingDashboardSearchWrite();
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);
    expect(writer).not.toHaveBeenCalled();
    expect(getDashboardSearchSnapshot().query).toBe("");
    unregister();
  });

  it("notifies subscribers on draft, commit, adopt and reset", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDashboardSearch(listener);
    setDashboardSearchDraft("smith");
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    commitDashboardSearchNow();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    adoptDashboardSearchFromUrl("x");
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    resetDashboardSearchForPrincipal("someone");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
