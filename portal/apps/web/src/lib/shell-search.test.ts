import { beforeEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({
  push: vi.fn<(location: string) => void>(),
  location: "/",
}));

vi.mock("./router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./router")>();
  return {
    ...actual,
    locationStore: () => ({
      getLocation: () => routerMock.location,
      push: routerMock.push,
    }),
  };
});

import {
  activateProjectSearch,
  consumeProjectSearchFocus,
  getProjectSearchFocusToken,
  isSearchShortcut,
  requestProjectSearchFocus,
  subscribeProjectSearchFocus,
} from "./shell-search";
import type { RailShortcutEvent } from "./shell-rail";

const BASE_EVENT: RailShortcutEvent = {
  key: "k",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  target: null,
};

beforeEach(() => {
  routerMock.push.mockClear();
  routerMock.location = "/";
  // Drain any request left latched by a previous test — `consumeProjectSearchFocus` is the only
  // way to clear the module-level store, since there is no cancel.
  consumeProjectSearchFocus();
});

describe("requestProjectSearchFocus / consumeProjectSearchFocus — the latch", () => {
  it("latches a request made before anything subscribes", () => {
    requestProjectSearchFocus();
    expect(consumeProjectSearchFocus()).toBe(true);
  });

  it("a second consume with no new request in between reports false", () => {
    requestProjectSearchFocus();
    expect(consumeProjectSearchFocus()).toBe(true);
    expect(consumeProjectSearchFocus()).toBe(false);
  });

  it("consuming with nothing pending reports false", () => {
    expect(consumeProjectSearchFocus()).toBe(false);
  });

  it("a request made after a consume can be consumed again", () => {
    requestProjectSearchFocus();
    expect(consumeProjectSearchFocus()).toBe(true);
    requestProjectSearchFocus();
    expect(consumeProjectSearchFocus()).toBe(true);
  });
});

describe("subscribeProjectSearchFocus / getProjectSearchFocusToken — the useSyncExternalStore shape", () => {
  it("notifies every subscriber on a request", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectSearchFocus(listener);
    requestProjectSearchFocus();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops notifying once unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectSearchFocus(listener);
    unsubscribe();
    requestProjectSearchFocus();
    expect(listener).not.toHaveBeenCalled();
  });

  it("bumps the token on every request, so a snapshot read differs", () => {
    const before = getProjectSearchFocusToken();
    requestProjectSearchFocus();
    expect(getProjectSearchFocusToken()).not.toBe(before);
  });

  it("does not bump the token on a mere consume", () => {
    requestProjectSearchFocus();
    const afterRequest = getProjectSearchFocusToken();
    consumeProjectSearchFocus();
    expect(getProjectSearchFocusToken()).toBe(afterRequest);
  });
});

describe("activateProjectSearch — navigate off-dashboard, then latch", () => {
  it("pushes the Dashboard href when the current location is not the Dashboard", () => {
    routerMock.location = "/admin";
    activateProjectSearch("/");
    expect(routerMock.push).toHaveBeenCalledOnce();
    expect(routerMock.push).toHaveBeenCalledWith("/");
    expect(consumeProjectSearchFocus()).toBe(true);
  });

  it("does not push when the current location is already a Dashboard view", () => {
    routerMock.location = "/?view=kanban";
    activateProjectSearch("/");
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(consumeProjectSearchFocus()).toBe(true);
  });

  it("leaves a Dashboard Calendar facet URL untouched", () => {
    routerMock.location = "/?view=calendar&date=2026-08-12&sub=month&layers=project";
    activateProjectSearch("/");
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});

describe("isSearchShortcut — ⌘K/Ctrl+K", () => {
  it("fires on Meta+K", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true })).toBe(true);
  });

  it("fires on Ctrl+K", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, ctrlKey: true })).toBe(true);
  });

  it("rejects a bare K with no modifier", () => {
    expect(isSearchShortcut(BASE_EVENT)).toBe(false);
  });

  it("rejects a different key even with the modifier held", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true, key: "b" })).toBe(false);
  });

  it("rejects a repeat (held key)", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true, repeat: true })).toBe(false);
  });

  it("rejects while an IME composition is in progress", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true, isComposing: true })).toBe(false);
  });

  it("rejects an editable target", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true, target: { tagName: "INPUT" } })).toBe(false);
  });
});
