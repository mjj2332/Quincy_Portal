/**
 * Dashboard search store — #217. Node-environment tests, fake timers: the debounce/commit/draft-from-location
 * sync state machine in isolation, independent of any component.
 *
 * #217 fix round 5, item 2 (Sol re-review, SHOULD-FIX): every write/sync call below now passes an
 * explicit `viewerId` -- the store's own signature requires one, compile-time, so a test can never
 * exercise the tautological "omitted id defaults to whatever the store already thinks" path an
 * earlier version of this store had.
 *
 * #217 build, step 5 (SANCTIONED TEST CHANGE): the store no longer keeps a `query` copy of the
 * committed search (`Dashboard.tsx` derives it from the route instead) -- every assertion that used
 * to read `__getDashboardSearchSnapshotForTest().query` is rewritten against a writer spy, the
 * store's own committing mechanism, which is strictly stronger: it proves what actually got WRITTEN
 * (and how many times), not just what a since-deleted internal field happened to hold. Nothing else
 * about these tests changes. `adoptDashboardSearchFromUrl` is gone too (step 5 also removes it: it
 * existed only to keep that same `query` copy in step, and `syncDashboardSearchDraftFromLocation`,
 * covered in its own `describe` below, is the one way a location's `q` reaches the draft).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getDashboardSearchSnapshotForTest,
  __resetDashboardSearchStoreForTest,
  cancelPendingDashboardSearchWrite,
  clearDashboardSearch,
  commitDashboardSearchNow,
  DASHBOARD_SEARCH_DEBOUNCE_MS,
  resetDashboardSearchForPrincipal,
  setDashboardSearchDraft,
  setDashboardSearchDraftDuringComposition,
  setDashboardSearchUrlWriter,
  subscribeDashboardSearch,
  syncDashboardSearchDraftFromLocation,
  takeDashboardSearchForNavigation,
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
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith", USER);
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
    expect(writer).not.toHaveBeenCalled();
    unregister();
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

  it("syncDashboardSearchDraftFromLocation cancels a pending write — the writer is never called", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);

    setDashboardSearchDraft("smith", USER);
    syncDashboardSearchDraftFromLocation("from-url", USER);
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 100);

    expect(writer).not.toHaveBeenCalled();
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "from-url" });
    unregister();
  });

  it("a principal change clears the store", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    resetDashboardSearchForPrincipal("user-1");
    setDashboardSearchDraft("smith", "user-1");
    commitDashboardSearchNow("user-1");
    expect(writer).toHaveBeenLastCalledWith("smith");

    resetDashboardSearchForPrincipal("user-2");
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "", principalId: "user-2" });

    // Same principal again: no-op, does not clear an in-progress search.
    setDashboardSearchDraft("jones", "user-2");
    commitDashboardSearchNow("user-2");
    resetDashboardSearchForPrincipal("user-2");
    expect(writer).toHaveBeenLastCalledWith("jones");
    unregister();
  });

  // #217 fix round 5, item 2: a write carrying a DIFFERENT principal's id than the store's current
  // owner clears the old owner's state first and never merges into it.
  it("a write carrying principal B's id while A owns the store clears A's state first and never merges", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith", "user-a");
    commitDashboardSearchNow("user-a");
    expect(writer).toHaveBeenLastCalledWith("smith");
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "smith", principalId: "user-a" });

    setDashboardSearchDraft("jones", "user-b");
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "jones", principalId: "user-b" });
    unregister();
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
  // "flush-on-unregister" design. That design settled the committed value internally on unregister,
  // but only a caller that ALSO happened to build its own URL synchronously right after triggering
  // the transition ever got the value into a URL -- a re-registration with no such call site (e.g.
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

    expect(oldWriter).not.toHaveBeenCalled();
    expect(newWriter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);

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
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    commitDashboardSearchNow(USER);
    const before = __getDashboardSearchSnapshotForTest();
    // Committing again is a no-op for the SNAPSHOT (draft/principalId unchanged) even though the
    // writer itself is called again with the same value -- notify() is only called when draft or
    // principalId actually changes, so the cached snapshot object must not be replaced.
    commitDashboardSearchNow(USER);
    expect(__getDashboardSearchSnapshotForTest()).toBe(before);
    unregister();
  });

  it("strips control characters from the draft", () => {
    setDashboardSearchDraft("smith" + String.fromCharCode(0) + "street" + String.fromCharCode(0x1f), USER);
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smithstreet");
  });

  it("truncates the committed query to the 200-code-point cap", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    const long = "a".repeat(250);
    setDashboardSearchDraft(long, USER);
    commitDashboardSearchNow(USER);
    expect(writer).toHaveBeenCalledExactlyOnceWith("a".repeat(200));
    unregister();
  });

  it("clearDashboardSearch empties the draft and commits immediately", () => {
    const writer = vi.fn();
    const unregister = setDashboardSearchUrlWriter(writer);
    setDashboardSearchDraft("smith", USER);
    commitDashboardSearchNow(USER);
    clearDashboardSearch(USER);
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "" });
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
    unregister();
  });

  it("notifies subscribers on draft, sync and reset", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDashboardSearch(listener);
    setDashboardSearchDraft("smith", USER);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    syncDashboardSearchDraftFromLocation("x", USER);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    resetDashboardSearchForPrincipal("someone");
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  // A commit itself no longer notifies subscribers -- there is nothing left in the snapshot
  // (`draft`, `principalId`) that a commit changes, so a commit-only listener sees nothing.
  it("commitDashboardSearchNow does not itself notify — nothing in the snapshot changes", () => {
    const listener = vi.fn();
    setDashboardSearchDraft("smith", USER);
    const unsubscribe = subscribeDashboardSearch(listener);
    commitDashboardSearchNow(USER);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  // #217 design-fix round 3, item 3: an IME composition still armed the 300ms commit timer on
  // every intermediate update, so a long composition could commit and rewrite the URL mid-
  // composition. `setDashboardSearchDraftDuringComposition` updates the draft the SAME way
  // `setDashboardSearchDraft` does but arms no timer at all.
  describe("setDashboardSearchDraftDuringComposition — the IME no-schedule path", () => {
    it("updates the draft live, but arms no commit timer", () => {
      setDashboardSearchDraftDuringComposition("s", USER);
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("s");

      const writer = vi.fn();
      const unregister = setDashboardSearchUrlWriter(writer);
      vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 100);
      expect(writer).not.toHaveBeenCalled();
      unregister();
    });

    it("a whole burst of composition updates never commits or writes, even well past one debounce window", () => {
      const writer = vi.fn();
      const unregister = setDashboardSearchUrlWriter(writer);
      setDashboardSearchDraftDuringComposition("s", USER);
      vi.advanceTimersByTime(100);
      setDashboardSearchDraftDuringComposition("sm", USER);
      vi.advanceTimersByTime(100);
      setDashboardSearchDraftDuringComposition("smi", USER);
      vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 100);

      expect(writer).not.toHaveBeenCalled();
      expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "smi" });
      unregister();
    });

    it("still respects ownership -- a different viewer clears the previous owner's state first", () => {
      setDashboardSearchDraft("smith", USER);
      setDashboardSearchDraftDuringComposition("other", "user-2");
      expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "other", principalId: "user-2" });
    });

    it("still sanitizes the value (strips unsafe characters) the same way the scheduled path does", () => {
      setDashboardSearchDraftDuringComposition("\\smith", USER);
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
    });
  });

  // #217 build, step 3.
  describe("syncDashboardSearchDraftFromLocation", () => {
    it("the store's OWN debounced write landing back as a location does not disturb a draft with trailing whitespace", () => {
      const writer = vi.fn();
      const unregister = setDashboardSearchUrlWriter(writer);
      setDashboardSearchDraft("smith ", USER);
      vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);
      expect(writer).toHaveBeenCalledExactlyOnceWith("smith");

      // The write above is what produced this "location" -- `routeQuery` is exactly what the
      // writer just wrote, normalised, the same way `dashboardSearchOf(route)` would read it back.
      syncDashboardSearchDraftFromLocation("smith", USER);
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith ");
      unregister();
    });

    it("a genuinely different committed search (Back/Forward, a rail click) replaces the draft and cancels any pending write", () => {
      const writer = vi.fn();
      const unregister = setDashboardSearchUrlWriter(writer);
      setDashboardSearchDraft("abc", USER);

      syncDashboardSearchDraftFromLocation("xyz", USER);
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("xyz");

      vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 100);
      expect(writer).not.toHaveBeenCalled();
      unregister();
    });

    it("a Dashboard route carrying no q resets the draft to empty", () => {
      setDashboardSearchDraft("smith", USER);
      syncDashboardSearchDraftFromLocation(undefined, USER);
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("");
    });

    it("respects ownership -- a different viewer's sync clears the previous owner's state first", () => {
      setDashboardSearchDraft("smith", "user-a");
      syncDashboardSearchDraftFromLocation("jones", "user-b");
      expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "jones", principalId: "user-b" });
    });

    it("is a stable no-op (no notify) when the draft already matches the route's own q", () => {
      setDashboardSearchDraft("smith", USER);
      const listener = vi.fn();
      const unsubscribe = subscribeDashboardSearch(listener);
      syncDashboardSearchDraftFromLocation("smith", USER);
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  // #217 build, step 3.
  describe("takeDashboardSearchForNavigation", () => {
    it("cancels a pending write and returns the normalised draft", () => {
      const writer = vi.fn();
      const unregister = setDashboardSearchUrlWriter(writer);
      setDashboardSearchDraft("  smith   street  ", USER);

      expect(takeDashboardSearchForNavigation(USER)).toBe("smith street");

      vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 100);
      expect(writer).not.toHaveBeenCalled();
      unregister();
    });

    it("respects ownership -- a different viewer clears the previous owner's state first", () => {
      setDashboardSearchDraft("smith", "user-a");
      expect(takeDashboardSearchForNavigation("user-b")).toBe("");
      expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "", principalId: "user-b" });
    });
  });

  // #217 build, step 5: the deliberate behaviour change -- a debounce that fires with no writer
  // registered (genuinely off-Dashboard, never arriving) is simply dropped. There is no local
  // `query` copy left for it to update instead, unlike before.
  describe("a commit with no writer registered is dropped, not stored anywhere", () => {
    it("a timer firing with no writer registered writes nothing and throws nothing", () => {
      setDashboardSearchDraft("smith", USER);
      expect(() => vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS)).not.toThrow();
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
    });

    it("commitDashboardSearchNow with no writer registered is a silent no-op", () => {
      setDashboardSearchDraft("smith", USER);
      expect(() => commitDashboardSearchNow(USER)).not.toThrow();
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
    });
  });
});
