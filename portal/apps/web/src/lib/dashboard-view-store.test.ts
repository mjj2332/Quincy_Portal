/**
 * The Dashboard-view publication store — issue #119. Node-environment test (`*.test.ts`, no
 * `window`/DOM): covers owner/publish/release semantics and listener notification in isolation
 * from React, the same split `toast-store.test.ts` uses for its own module-level store.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  publishDashboardView,
  readDashboardView,
  releaseDashboardView,
  resetDashboardViewStoreForTests,
  subscribeDashboardView,
} from "./dashboard-view-store";

afterEach(() => {
  resetDashboardViewStoreForTests();
});

describe("dashboard-view-store", () => {
  it("reads null before anything has published", () => {
    expect(readDashboardView()).toBeNull();
  });

  it("publishes and reads back the view", () => {
    const owner = {};
    publishDashboardView(owner, "board");
    expect(readDashboardView()).toBe("board");
  });

  it("notifies subscribers on a publish", () => {
    const owner = {};
    let notifications = 0;
    const unsubscribe = subscribeDashboardView(() => { notifications++; });
    publishDashboardView(owner, "table");
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("publishing the same owner and view again notifies nobody — no render loop", () => {
    const owner = {};
    let notifications = 0;
    publishDashboardView(owner, "table");
    const unsubscribe = subscribeDashboardView(() => { notifications++; });
    publishDashboardView(owner, "table");
    expect(notifications).toBe(0);
    expect(readDashboardView()).toBe("table");
    unsubscribe();
  });

  it("the same owner publishing a DIFFERENT view still notifies", () => {
    const owner = {};
    publishDashboardView(owner, "table");
    let notifications = 0;
    const unsubscribe = subscribeDashboardView(() => { notifications++; });
    publishDashboardView(owner, "board");
    expect(notifications).toBe(1);
    expect(readDashboardView()).toBe("board");
    unsubscribe();
  });

  it("last publisher wins and becomes owner", () => {
    const first = {};
    const second = {};
    publishDashboardView(first, "table");
    publishDashboardView(second, "calendar");
    expect(readDashboardView()).toBe("calendar");
    // The first owner's release is now stale — the second owner is current — and must be a no-op.
    releaseDashboardView(first);
    expect(readDashboardView()).toBe("calendar");
  });

  it("a stale owner's release is a no-op and does not notify", () => {
    const first = {};
    const second = {};
    publishDashboardView(first, "table");
    publishDashboardView(second, "board");
    let notifications = 0;
    const unsubscribe = subscribeDashboardView(() => { notifications++; });
    releaseDashboardView(first);
    expect(notifications).toBe(0);
    expect(readDashboardView()).toBe("board");
    unsubscribe();
  });

  it("the current owner's release clears the view and notifies", () => {
    const owner = {};
    publishDashboardView(owner, "calendar");
    let notifications = 0;
    const unsubscribe = subscribeDashboardView(() => { notifications++; });
    releaseDashboardView(owner);
    expect(notifications).toBe(1);
    expect(readDashboardView()).toBeNull();
    unsubscribe();
  });

  it("releasing when nothing has ever published is a no-op", () => {
    let notifications = 0;
    const unsubscribe = subscribeDashboardView(() => { notifications++; });
    releaseDashboardView({});
    expect(notifications).toBe(0);
    expect(readDashboardView()).toBeNull();
    unsubscribe();
  });

  it("a different owner publishing the SAME view still becomes owner and notifies, and only its own release clears the store", () => {
    const first = {};
    const second = {};
    publishDashboardView(first, "board");
    let notifications = 0;
    const unsubscribe = subscribeDashboardView(() => { notifications++; });
    publishDashboardView(second, "board");
    expect(notifications).toBe(1);
    expect(readDashboardView()).toBe("board");
    releaseDashboardView(first);
    expect(notifications).toBe(1);
    expect(readDashboardView()).toBe("board");
    releaseDashboardView(second);
    expect(notifications).toBe(2);
    expect(readDashboardView()).toBeNull();
    unsubscribe();
  });

  it("unsubscribe stops further notifications to that listener", () => {
    const owner = {};
    let notifications = 0;
    const unsubscribe = subscribeDashboardView(() => { notifications++; });
    publishDashboardView(owner, "table");
    unsubscribe();
    publishDashboardView(owner, "board");
    expect(notifications).toBe(1);
  });
});
