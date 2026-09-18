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

  // #217 fix round 2, item 1 (Sol's diff review): superseded fix round 1 item 3's own
  // "flush-on-unregister" design. That design settled `query` internally on unregister, but only a
  // caller that ALSO happened to build its own URL synchronously right after triggering the
  // transition ever got the value into a URL -- a re-registration with no such call site (e.g.
  // `viewingArchived` flipping while already on List recreates `navigateCalendar` for reasons
  // having nothing to do with search) silently stranded the pending value regardless. The pending
  // timer must survive ANY unregister and fire later against whichever writer is registered then.
  it("unregister does NOT flush or cancel a pending write -- the timer survives and fires later, against whichever writer is registered when it elapses", () => {
    const oldWriter = vi.fn();
    const newWriter = vi.fn();
    const unregisterOld = setDashboardSearchUrlWriter(oldWriter);
    setDashboardSearchDraft("smith");
    unregisterOld();
    // Re-registration -- a view/Calendar-facet change tearing the writer down and back up, with no
    // URL write of its own to carry the pending value.
    setDashboardSearchUrlWriter(newWriter);

    expect(getDashboardSearchSnapshot().query).toBe("");
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);

    expect(getDashboardSearchSnapshot().query).toBe("smith");
    expect(oldWriter).not.toHaveBeenCalled();
    expect(newWriter).toHaveBeenCalledExactlyOnceWith("smith");
  });

  it("an out-of-order unregister call does not null a writer a NEWER registration already installed", () => {
    const oldWriter = vi.fn();
    const newWriter = vi.fn();
    const unregisterOld = setDashboardSearchUrlWriter(oldWriter);
    setDashboardSearchUrlWriter(newWriter);
    // The OLD registration's own unregister fires late (e.g. a stale effect cleanup) -- it must
    // only null the writer if it is STILL the one it owns, never a newer one already in place.
    unregisterOld();
    commitDashboardSearchNow();
    setDashboardSearchDraft("smith");
    commitDashboardSearchNow();
    expect(newWriter).toHaveBeenCalledWith("smith");
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
