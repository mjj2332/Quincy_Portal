import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Topbar } from "./Topbar";

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
const apiDeleteMock = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body), apiDelete: (path: string) => apiDeleteMock(path) };
});
const signOutMock = vi.fn<() => Promise<void>>();
vi.mock("../lib/auth", () => ({ signOut: () => signOutMock() }));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(host: HTMLElement) {
  await act(async () => { root!.render(<Topbar activeView="dashboard" canAccessAdmin={false} user={{ name: "Ada", email: "ada@example.test" }} notificationPollMs={1_000} />); await Promise.resolve(); await Promise.resolve(); });
}

async function click(element: Element) {
  // A native `.click()` (not a bare synthetic `MouseEvent("click")`) — Base UI's Menu.Trigger
  // opens via @floating-ui/react's `useClick`, composed with `useButton`'s own press handling,
  // which a manually dispatched click event does not reliably drive in jsdom.
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiGetMock.mockReset();
  apiPostMock.mockReset().mockResolvedValue({ ok: true });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
  signOutMock.mockReset().mockResolvedValue(undefined);
  apiGetMock.mockResolvedValue({ notifications: [{ id: "n-1", projectId: "p-1", type: "raw_ready", title: "RAW ready for review", body: "12 King Street has RAW images ready for review.", readAt: null, createdAt: "2026-07-28T00:00:00.000Z" }], unreadCount: 1 });
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("Topbar notifications", () => {
  it("exposes personal notification preferences in desktop and mobile account navigation", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    expect(host.querySelectorAll<HTMLAnchorElement>('a[href="/settings/notifications"]')).toHaveLength(1);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Open account and navigation menu"]')!);
    // The menu popup is portaled to `document.body` (a sibling of `host`), not `host`'s own
    // subtree — Base UI's `Menu.Portal`, like `FloatingPortal`, portals by default.
    expect(document.querySelector<HTMLAnchorElement>('[role="menu"][aria-label="Account and navigation menu"] a[href="/settings/notifications"]')).not.toBeNull();
  });

  it("polls on a configurable interval and supports open, focus, escape, outside click, and read", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    expect(apiGetMock).toHaveBeenCalledWith("/api/notifications?limit=25");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(apiGetMock).toHaveBeenCalledTimes(2);

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!;
    await click(trigger);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // `.topbar__notification-item`, not the bare `[role="menuitem"]` — "Mark all read" is also a
    // real `role="menuitem"` now (Menu.Item, ahead of it in DOM order), which is itself a fix:
    // the old markup left it an untagged `<button>` inside a `role="menu"` container.
    const item = document.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-item"]')!;
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    // A mouse/click-initiated open does not move real DOM focus onto an item (Base UI leaves
    // focus on the trigger, avoiding a focus-visible flash for a pointer user); only a
    // keyboard-initiated open (Enter/Space/ArrowDown/Up) does — see §8.1's table and criterion
    // 14.3, which is exercised in Menu.dom.test.tsx.
    await click(item);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/n-1/read", {});

    await click(trigger);
    // Base UI's Escape dismissal listens on `document` (@floating-ui/react's `useDismiss`), not
    // `window` — an event dispatched directly on `window` never reaches a `document` listener,
    // since `window` has no further ancestor for it to bubble through.
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await click(trigger);
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("dismisses an unread notification optimistically without marking it read", async () => {
    let resolveDelete: ((value: unknown) => void) | undefined;
    apiDeleteMock.mockImplementation(() => new Promise((resolve) => { resolveDelete = resolve; }));
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!);
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: RAW ready for review"]')!);
    expect(document.querySelector('[aria-label="Dismiss notification: RAW ready for review"]')).toBeNull();
    expect(document.querySelector('[data-testid="topbar-notifications-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="topbar-notification-badge"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!.getAttribute("aria-label")).toBe("Notifications");
    expect(apiDeleteMock).toHaveBeenCalledWith("/api/notifications/n-1");
    expect(apiPostMock).not.toHaveBeenCalled();
    resolveDelete?.({ ok: true });
  });

  it("does not decrement unread count when dismissing an already-read notification", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "n-unread", projectId: "p-1", type: "raw_ready", title: "Unread notification", body: null, readAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "n-read", projectId: "p-1", type: "raw_ready", title: "Read notification", body: null, readAt: "2026-07-28T01:00:00.000Z", createdAt: "2026-07-28T01:00:00.000Z" },
    ], unreadCount: 1 });
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!);
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: Read notification"]')!);
    expect(document.querySelector('[aria-label="Dismiss notification: Unread notification"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="topbar-notification-badge"]')?.textContent).toBe("1");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!.getAttribute("aria-label")).toBe("1 unread notifications");
  });

  it("hands focus to the next dismiss button, then the open menu when it becomes empty — synchronously", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "n-1", projectId: "p-1", type: "raw_ready", title: "First notification", body: null, readAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "n-2", projectId: "p-1", type: "raw_ready", title: "Second notification", body: null, readAt: null, createdAt: "2026-07-28T01:00:00.000Z" },
    ], unreadCount: 2 });
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: First notification"]')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const secondDismiss = document.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-2"]')!;
    expect(document.activeElement).toBe(secondDismiss);
    // The terminal case (§8.1 item 5, criterion 14.9): the assertion must pass without
    // advancing any timer — that is what proves the `setTimeout(0)` deferral is actually gone
    // and focus lands in the same commit as the removal (the layout effect keyed on the
    // notification array), not on the next tick.
    await click(secondDismiss);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(document.activeElement).toBe(menu);
    expect(document.querySelector('[data-testid="topbar-notifications-empty"]')).not.toBeNull();
  });

  it("hands focus to the previous dismiss button when the last row is dismissed", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "n-1", projectId: "p-1", type: "raw_ready", title: "First notification", body: null, readAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "n-2", projectId: "p-1", type: "raw_ready", title: "Second notification", body: null, readAt: null, createdAt: "2026-07-28T01:00:00.000Z" },
    ], unreadCount: 2 });
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const firstDismiss = document.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-1"]')!;
    // Dismiss the *last* remaining row (Second) — no next row exists, so focus must land on the
    // *previous* one (First), not strand on `<body>` or the (removed) trigger.
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: Second notification"]')!);
    expect(document.activeElement).toBe(firstDismiss);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("activates Mark all read and a dismiss button (Enter/Space's native-button equivalent), both leaving the menu open (closeOnClick=false)", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "n-1", projectId: "p-1", type: "raw_ready", title: "First notification", body: null, readAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "n-2", projectId: "p-1", type: "raw_ready", title: "Second notification", body: null, readAt: null, createdAt: "2026-07-28T01:00:00.000Z" },
    ], unreadCount: 2 });
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // These items pass `nativeButton` explicitly (Base UI's own recommendation for a real
    // `<button>` render target, silencing its "expected a non-<button>" dev warning) — which
    // means Base UI defers Enter/Space activation entirely to the *browser's* native
    // keydown-to-click conversion on real buttons, exactly like `Menu.Trigger`'s default
    // (verified empirically in Menu.dom.test.tsx test 3c: a bare `dispatchEvent(new
    // KeyboardEvent({key:"Enter"}))` on a real <button> produces zero clicks in jsdom). Each
    // assertion below dispatches the real key first, proving that gap directly, before falling
    // back to `.click()` — the browser's own substitute action for the same key, not a shortcut
    // around it. True native-keydown verification is real-browser-only (criterion 18).
    const markAllRead = document.querySelector<HTMLButtonElement>('[data-testid="topbar-mark-all-read"]')!;
    expect(markAllRead.textContent).toBe("Mark all read");
    markAllRead.focus();
    await act(async () => { markAllRead.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(apiPostMock, "a raw Enter keydown alone does not activate it in jsdom").not.toHaveBeenCalledWith("/api/notifications/read-all", {});
    await act(async () => { markAllRead.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/read-all", {});
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    const dismiss = document.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-1"]')!;
    dismiss.focus();
    await act(async () => { dismiss.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(apiDeleteMock, "a raw Enter keydown alone does not activate it in jsdom").not.toHaveBeenCalled();
    await act(async () => { dismiss.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(apiDeleteMock).toHaveBeenCalledWith("/api/notifications/n-1");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("does not intercept a ctrl-click or middle-click on a notification link (native new-tab behavior)", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "project-mention", projectId: "11111111-1111-4111-8111-111111111111", type: "mentioned", title: "You were mentioned", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
    ], unreadCount: 1 });
    await render(host);
    // Spy on the actual navigation primitive `locationStore().push()` calls (`lib/router.ts`) —
    // proof that no SPA navigation was attempted, not just that the event object looks right.
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    await click(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!);
    const link = () => document.querySelector<HTMLAnchorElement>('[data-testid="topbar-notification-item"][data-notification-route="project"]')!;

    const ctrlClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    await act(async () => { link().dispatchEvent(ctrlClick); await Promise.resolve(); await Promise.resolve(); });
    // `InternalLink`'s own SPA-navigation interception (`shouldInterceptInternalLink`) explicitly
    // bails out on `ctrlKey`/`metaKey`/`shiftKey`/`altKey` — a real browser is left to open the
    // link in a new tab natively, which this proves by checking the actual navigation primitive
    // rather than the event object alone.
    expect(ctrlClick.defaultPrevented).toBe(false);
    expect(pushStateSpy).not.toHaveBeenCalled();
    // The row's own `onClick` (mark-as-read) is not modifier-gated — it still fires for any
    // click, ctrl or not, matching a real browser: a ctrl-click both opens a new tab *and* marks
    // the notification read in the tab the user stays on. `closeOnClick` on `Menu.LinkItem` is
    // likewise unconditional (Base UI does not inspect modifier keys), so the menu closes too.
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/project-mention/read", {});
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="menu"]')).toBeNull();

    // Reopen for the middle-click case. A real middle-click fires `auxclick`, not `click` with
    // `button: 1` — browsers never dispatch a `click` event for a non-primary-button press;
    // using the actual `auxclick` event here proves the stronger claim a `click`-with-`button:1`
    // simulation cannot: the handler that intercepts navigation and marks read never runs at all
    // for this event type, so no assertion here can pass by accident.
    apiPostMock.mockClear();
    await click(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!);
    const auxClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    await act(async () => { link().dispatchEvent(auxClick); await Promise.resolve(); await Promise.resolve(); });
    expect(auxClick.defaultPrevented).toBe(false);
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    pushStateSpy.mockRestore();
  });

  it("preserves a specific notification's keyboard highlight identity across a poll's list replacement", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "n-1", projectId: "p-1", type: "raw_ready", title: "First notification", body: null, readAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "n-2", projectId: "p-1", type: "raw_ready", title: "Second notification", body: null, readAt: null, createdAt: "2026-07-28T01:00:00.000Z" },
    ], unreadCount: 2 });
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!;
    trigger.focus();
    // Two ArrowDowns from the trigger: the first lands on "Mark all read" (the head, ahead of
    // the rows in DOM order per §8.1 item 1); the second lands on "First notification"'s own
    // item — the specific row this test tracks identity for.
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
    const firstItem = [...document.querySelectorAll<HTMLElement>('[data-testid="topbar-notification-item"]')].find((el) => el.textContent?.includes("First notification"))!;
    expect(firstItem.textContent).toContain("First notification");
    expect(firstItem.getAttribute("data-highlighted")).toBe("");
    // Real DOM focus, captured by reference — the strongest possible proof of identity, not
    // just matching content after the fact.
    expect(document.activeElement).toBe(firstItem);

    // The next poll returns a reordered array (a third notification arrives *ahead* of the
    // tracked one, shifting its array index from 0 to 1) while the menu stays open.
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "n-3", projectId: "p-1", type: "raw_ready", title: "Third notification", body: null, readAt: null, createdAt: "2026-07-28T02:00:00.000Z" },
      { id: "n-1", projectId: "p-1", type: "raw_ready", title: "First notification", body: null, readAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
      { id: "n-2", projectId: "p-1", type: "raw_ready", title: "Second notification", body: null, readAt: null, createdAt: "2026-07-28T01:00:00.000Z" },
    ], unreadCount: 3 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    // Still open, still functional, and the new item is present (§8.1 item 4: "no bookkeeping
    // from us" — the primitive re-registers on render).
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="topbar-notification-item"]')).toHaveLength(3);
    expect(document.querySelector('[data-notification-dismiss="n-3"]')).not.toBeNull();
    // Identity, not just content, survives the array-index shift: React's `key={n.id}` keeps
    // "First notification" as the *same* DOM node, even though it moved from array index 0 to
    // index 1 — it was never torn down and rebuilt as "the item now at index 0".
    const firstItemAfter = [...document.querySelectorAll<HTMLElement>('[data-testid="topbar-notification-item"]')].find((el) => el.textContent?.includes("First notification"))!;
    expect(firstItemAfter.textContent).toContain("First notification");
    expect(firstItemAfter).toBe(firstItem);
    // Real, actual DOM focus — the accessibility-critical guarantee — stays on that same node
    // (verified directly, not inferred): a keyboard user's position in the list is not lost to a
    // background poll. This is a *browser*-level guarantee that follows directly from the DOM
    // node surviving unchanged, independent of any library bookkeeping.
    expect(document.activeElement).toBe(firstItemAfter);
    // Base UI's own `data-highlighted` *styling* attribute, by contrast, is not automatically
    // carried across a full item-list re-registration (verified empirically: it resets to
    // absent here even though the underlying DOM node and real focus are both preserved) — a
    // real, disclosed gap between "the keyboard user's actual focus" (preserved) and "the
    // primitive's own highlight-ring paint" (not), not a stranding of focus itself. Recorded in
    // the drift register's real-browser-only list rather than asserted as fixed here.
    expect(firstItemAfter.getAttribute("data-highlighted")).toBeNull();
  });

  it("links every project notification, opening collaboration only for collaboration notifications, then marks them read without waiting", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    apiGetMock.mockResolvedValue({ notifications: [
      { id: "project-mention", projectId, type: "mentioned", title: "You were mentioned", body: "Comment", readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "board-mention", projectId: null, type: "mentioned", title: "You were mentioned", body: "Notice", readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-subtask", projectId, type: "subtask_assigned", title: "Subtask assigned", body: "Checklist", readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-due", projectId, type: "subtask_due_today", title: "Due today", body: "Checklist", readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-raw", projectId, type: "raw_ready", title: "RAW", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-edited", projectId, type: "edited_landed", title: "Edited", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-editing", projectId, type: "sent_to_editing", title: "Editing", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-stalled", projectId, type: "autohdr_stalled", title: "Stalled", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-delivered", projectId, type: "delivered", title: "Delivered", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-comment", projectId, type: "comment_added", title: "Comment", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
      { id: "project-assigned", projectId, type: "assigned_to_project", title: "Assigned", body: null, readAt: null, createdAt: "2026-08-17T00:00:00.000Z" },
    ], unreadCount: 11 });
    const host = document.body.firstElementChild as HTMLElement;
    await render(host); await click(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!);
    const links = document.querySelectorAll<HTMLAnchorElement>(`a[href="/projects/${projectId}?collaboration=open"]`);
    expect(links).toHaveLength(3); expect([...links].map((link) => link.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("You were mentioned"), expect.stringContaining("Subtask assigned"), expect.stringContaining("Due today")]));
    expect(document.querySelectorAll(`a[href="/projects/${projectId}"]`)).toHaveLength(7);
    const link = links[0]!;
    expect(link.getAttribute("role")).toBe("menuitem");
    expect([...document.querySelectorAll('[data-testid="topbar-notification-item"][data-notification-route="none"]')].map((button) => button.textContent)).toEqual([expect.stringContaining("You were mentioned")]);
    expect(document.querySelectorAll('[data-testid="topbar-notification-item"][data-notification-route="none"]')).toHaveLength(1);
    await click(link);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/project-mention/read", {});
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("Topbar mobile menu", () => {
  it("marks the current view active and calls signOut when Sign out is activated", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => {
      root!.render(<Topbar activeView="admin" canAccessAdmin user={{ name: "Ada", email: "ada@example.test" }} notificationPollMs={1_000} />);
      await Promise.resolve(); await Promise.resolve();
    });
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Open account and navigation menu"]')!);

    const dashboard = document.querySelector<HTMLAnchorElement>('[role="menu"][aria-label="Account and navigation menu"] a[href="/"]')!;
    const admin = document.querySelector<HTMLAnchorElement>('[role="menu"][aria-label="Account and navigation menu"] a[href="/admin"]')!;
    expect(dashboard.hasAttribute("data-active")).toBe(false);
    expect(admin.getAttribute("data-active")).toBe("");

    const signOutButton = host.querySelector<HTMLButtonElement>('[data-testid="topbar-signout"]')!;
    await act(async () => { signOutButton.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(signOutMock).toHaveBeenCalledOnce();
  });
});

describe("Topbar shell convergence (§9.3)", () => {
  it("gives the brand link a 44px phone touch target and no legacy button class", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    const brand = host.querySelector<HTMLAnchorElement>('[aria-label="Quincy Portal home"]')!;
    expect(brand.classList.contains("max-[721px]:min-h-[44px]")).toBe(true);
    expect(brand.classList.contains("button--text")).toBe(false);
  });

  it("collapses the desktop cluster in two independent stages (1007px, then 771px), not one", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);

    const identity = host.querySelector('[data-testid="topbar-identity"]')!;
    const avatar = host.querySelector('[data-slot="avatar"]')!;
    expect(identity.classList.contains("max-[1007px]:hidden")).toBe(true);
    expect(avatar.classList.contains("max-[1007px]:hidden")).toBe(true);
    // The retired `.avatar` class must not have come back on either element.
    expect(avatar.classList.contains("avatar")).toBe(false);
    expect(identity.classList.contains("avatar")).toBe(false);

    const prefsLink = host.querySelector<HTMLAnchorElement>('a[href="/settings/notifications"]')!;
    const signOutButton = host.querySelector<HTMLButtonElement>('[data-testid="topbar-signout"]')!;
    expect(prefsLink.classList.contains("max-[771px]:hidden")).toBe(true);
    expect(prefsLink.classList.contains("button--text")).toBe(false);
    expect(signOutButton.classList.contains("max-[771px]:hidden")).toBe(true);
    expect(signOutButton.classList.contains("button--text")).toBe(false);

    const menuTrigger = host.querySelector('[aria-label="Open account and navigation menu"]')!;
    expect(menuTrigger.classList.contains("hidden")).toBe(true);
    expect(menuTrigger.classList.contains("max-[771px]:inline-flex")).toBe(true);
    expect(menuTrigger.classList.contains("min-h-[44px]")).toBe(true);
    expect(menuTrigger.classList.contains("ml-auto")).toBe(true);
  });

  it("supplies the notification trigger icon size and wrapper positioning app.css no longer does", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    const trigger = host.querySelector('[data-testid="topbar-notification-trigger"]')!;
    expect(trigger.classList.contains("[&_svg]:size-[19px]")).toBe(true);
    const wrapper = host.querySelector('[data-testid="topbar-notifications"]')!;
    expect(wrapper.classList.contains("relative")).toBe(true);
  });

  it("keeps the mobile menu panel free of any display-setting utility, and app.css free of any rule targeting it (defect B4 regression guard)", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Open account and navigation menu"]')!);
    const panel = document.querySelector('[role="menu"][aria-label="Account and navigation menu"]')!;
    expect(panel).not.toBeNull();
    // Structural guard only (§9.3): happy-dom applies no stylesheet and computes no layout, so
    // this cannot prove the panel paints — that is §10.2 item 14's job. This proves the panel
    // carries no class that would hide it, and that no CSS rule exists that could.
    expect(panel.classList.contains("hidden")).toBe(false);
    expect([...panel.classList].some((cls) => /(?:^|:)(?:hidden|block|flex|grid|inline|inline-flex|inline-grid|table|contents|none)$/.test(cls))).toBe(false);

    // happy-dom's global `URL` does not resolve a relative path against a `file:` base
    // correctly (it substitutes its own emulated page location), so the path is built with
    // `node:path` against this test file's own absolute path instead of `new URL(rel, base)`.
    const appCssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "styles", "app.css");
    const appCss = readFileSync(appCssPath, "utf8");
    expect(appCss).not.toMatch(/\.topbar__mobile-menu\b/);
  });

  // §3/§8a (D-01): wiring, not mechanism — which of the app's two menus gets the backdrop.
  // Base UI's shared `usePositioner` stamps `role="presentation"` on the Positioner wrapper
  // itself, independent of any Backdrop, so a bare `[role="presentation"]` selector is
  // ambiguous once a menu is open — it always matches the Positioner. The Backdrop is the
  // *other* one: it never wraps the `role="menu"` popup, where the Positioner always does.
  function backdropEl() {
    return [...document.querySelectorAll<HTMLElement>('[role="presentation"]')].find((el) => !el.querySelector('[role="menu"]')) ?? null;
  }

  it("dims the page behind the mobile account/navigation menu", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Open account and navigation menu"]')!);
    expect(document.querySelector('[role="menu"][aria-label="Account and navigation menu"]')).not.toBeNull();
    expect(backdropEl()).not.toBeNull();
  });

  it("does not dim the page behind the notification menu", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await render(host);
    await click(host.querySelector<HTMLButtonElement>('[data-testid="topbar-notification-trigger"]')!);
    expect(document.querySelector('[role="menu"][aria-label="Notifications"]')).not.toBeNull();
    expect(backdropEl()).toBeNull();
  });
});
