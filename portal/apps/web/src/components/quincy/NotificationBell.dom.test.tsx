import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStaffNavigation } from "../../lib/staff-navigation";
import { parseStaffLocation } from "../../lib/router";
import { SidebarProvider } from "@/components/reui/sidebar";
import { NavigationRail } from "./NavigationRail";
import { NotificationBell } from "./NotificationBell";

/**
 * The rail's own bell — #112. A COPY of `Topbar.dom.test.tsx`'s notification mocking pattern, not
 * its full parity suite: #113 ports that suite across when it re-anchors the panel and deletes the
 * Topbar original (see `NotificationBell.tsx`'s header comment). This file only proves the four
 * things #112's plan asks for: the badge's count, its `99+` cap, its absence at zero, and that the
 * bell renders (badge included) inside a `collapsed` rail.
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
  host.remove();
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
