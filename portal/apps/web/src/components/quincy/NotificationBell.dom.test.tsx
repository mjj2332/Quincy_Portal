import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStaffNavigation } from "../../lib/staff-navigation";
import { parseStaffLocation } from "../../lib/router";
import { SidebarProvider } from "@/components/reui/sidebar";
import { NavigationRail } from "./NavigationRail";
import { NotificationBell } from "./NotificationBell";

/**
 * The rail's own bell — #112. Covers the trigger/badge (count, `99+` cap, absence at zero,
 * rendering inside a collapsed rail) and the panel itself: dialog semantics, focus handoff,
 * modifier/middle click, poll identity, collaboration deep links and the no-backdrop contract.
 * #113 owns porting the Topbar's own full parity suite and re-anchoring the panel at 420px.
 */

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const apiDeleteMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    apiGet: (path: string) => apiGetMock(path),
    apiPost: (path: string, body: unknown) => apiPostMock(path, body),
    apiDelete: (path: string) => apiDeleteMock(path),
  };
});

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: React.ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

function notificationsResponse(unreadCount: number) {
  return {
    unreadCount,
    notifications: Array.from({ length: Math.min(unreadCount, 3) }, (_, index) => ({
      id: `n-${index}`,
      projectId: null,
      type: "mentioned",
      title: `Notification ${index}`,
      body: null,
      readAt: null,
      createdAt: "2026-08-17T00:00:00.000Z",
    })),
  };
}

type NotificationOverrides = Partial<{
  id: string;
  projectId: string | null;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}>;

function notification(overrides: NotificationOverrides = {}) {
  return {
    id: "n-1",
    projectId: null,
    type: "mentioned",
    title: "First notification",
    body: null,
    readAt: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset().mockResolvedValue({ ok: true });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  // Popover content portals to `document.body`, outside `host` — a plain `host.remove()` would
  // leave it behind for the next test, so every leftover body child (`host` included) goes too.
  document.body.replaceChildren();
});

const USER = { name: "Terry Lee", email: "terry@example.test" };

describe("NotificationBell", () => {
  it("shows the unread count in the badge", async () => {
    apiGetMock.mockResolvedValue(notificationsResponse(3));
    await render(<NotificationBell />);
    const badge = host.querySelector('[data-testid="rail-notification-badge"]');
    expect(badge?.textContent).toBe("3");
  });

  it("caps the badge at 99+ above 99 unread", async () => {
    apiGetMock.mockResolvedValue(notificationsResponse(140));
    await render(<NotificationBell />);
    const badge = host.querySelector('[data-testid="rail-notification-badge"]');
    expect(badge?.textContent).toBe("99+");
  });

  it("shows no badge at zero unread", async () => {
    apiGetMock.mockResolvedValue(notificationsResponse(0));
    await render(<NotificationBell />);
    expect(host.querySelector('[data-testid="rail-notification-badge"]')).toBeNull();
    expect(host.querySelector('[data-testid="rail-notification-trigger"]')?.getAttribute("aria-label")).toBe("Notifications");
  });

  it("renders, badge included, inside a collapsed rail", async () => {
    apiGetMock.mockResolvedValue(notificationsResponse(2));
    const navigation = buildStaffNavigation(parseStaffLocation("/"), "kanban", {
      adminBackend: true,
      viewProductionCalendar: true,
    });
    // #122: `NavigationRail` is built on base-nova's full `reui/sidebar.tsx`, whose primitives
    // throw outside a `SidebarProvider` — see `NavigationRail.dom.test.tsx`'s own `renderInProvider`.
    await render(
      <SidebarProvider open={false} onOpenChange={() => {}}>
        <NavigationRail navigation={navigation} user={USER} variant="collapsed" />
      </SidebarProvider>,
    );
    expect(host.querySelector('[data-testid="rail-notification-trigger"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-notification-badge"]')?.textContent).toBe("2");
  });
});

describe("NotificationBell panel (Popover)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function renderPanel(poll = 1_000) {
    await render(<NotificationBell poll={poll} />);
    return host.querySelector<HTMLButtonElement>('[data-testid="rail-notification-trigger"]')!;
  }

  /** A native `.click()`, not a bare synthetic `MouseEvent("click")` — see `Topbar.dom.test.tsx`. */
  async function click(element: Element) {
    await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
    // Base UI's floating-focus-manager queues the initial-focus move via `requestAnimationFrame`
    // (`enqueueFocus`), one frame removed from the triggering click — under fake timers that
    // needs an explicit advance past a frame boundary, not just a microtask flush.
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  }

  /** A timer-free click — microtask flush only — so a dismiss-focus assertion runs before any
   *  timer advance could mask a regression that deferred the handoff off the same commit. */
  async function clickNoAdvance(element: Element) {
    await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); });
  }

  it("opens a non-modal dialog labelled Notifications, with mark-all and rows in Tab order, no menu roles", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      notification({ projectId: "p-1", type: "raw_ready" }),
    ], unreadCount: 1 });
    const trigger = await renderPanel();
    await click(trigger);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Notifications");
    // the dialog's accessible NAME, not just its text content: `aria-labelledby`
    // must resolve to an element (`PopoverTitle`'s own `<h2>`) whose text is "Notifications".
    const labelledBy = dialog!.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Notifications");
    // `NotificationBellProps.align` defaults to `"start"`; `renderPanel` above renders the bare
    // `<NotificationBell />` the rail header uses, with no `align` passed.
    expect(dialog!.getAttribute("data-align")).toBe("start");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
    // Real DOM focus lands on the dialog itself, not a stray control — every open type (mouse or
    // keyboard) announces "Notifications, dialog" rather than risking an accidental mark-all.
    expect(document.activeElement).toBe(dialog);

    // Safari/VoiceOver drops list semantics from a `<ul>` styled `list-none`;
    // an explicit `role="list"` restores them. The rows live inside it.
    const list = dialog!.querySelector('[role="list"]');
    expect(list).not.toBeNull();
    expect(list!.querySelector('[data-testid="rail-notification-item"]')).not.toBeNull();

    const markAll = document.querySelector<HTMLButtonElement>('[data-testid="rail-mark-all-read"]')!;
    const item = document.querySelector<HTMLAnchorElement>('[data-testid="rail-notification-item"]')!;
    const dismiss = document.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-1"]')!;
    expect(item.tagName).toBe("A");
    // Tab order: mark-all, then the row's link, then its dismiss — the same DOM order the old
    // Menu-based panel used, now with no roving-focus machinery behind it.
    const focusable = [...dialog!.querySelectorAll<HTMLElement>("button, a")];
    expect(focusable.indexOf(markAll)).toBeLessThan(focusable.indexOf(item));
    expect(focusable.indexOf(item)).toBeLessThan(focusable.indexOf(dismiss));
  });

  it("shows the header count, capped the same way as the trigger badge", async () => {
    apiGetMock.mockResolvedValue(notificationsResponse(140));
    const trigger = await renderPanel();
    await click(trigger);
    expect(document.querySelector('[data-testid="rail-notifications-count"]')?.textContent).toBe("99+");
  });

  it("marks unread rows only via data-unread", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      notification({ id: "n-unread", title: "Unread" }),
      notification({ id: "n-read", title: "Read", readAt: "2026-07-28T01:00:00.000Z", createdAt: "2026-07-28T01:00:00.000Z" }),
    ], unreadCount: 1 });
    const trigger = await renderPanel();
    await click(trigger);
    const rows = [...document.querySelectorAll<HTMLLIElement>("li")];
    const unreadRow = rows.find((row) => row.textContent?.includes("Unread"))!;
    const readRow = rows.find((row) => row.textContent?.includes("Read"))!;
    expect(unreadRow.hasAttribute("data-unread")).toBe(true);
    expect(readRow.hasAttribute("data-unread")).toBe(false);
  });

  it("marks a row read and closes the panel on activation", async () => {
    apiGetMock.mockResolvedValue({ notifications: [notification()], unreadCount: 1 });
    const trigger = await renderPanel();
    await click(trigger);
    await click(document.querySelector<HTMLButtonElement>('[data-testid="rail-notification-item"]')!);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/n-1/read", {});
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("dismisses an unread notification optimistically without marking it read", async () => {
    let resolveDelete: ((value: unknown) => void) | undefined;
    apiDeleteMock.mockImplementation(() => new Promise((resolve) => { resolveDelete = resolve; }));
    apiGetMock.mockResolvedValue({ notifications: [notification()], unreadCount: 1 });
    const trigger = await renderPanel();
    await click(trigger);
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: First notification"]')!);
    expect(document.querySelector('[aria-label="Dismiss notification: First notification"]')).toBeNull();
    expect(document.querySelector('[data-testid="rail-notifications-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-notification-badge"]')).toBeNull();
    expect(apiDeleteMock).toHaveBeenCalledWith("/api/notifications/n-1");
    expect(apiPostMock).not.toHaveBeenCalled();
    resolveDelete?.({ ok: true });
  });

  it("does not decrement unread count when dismissing an already-read notification", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      notification({ id: "n-unread", title: "Unread notification" }),
      notification({ id: "n-read", title: "Read notification", readAt: "2026-07-28T01:00:00.000Z", createdAt: "2026-07-28T01:00:00.000Z" }),
    ], unreadCount: 1 });
    const trigger = await renderPanel();
    await click(trigger);
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: Read notification"]')!);
    expect(document.querySelector('[aria-label="Dismiss notification: Unread notification"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-notification-badge"]')?.textContent).toBe("1");
  });

  it("hands focus to the next dismiss button, then the panel when it becomes empty — synchronously", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      notification(),
      notification({ id: "n-2", title: "Second notification", createdAt: "2026-07-28T01:00:00.000Z" }),
    ], unreadCount: 2 });
    const trigger = await renderPanel();
    await click(trigger);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // Timer-free click — the assertion below runs with no timer advance in between.
    await clickNoAdvance(document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: First notification"]')!);
    const secondDismiss = document.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-2"]')!;
    expect(document.activeElement).toBe(secondDismiss);

    // Terminal case — no timer advance, proving focus lands in the same commit as the removal.
    await clickNoAdvance(secondDismiss);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    expect(document.querySelector('[data-testid="rail-notifications-empty"]')).not.toBeNull();
  });

  it("hands focus to the previous dismiss button when the last row is dismissed", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      notification(),
      notification({ id: "n-2", title: "Second notification", createdAt: "2026-07-28T01:00:00.000Z" }),
    ], unreadCount: 2 });
    const trigger = await renderPanel();
    await click(trigger);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const firstDismiss = document.querySelector<HTMLButtonElement>('[data-notification-dismiss="n-1"]')!;
    // Timer-free click — the assertion below runs with no timer advance in between.
    await clickNoAdvance(document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification: Second notification"]')!);
    expect(document.activeElement).toBe(firstDismiss);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("keeps mark-all mounted and aria-disabled at zero unread, marks all read while keeping the panel open at unread", async () => {
    apiGetMock.mockResolvedValue({ notifications: [], unreadCount: 0 });
    const trigger = await renderPanel();
    await click(trigger);
    const markAllAtZero = document.querySelector<HTMLButtonElement>('[data-testid="rail-mark-all-read"]')!;
    expect(markAllAtZero).not.toBeNull();
    expect(markAllAtZero.getAttribute("aria-disabled")).toBe("true");
    expect(markAllAtZero.hasAttribute("disabled")).toBe(false);
    markAllAtZero.focus();
    await click(markAllAtZero);
    expect(apiPostMock).not.toHaveBeenCalledWith("/api/notifications/read-all", {});
    // The handler's early return does not drop focus off the still-focused control — unlike the
    // `disabled` attribute, `aria-disabled` never forces focus to `<body>`.
    expect(document.activeElement).toBe(markAllAtZero);

    // The panel never closed (mark-all's own click does not call `setOpen`) — a poll can update
    // its content, including the still-mounted mark-all control, while it stays open.
    apiGetMock.mockResolvedValue({ notifications: [
      notification(),
    ], unreadCount: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const markAll = document.querySelector<HTMLButtonElement>('[data-testid="rail-mark-all-read"]')!;
    expect(markAll.getAttribute("aria-disabled")).toBeNull();
    markAll.focus();
    await click(markAll);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/read-all", {});
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(markAll);
  });

  it("preserves native modified-click behavior and read semantics on ctrl, meta and middle click", async () => {
    // three distinct unread rows, one per modifier: a middle click reusing the
    // row a Ctrl-click already marked read would prove nothing about auxclick's own no-op case.
    apiGetMock.mockResolvedValue({ notifications: [
      notification({ id: "row-a", projectId: "11111111-1111-4111-8111-111111111111", title: "Row A", createdAt: "2026-08-17T00:00:00.000Z" }),
      notification({ id: "row-b", projectId: "22222222-2222-4222-8222-222222222222", title: "Row B", createdAt: "2026-08-17T00:00:00.000Z" }),
      notification({ id: "row-c", projectId: "33333333-3333-4333-8333-333333333333", title: "Row C", createdAt: "2026-08-17T00:00:00.000Z" }),
    ], unreadCount: 3 });
    const trigger = await renderPanel();
    const pushStateSpy = vi.spyOn(window.history, "pushState");
    const rowLink = (id: string) => document.querySelector<HTMLAnchorElement>(`[data-notification-dismiss="${id}"]`)!.closest("li")!.querySelector<HTMLAnchorElement>('[data-testid="rail-notification-item"][data-notification-route="project"]')!;
    const rowLi = (id: string) => document.querySelector<HTMLButtonElement>(`[data-notification-dismiss="${id}"]`)!.closest("li")!;

    await click(trigger);
    const ctrlClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    await act(async () => { rowLink("row-a").dispatchEvent(ctrlClick); await Promise.resolve(); await Promise.resolve(); });
    expect(ctrlClick.defaultPrevented).toBe(false);
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/row-a/read", {});
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    apiPostMock.mockClear();
    await click(trigger);
    const metaClick = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
    await act(async () => { rowLink("row-b").dispatchEvent(metaClick); await Promise.resolve(); await Promise.resolve(); });
    expect(metaClick.defaultPrevented).toBe(false);
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/row-b/read", {});
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    apiPostMock.mockClear();
    await click(trigger);
    // Row C is still unread — the trigger badge/header count reflect it before the auxclick.
    expect(host.querySelector('[data-testid="rail-notification-badge"]')?.textContent).toBe("1");
    const auxClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    await act(async () => { rowLink("row-c").dispatchEvent(auxClick); await Promise.resolve(); await Promise.resolve(); });
    expect(auxClick.defaultPrevented).toBe(false);
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(rowLi("row-c").hasAttribute("data-unread")).toBe(true);
    expect(host.querySelector('[data-testid="rail-notification-badge"]')?.textContent).toBe("1");
    pushStateSpy.mockRestore();
  });

  it("preserves a specific notification's DOM focus identity across a poll's list replacement", async () => {
    apiGetMock.mockResolvedValue({ notifications: [
      notification(),
      notification({ id: "n-2", title: "Second notification", createdAt: "2026-07-28T01:00:00.000Z" }),
    ], unreadCount: 2 });
    const trigger = await renderPanel();
    await click(trigger);
    const firstItem = [...document.querySelectorAll<HTMLElement>('[data-testid="rail-notification-item"]')].find((el) => el.textContent?.includes("First notification"))!;
    firstItem.focus();
    expect(document.activeElement).toBe(firstItem);

    // A third notification arrives ahead of the tracked one, shifting its array index from 0 to 1,
    // while the panel stays open.
    apiGetMock.mockResolvedValue({ notifications: [
      notification({ id: "n-3", title: "Third notification", createdAt: "2026-07-28T02:00:00.000Z" }),
      notification(),
      notification({ id: "n-2", title: "Second notification", createdAt: "2026-07-28T01:00:00.000Z" }),
    ], unreadCount: 3 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="rail-notification-item"]')).toHaveLength(3);
    const firstItemAfter = [...document.querySelectorAll<HTMLElement>('[data-testid="rail-notification-item"]')].find((el) => el.textContent?.includes("First notification"))!;
    // React's `key={n.id}` keeps this the SAME DOM node — real, actual DOM focus survives the
    // reorder, independent of any library bookkeeping (there is no `data-highlighted` here at
    // all: rows are plain elements, not a Base UI Menu's roving-focus items).
    expect(firstItemAfter).toBe(firstItem);
    expect(document.activeElement).toBe(firstItemAfter);
  });

  it("links every project notification, opening collaboration only for collaboration types, then marks them read", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    apiGetMock.mockResolvedValue({ notifications: [
      notification({ id: "project-mention", projectId, title: "You were mentioned", body: "Comment", createdAt: "2026-08-17T00:00:00.000Z" }),
      notification({ id: "board-mention", title: "You were mentioned", body: "Notice", createdAt: "2026-08-17T00:00:00.000Z" }),
      notification({ id: "project-subtask", projectId, type: "subtask_assigned", title: "Subtask assigned", body: "Checklist", createdAt: "2026-08-17T00:00:00.000Z" }),
      notification({ id: "project-due", projectId, type: "subtask_due_today", title: "Due today", body: "Checklist", createdAt: "2026-08-17T00:00:00.000Z" }),
      notification({ id: "project-raw", projectId, type: "raw_ready", title: "RAW", createdAt: "2026-08-17T00:00:00.000Z" }),
    ], unreadCount: 5 });
    const trigger = await renderPanel();
    await click(trigger);
    const collabLinks = document.querySelectorAll<HTMLAnchorElement>(`a[href="/projects/${projectId}?collaboration=open"]`);
    expect(collabLinks).toHaveLength(3);
    expect(document.querySelectorAll(`a[href="/projects/${projectId}"]`)).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="rail-notification-item"][data-notification-route="none"]')).toHaveLength(1);
    await click(collabLinks[0]!);
    expect(apiPostMock).toHaveBeenCalledWith("/api/notifications/project-mention/read", {});
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not dim the page behind the notification panel and leaves it interactive", async () => {
    apiGetMock.mockResolvedValue(notificationsResponse(1));
    const trigger = await renderPanel();
    await click(trigger);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.getAttribute("aria-hidden")).toBeNull();
    expect(document.body.hasAttribute("inert")).toBe(false);
    expect(host.hasAttribute("inert")).toBe(false);
  });

  it("returns focus to the trigger on Escape, and closes on an outside press", async () => {
    apiGetMock.mockResolvedValue(notificationsResponse(1));
    const trigger = await renderPanel();
    await click(trigger);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await click(trigger);
    // Popover's own outside-press dismiss is `modal={false}` → `outsidePressEvent: "intentional"`
    // for mouse (Base UI's `PopoverRoot`), which only ever reacts to the terminal `click` event of
    // a press-release pair — unlike `quincy/menu.tsx`'s Menu, which stays "sloppy" (pointerdown
    // alone, `Topbar.dom.test.tsx`'s own outside-click case) and needs no release. A bare
    // `pointerdown` is deliberately not enough here.
    await act(async () => { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // Base UI's default `finalFocus` (never overridden) returns focus to the trigger even when
    // the close was caused by an outside press rather than Escape, since `document.body` (the
    // press target) is not itself focusable.
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the caught-up empty state when there are no notifications", async () => {
    apiGetMock.mockResolvedValue({ notifications: [], unreadCount: 0 });
    const trigger = await renderPanel();
    await click(trigger);
    expect(document.querySelector('[data-testid="rail-notifications-empty"]')).not.toBeNull();
  });

  it("leaves the bell usable after a failed poll", async () => {
    apiGetMock.mockRejectedValue(new Error("network error"));
    const trigger = await renderPanel();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await click(trigger);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="rail-notifications-empty"]')).not.toBeNull();
  });

  it("renders NotificationBell with align=\"end\" (ShellHeader's narrow bell), portalled to document.body, end-aligned", async () => {
    apiGetMock.mockResolvedValue(notificationsResponse(1));
    await render(<NotificationBell touchTarget align="end" />);
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="rail-notification-trigger"]')!;
    expect(trigger.hasAttribute("data-touch-target")).toBe(false); // the seam sits on the inner span
    expect(host.querySelector('[data-touch-target]')).not.toBeNull();
    await click(trigger);
    const panel = document.querySelector('[data-testid="rail-notifications-panel"]');
    expect(panel).not.toBeNull();
    expect(host.contains(panel)).toBe(false);
    expect(document.body.contains(panel)).toBe(true);
    // `data-align` is Base UI's own Positioner/Popup state attribute, reflecting the resolved
    // alignment directly (`PopoverPositionerDataAttributes`/`PopoverPopupDataAttributes`).
    expect(panel!.getAttribute("data-align")).toBe("end");
  });
});
