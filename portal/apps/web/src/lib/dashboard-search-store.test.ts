/**
 * Dashboard search store — #217. Node-environment tests, fake timers: the debounce/commit/adopt
 * state machine in isolation, independent of any component.
 *
 * #217 fix round 5, item 2 (Sol re-review, SHOULD-FIX): every write/adopt call below now passes an
 * explicit `viewerId` -- the store's own signature requires one, compile-time, so a test can never
 * exercise the tautological "omitted id defaults to whatever the store already thinks" path an
 * earlier version of this store had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getDashboardSearchSnapshotForTest,
  __resetDashboardSearchStoreForTest,
  adoptDashboardSearchFromUrl,
  cancelPendingDashboardSearchWrite,
  clearDashboardSearch,
  commitDashboardSearchNow,
  DASHBOARD_SEARCH_DEBOUNCE_MS,
  resetDashboardSearchForPrincipal,
  setDashboardSearchDraft,
  setDashboardSearchUrlWriter,
  subscribeDashboardSearch,
} from "./dashboard-search-store";

const USER = "user-1";

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
    setDashboardSearchDraft("smith", USER);
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
    expect(__getDashboardSearchSnapshotForTest().query).toBe("");
  });

  it("writes once per keystroke burst, after the debounce settles", () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));

    setDashboardSearchDraft("s", USER);
    vi.advanceTimersByTime(100);
    setDashboardSearchDraft("sm", USER);
    vi.advanceTimersByTime(100);
    setDashboardSearchDraft("smi", USER);
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);

    expect(writes).toEqual(["smi"]);
    expect(__getDashboardSearchSnapshotForTest().query).toBe("smi");
    unregister();
  });

  it("commit-now beats the timer", () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));

    setDashboardSearchDraft("smith", USER);
    commitDashboardSearchNow(USER);
    expect(writes).toEqual(["smith"]);

    // The timer that commit-now cancelled must not fire a second, redundant write.
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);
    expect(writes).toEqual(["smith"]);
    unregister();
  });

  it("adopt cancels a pending write — the writer is never called", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);

    setDashboardSearchDraft("smith", USER);
    adoptDashboardSearchFromUrl("from-url", USER);
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 100);

    expect(writer).not.toHaveBeenCalled();
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "from-url", query: "from-url" });
    unregister();
  });

  it("a principal change clears the store", () => {
    resetDashboardSearchForPrincipal("user-1");
    setDashboardSearchDraft("smith", "user-1");
    commitDashboardSearchNow("user-1");
    expect(__getDashboardSearchSnapshotForTest().query).toBe("smith");

    resetDashboardSearchForPrincipal("user-2");
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "", query: "", principalId: "user-2" });

    // Same principal again: no-op, does not clear an in-progress search.
    setDashboardSearchDraft("jones", "user-2");
    commitDashboardSearchNow("user-2");
    resetDashboardSearchForPrincipal("user-2");
    expect(__getDashboardSearchSnapshotForTest().query).toBe("jones");
  });

  // #217 fix round 5, item 2: a write carrying a DIFFERENT principal's id than the store's current
  // owner clears the old owner's state first and never merges into it.
  it("a write carrying principal B's id while A owns the store clears A's state first and never merges", () => {
    setDashboardSearchDraft("smith", "user-a");
    commitDashboardSearchNow("user-a");
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "smith", query: "smith", principalId: "user-a" });

    setDashboardSearchDraft("jones", "user-b");
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "jones", query: "", principalId: "user-b" });
  });

  it("unregister never fires the writer being torn down", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith", USER);
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
    setDashboardSearchDraft("smith", USER);
    unregisterOld();
    // Re-registration -- a view/Calendar-facet change tearing the writer down and back up, with no
    // URL write of its own to carry the pending value.
    setDashboardSearchUrlWriter(newWriter);

    expect(__getDashboardSearchSnapshotForTest().query).toBe("");
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);

    expect(__getDashboardSearchSnapshotForTest().query).toBe("smith");
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
    commitDashboardSearchNow(USER);
    setDashboardSearchDraft("smith", USER);
    commitDashboardSearchNow(USER);
    expect(newWriter).toHaveBeenCalledWith("smith");
  });

  it("snapshot identity is stable across a no-op set", () => {
    commitDashboardSearchNow(USER);
    const before = __getDashboardSearchSnapshotForTest();
    // Committing again with no change queued is a no-op: notify() is only called when something
    // actually changes, so the cached snapshot object must not be replaced.
    commitDashboardSearchNow(USER);
    expect(__getDashboardSearchSnapshotForTest()).toBe(before);
  });

  it("strips control characters from the draft", () => {
    setDashboardSearchDraft("smith" + String.fromCharCode(0) + "street" + String.fromCharCode(0x1f), USER);
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smithstreet");
  });

  it("truncates the committed query to the 200-code-point cap", () => {
    const long = "a".repeat(250);
    setDashboardSearchDraft(long, USER);
    commitDashboardSearchNow(USER);
    expect(__getDashboardSearchSnapshotForTest().query.length).toBe(200);
  });

  it("clearDashboardSearch empties the draft and commits immediately", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith", USER);
    commitDashboardSearchNow(USER);
    clearDashboardSearch(USER);
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "", query: "" });
    expect(writer).toHaveBeenLastCalledWith("");
    unregister();
  });

  it("cancelPendingDashboardSearchWrite drops a queued write without committing it", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith", USER);
    cancelPendingDashboardSearchWrite();
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);
    expect(writer).not.toHaveBeenCalled();
    expect(__getDashboardSearchSnapshotForTest().query).toBe("");
    unregister();
  });

  it("notifies subscribers on draft, commit, adopt and reset", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDashboardSearch(listener);
    setDashboardSearchDraft("smith", USER);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    commitDashboardSearchNow(USER);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    adoptDashboardSearchFromUrl("x", USER);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    resetDashboardSearchForPrincipal("someone");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
