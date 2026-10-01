import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStaffNavigation, type StaffNavigation } from "../../lib/staff-navigation";
import { parseStaffLocation } from "../../lib/router";
import {
  __getDashboardSearchSnapshotForTest,
  __resetDashboardSearchStoreForTest,
  DASHBOARD_SEARCH_DEBOUNCE_MS,
  setDashboardSearchDraft,
  setDashboardSearchUrlWriter,
} from "../../lib/dashboard-search-store";
import { initials } from "../../lib/initials";
import { SidebarProvider } from "@/components/reui/sidebar";
import { TooltipProvider } from "@/components/reui/tooltip";
import { Sheet } from "@/components/reui/sheet";
import { NavigationRail, type NavigationRailVariant } from "./NavigationRail";
import { RailSheet } from "./RailSheet";

// Sign out cannot be exercised against a real session — it would destroy the session every other
// check depends on — so the transport is mocked and the wiring asserted here instead. The handler
// itself was copied from the retired Topbar, but the path through `MenuPrimitive.Item`'s `render` is new.
const signOutMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../lib/auth", () => ({ signOut: signOutMock }));

// #112 — the rail now mounts `NotificationBell` (`showBell` defaults to true) beside the wordmark,
// which polls `apiGet` on mount. Unmocked, that is a real `fetch()` in every test in this file, not
// just the ones below that care about the bell — same shape as `NotificationBell.dom.test.tsx`'s mock, with an
// empty inbox as the default so tests that do not care about notifications see none.
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

/**
 * The rail's rendering — #111, re-platformed onto base-nova's full `sidebar.tsx` in #122.
 *
 * These tests drive the component with the output of the REAL model (`buildStaffNavigation`) rather
 * than a hand-written navigation literal, so a change to the model that breaks the rail fails here
 * rather than passing against a fixture that has drifted. The model's own decisions — which item is
 * active, which group is open, whether Calendar exists — are covered by
 * `lib/staff-navigation.test.ts` in the node suite and are not re-asserted here.
 *
 * Test hooks are Quincy-authored `data-testid`s. Deliberately NOT the primitive's `data-slot`
 * values: `testing/test-seam.guard.test.ts`'s guard F (#92) makes selecting on a vendor-authored
 * `data-slot` a build failure, and every slot in `reui/sidebar.tsx` is vendor-authored.
 *
 * `SidebarProvider` is now load-bearing: `reui/sidebar.tsx`'s `Sidebar`/`SidebarMenuButton`/
 * `SidebarTrigger` all call `useSidebar()`, which throws outside a provider. `renderInProvider`
 * wraps every render below in one (plus a zero-delay `TooltipProvider`, so the collapsed-rail
 * tooltip tests do not need to wait out a real hover-intent delay) — see its own comment.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  // Two ticks, not one — `NotificationBell`'s mount effect awaits `apiGet` before its first
  // `setState`, which needs a microtask beyond the mocked promise's own resolution to land inside
  // this `act` boundary. Same shape as `NotificationBell.dom.test.tsx`'s own `render` helper.
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

/**
 * #122: `reui/sidebar.tsx`'s primitives throw outside a `SidebarProvider`. `open={false}` always,
 * the same way `RailedShell` pins it (#426, ADR 0015): `SidebarMenuButton`'s own tooltip
 * visibility (`hidden={state !== "collapsed" || isMobile}`) reads the SAME context this provider
 * owns, and the rail has no expanded state to render.
 * `isMobile` is stubbed false in `beforeEach` (below) for every test in this file; the narrow
 * boundary itself is `reui/sidebar.dom.test.tsx`'s and `App-navigation-rail-shell.dom.test.tsx`'s.
 */
async function renderInProvider(
  navigation: StaffNavigation,
  options: { user?: { name?: string | null; email?: string | null }; variant?: NavigationRailVariant; showBell?: boolean } = {},
) {
  const { user = USER, variant = "rail", showBell } = options;
  await render(
    <SidebarProvider open={false}>
      <TooltipProvider delay={0}>
        <NavigationRail navigation={navigation} user={user} variant={variant} showBell={showBell} />
      </TooltipProvider>
    </SidebarProvider>,
  );
}

/**
 * The `sheet` variant mounted inside a REAL modal Dialog — `RailSheet`'s own `<Sheet>`, not a bare
 * `OverlayContainerContext.Provider` probe. The account menu's Escape-focus behaviour (#122) is
 * specifically a `DialogPopup` focus-restoration race, so only a real `Dialog.Popup`
 * (`RailSheet.tsx`'s own composition, mirroring `RailSheet.dom.test.tsx`) actually exercises it —
 * a synthetic container with no Dialog behind it would pass regardless of whether the fix exists.
 */
async function renderInSheet(navigation: StaffNavigation, options: { user?: { name?: string | null; email?: string | null } } = {}) {
  const { user = USER } = options;
  await render(
    <SidebarProvider open={false}>
      <TooltipProvider delay={0}>
        <Sheet open onOpenChange={() => {}}>
          <RailSheet>
            <NavigationRail navigation={navigation} user={user} variant="sheet" showBell={false} />
          </RailSheet>
        </Sheet>
      </TooltipProvider>
    </SidebarProvider>,
  );
}

/** A real MouseEvent, `detail: 1` — realism (a pointer click); since #366 `InternalLink` also
 * intercepts keyboard `detail: 0` clicks. Mirrors `App-navigation-rail-shell.dom.test.tsx`'s own `click()`. */
async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Real-timer poll, mirroring `App-navigation-rail-shell.dom.test.tsx`'s own `waitFor` — Base UI's
 * hover-intent and open/close transitions land a tick or two removed from the triggering event. */
async function waitFor(assertion: () => void, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

function stubMatchMedia(matches = false) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue({ notifications: [], unreadCount: 0 });
  apiPostMock.mockReset().mockResolvedValue({ ok: true });
  apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
  stubMatchMedia(false);
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
const FULL_CAPABILITIES = { adminBackend: true, viewProductionCalendar: true, viewNoticeBoard: true };

function navigationFor(location: string, remembered: "table" | "board" | "calendar" = "board") {
  return buildStaffNavigation(parseStaffLocation(location), remembered, FULL_CAPABILITIES);
}

const testids = (name: string) =>
  [...host.querySelectorAll(`[data-testid="${name}"]`)] as HTMLElement[];

const linkTexts = (name: string) => testids(name).map((element) => element.textContent?.trim());

// The accessible name a screen reader resolves: an explicit `aria-label` wins, otherwise the
// element's own text content — matching the accessible-name algorithm's precedence for these
// links, which never carry both.
const accessibleName = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim();

describe("NavigationRail", () => {
  const CHILD_LINK = "navigation-rail-child-link";

  it("renders the model's items in the model's order, as real anchors, and no Dashboard view children (#426, ADR 0015)", async () => {
    const navigation = navigationFor("/");
    // The model still carries the four Dashboard views (the breadcrumb reads them) — the rail just
    // does not draw them.
    expect(navigation.groups[0]!.items[0]!.children?.map((child) => child.label)).toEqual(["Table", "Board", "Calendar", "Timeline"]);
    await renderInProvider(navigation);

    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Notice board", "Admin"]);
    expect(testids(CHILD_LINK)).toEqual([]);
    for (const view of ["Table", "Board", "Calendar", "Timeline"]) expect(host.textContent).not.toContain(view);

    // Every destination is an anchor with a real href — the rail cannot navigate through
    // `useNavigate`, which the read-only history makes a no-op.
    for (const link of testids("navigation-rail-link")) {
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBeTruthy();
    }
  });

  it("takes every href from the model rather than composing its own", async () => {
    const navigation = navigationFor("/");
    await renderInProvider(navigation);

    const rendered = testids("navigation-rail-link").map((element) => element.getAttribute("href"));
    const modelled = navigation.groups.flatMap((group) => group.items).map((item) => item.href);

    expect(rendered).toEqual(modelled);
  });

  it("marks the active item with a present data-active, the boolean-presence form the primitive's paint selects on", async () => {
    // Not incidental: base-nova's full `sidebar.tsx` maps `isActive` through Base UI's own `state`,
    // which renders a boolean as a VALUELESS attribute (`data-active=""`) rather than the string
    // `"true"`/`"false"` #111's trimmed primitive used to write explicitly — and its paint
    // (`data-active:bg-sidebar-accent`, a Tailwind boolean-presence variant) is written to match.
    await renderInProvider(navigationFor("/"));

    const active = testids("navigation-rail-link").filter((element) => element.hasAttribute("data-active"));
    expect(active.map((element) => element.textContent?.trim())).toEqual(["Dashboard"]);

    const notices = testids("navigation-rail-link").find((element) => element.textContent?.trim() === "Notice board");
    expect(notices?.hasAttribute("data-active")).toBe(false);
  });

  it("renders no child links on any route, even one where the model marks a view active", async () => {
    for (const location of ["/", "/?view=table", "/admin"]) {
      await renderInProvider(navigationFor(location));
      expect(testids(CHILD_LINK), location).toEqual([]);
    }
  });

  it("gives every item an icon", async () => {
    await renderInProvider(navigationFor("/"));
    for (const link of testids("navigation-rail-link")) {
      const icon = link.querySelector("svg");
      expect(icon).not.toBeNull();
      // The label is the accessible name; an announced icon would double it.
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("exposes a named navigation landmark", async () => {
    // The retired Topbar had
    // `<nav aria-label="Primary navigation">`; the vendor `SidebarContent` is only a `div`, so
    // without an explicit landmark the rail drops primary navigation out of the landmark list.
    await renderInProvider(navigationFor("/"));
    const landmarks = [...host.querySelectorAll("nav")];
    expect(landmarks).toHaveLength(1);
    expect(landmarks[0]?.getAttribute("aria-label")).toBe("Primary navigation");
    // Every destination must be inside it.
    for (const link of testids("navigation-rail-link")) {
      expect(landmarks[0]?.contains(link)).toBe(true);
    }
  });

  it("marks the active destination with aria-current, not only data-active", async () => {
    // `data-active` is a styling hook and announces nothing. Without `aria-current` a screen-reader
    // user is never told which destination is the current one.
    await renderInProvider(navigationFor("/?view=board"));

    const current = [
      ...host.querySelectorAll('[aria-current="page"]'),
    ].map((element) => element.textContent?.trim());
    // With no child links, the Dashboard item itself is the current page on every Dashboard view.
    expect(current).toEqual(["Dashboard"]);

    // And it is not left on everything.
    expect(testids("navigation-rail-link").filter((element) => element.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("gives only the destination aria-current, never its ancestor", async () => {
    await renderInProvider(navigationFor("/admin"));
    const current = [
      ...host.querySelectorAll('[aria-current="page"]'),
    ].map((element) => element.textContent?.trim());
    expect(current).toEqual(["Admin"]);
  });

  it("marks Notice board current on /notices, with no child links", async () => {
    await renderInProvider(navigationFor("/notices"));
    const link = testids("navigation-rail-link").find((element) => element.textContent?.trim() === "Notice board")!;
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.hasAttribute("data-active")).toBe(true);
    expect(link.getAttribute("href")).toBe("/notices");
    expect(testids(CHILD_LINK)).toHaveLength(0);
    expect([...host.querySelectorAll('[aria-current="page"]')]).toHaveLength(1);
  });

  it("renders the logo mark and the identity", async () => {
    await renderInProvider(navigationFor("/"));
    expect(testids("navigation-rail-brand")[0]?.getAttribute("href")).toBe("/");
    // The rail shows the avatar's initials; the full name is the trigger's accessible name.
    expect(testids("navigation-rail-identity")[0]?.textContent).toContain(initials(USER.name));
    expect(accountTrigger()?.getAttribute("aria-label")).toContain("Terry Lee");
  });

  it("keeps Sign out behind the account menu rather than on the rail", async () => {
    // Sign out is destructive and irreversible, and it used to sit one stray click below the
    // navigation. The reference shell puts it inside a menu opened from the footer identity, and
    // this pins that: absent until the identity is activated, present after.
    //
    // Queried on `document`, not the host: Base UI's Menu portals its panel to `document.body`,
    // so a host-scoped query would report the panel missing in both states and pass vacuously.
    await renderInProvider(navigationFor("/"));

    expect(document.querySelector('[data-testid="navigation-rail-signout"]')).toBeNull();
    expect(host.textContent).not.toContain("Sign out");

    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]');
    expect(trigger, "the footer identity must be the menu trigger").not.toBeNull();
    await act(async () => {
      trigger!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const signOut = document.querySelector('[data-testid="navigation-rail-signout"]');
    expect(signOut?.textContent?.trim()).toBe("Sign out");
  });

  it("names the account menu trigger for screen readers", async () => {
    // The trigger's visible content is a name and an email, which does not say what activating it
    // does. The avatar is `aria-hidden`, so without an explicit label the control announces only
    // the identity text.
    await renderInProvider(navigationFor("/"));
    const trigger = document.querySelector('[data-testid="navigation-rail-account"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Account menu for Terry Lee");
  });

  it("advertises the account menu as a menu popup and reflects its open state", async () => {
    await renderInProvider(navigationFor("/"));
    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]')!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  // -------------------------------------------------------------------------
  // The rail draws no Dashboard children, however many the model holds
  // -------------------------------------------------------------------------

  it("draws no child link even when the model gains a fourth Dashboard child", async () => {
    // The model's `children` is a LIST the breadcrumb still reads; the rail ignores it. This
    // appends a synthetic "Timeline" to the REAL model's output and asserts nothing about it
    // reaches the rail. (Before #426 this proved the rail rendered a fifth child with no change.)
    const real = navigationFor("/");
    const group = real.groups[0]!;
    const dashboard = group.items[0]!;
    const widened: StaffNavigation = {
      ...real,
      groups: [
        {
          ...group,
          items: [
            {
              ...dashboard,
              children: [
                ...(dashboard.children ?? []),
                { id: "dashboard-timeline", label: "Timeline", href: "/?view=timeline", icon: "calendar", active: false },
              ],
            },
            ...group.items.slice(1),
          ],
        },
      ],
    };

    await renderInProvider(widened);

    expect(testids(CHILD_LINK)).toEqual([]);
    expect(host.textContent).not.toContain("Timeline");
    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Notice board", "Admin"]);
  });
});

// -----------------------------------------------------------------------------
// #112/#122 — variants, the collapsed rail's menu and tooltips, and the sheet's touch targets
// -----------------------------------------------------------------------------

/** The rail's own landmark and controls, found by their Quincy test ids / accessible names. */
function bellTrigger() { return host.querySelector<HTMLElement>('[data-testid="rail-notification-trigger"]'); }
function settingsLink() { return host.querySelector<HTMLAnchorElement>('[data-testid="navigation-rail-settings"]'); }
function accountTrigger() { return host.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]'); }
function follows(a: Element, b: Element) { return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }

describe("NavigationRail variant — rail (the always-icon column, #426)", () => {
  it("orders the column logo, nav, then bell, settings and the account avatar at the foot", async () => {
    await renderInProvider(navigationFor("/"));
    const logo = testids("navigation-rail-brand")[0]!;
    const nav = host.querySelector("nav")!;
    const bell = bellTrigger()!;
    const settings = settingsLink()!;
    const account = accountTrigger()!;
    for (const [label, element] of Object.entries({ logo, nav, bell, settings, account })) {
      expect(element, label).not.toBeNull();
    }

    expect(follows(logo, nav)).toBe(true);
    expect(follows(nav, bell)).toBe(true);
    expect(follows(bell, settings)).toBe(true);
    expect(follows(settings, account)).toBe(true);
    // The three foot controls live outside the navigation landmark, not in it.
    for (const foot of [bell, settings, account]) expect(nav.contains(foot)).toBe(false);
  });

  it("keeps every nav icon's accessible name though its label is visually hidden", async () => {
    await renderInProvider(navigationFor("/"));
    // The label text is in the DOM (the accessible name) but carries the screen-reader-only utility.
    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Notice board", "Admin"]);
    for (const link of testids("navigation-rail-link")) {
      expect(link.querySelector("span")?.classList.contains("sr-only"), accessibleName(link)).toBe(true);
    }
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(accessibleName(dashboard)).toBe("Dashboard");
  });

  it("shows the account trigger's initials only, dropping the name/email and the chevron", async () => {
    await renderInProvider(navigationFor("/"));
    const identity = host.querySelector('[data-testid="navigation-rail-identity"]') as HTMLElement;
    expect(identity.textContent?.trim()).toBe(initials(USER.name));
    expect(identity.querySelector("svg")).toBeNull();
  });

  it("has no collapse control — no rail-toggle and no expand/collapse button", async () => {
    await renderInProvider(navigationFor("/"));
    expect(host.querySelector('[data-testid="rail-toggle"]')).toBeNull();
    expect(host.querySelector('[aria-label="Collapse navigation"], [aria-label="Expand navigation"]')).toBeNull();
  });

  it("exposes no menu seam on a nav link — every item is a plain link", async () => {
    await renderInProvider(navigationFor("/"));
    for (const link of testids("navigation-rail-link")) {
      expect(link.tagName).toBe("A");
      expect(link.hasAttribute("aria-haspopup")).toBe(false);
    }
  });

  it("carries the bell at the foot of the rail, not a separate shell header", async () => {
    await renderInProvider(navigationFor("/"));
    expect(host.querySelector('[data-testid="rail-notifications"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="navigation-rail-footer"]')?.contains(bellTrigger())).toBe(true);
  });

  it("gates Admin on the capability the model carries", async () => {
    const withoutAdmin = buildStaffNavigation(parseStaffLocation("/"), "board", { ...FULL_CAPABILITIES, adminBackend: false });
    await renderInProvider(withoutAdmin);
    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Notice board"]);
    expect(host.textContent).not.toContain("Admin");

    const withoutNotices = buildStaffNavigation(parseStaffLocation("/"), "board", { ...FULL_CAPABILITIES, viewNoticeBoard: false });
    await renderInProvider(withoutNotices);
    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Admin"]);
  });
});

describe("the settings icon (#426)", () => {
  it("is a real link to Notification preferences, named for screen readers", async () => {
    await renderInProvider(navigationFor("/"));
    const settings = settingsLink()!;
    expect(settings.tagName).toBe("A");
    expect(settings.getAttribute("href")).toBe("/settings/notifications/preferences");
    expect(settings.getAttribute("aria-label")).toBe("Notification preferences");
    expect(settings.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("navigates to Notification preferences when clicked", async () => {
    window.history.replaceState(null, "", "/");
    await renderInProvider(navigationFor("/"));
    await click(settingsLink()!);
    expect(window.location.pathname).toBe("/settings/notifications/preferences");
  });

  it("carries aria-current and data-active only on the preferences route", async () => {
    await renderInProvider(navigationFor("/settings/notifications/preferences"));
    expect(settingsLink()!.getAttribute("aria-current")).toBe("page");
    expect(settingsLink()!.hasAttribute("data-active")).toBe(true);
    // No nav icon claims the page: preferences is not a nav destination.
    expect(testids("navigation-rail-link").some((link) => link.hasAttribute("aria-current"))).toBe(false);

    for (const location of ["/", "/settings/notifications", "/admin"]) {
      await renderInProvider(navigationFor(location));
      expect(settingsLink()!.hasAttribute("aria-current"), location).toBe(false);
      expect(settingsLink()!.hasAttribute("data-active"), location).toBe(false);
    }
  });

  it("is absent from the Sheet, which keeps a labelled preferences row in its account menu instead", async () => {
    await renderInProvider(navigationFor("/"), { variant: "sheet" });
    expect(settingsLink()).toBeNull();
  });
});

// #427: the project search moved to the Dashboard toolbar (ADR 0015). Neither variant renders a
// search control — no input, no icon trigger, no popover — at any width.
describe("NavigationRail carries no search control (#427)", () => {
  it.each(["rail", "sheet"] as const)("%s: no search input, trigger or popover, on or off the Dashboard", async (variant) => {
    for (const location of ["/", "/?view=board", "/admin"]) {
      await renderInProvider(navigationFor(location), { variant });
      expect(host.querySelector('input, [role="searchbox"], [role="combobox"]'), `${variant} ${location}`).toBeNull();
      expect(document.querySelector('[data-testid="shell-search"], [data-testid="shell-search-trigger"], [data-testid="shell-search-field"]')).toBeNull();
      expect(host.querySelector('[aria-label="Search projects"]')).toBeNull();
    }
  });
});

describe("NavigationRail variant — sheet", () => {
  it("shows visible labels", async () => {
    await renderInProvider(navigationFor("/"), { variant: "sheet" });
    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Notice board", "Admin"]);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(accessibleName(dashboard)).toBe("Dashboard");
    expect(dashboard.querySelector("span")?.classList.contains("sr-only")).toBe(false);
  });

  it("gives every link, account trigger and the brand/home link the 44px touch-target seam", async () => {
    await renderInProvider(navigationFor("/?view=board"), { variant: "sheet" });

    for (const link of testids("navigation-rail-link")) {
      expect(link.getAttribute("data-touch-target")).toBe("true");
    }
    // #122 P3: the seam sits on the trigger itself (`navigation-rail-account`, the real
    // `SidebarMenuButton` now that `triggerRender` makes it the menu's own trigger).
    expect(host.querySelector('[data-testid="navigation-rail-account"]')?.getAttribute("data-touch-target")).toBe("true");
    expect(host.querySelector('[data-testid="navigation-rail-brand"]')?.getAttribute("data-touch-target")).toBe("true");
    expect(document.querySelector('[data-touch-target="true"] svg')).not.toBeNull();
  });

  it("draws no Dashboard view children here either", async () => {
    await renderInProvider(navigationFor("/?view=board"), { variant: "sheet" });
    expect(testids("navigation-rail-child-link")).toEqual([]);
  });

  it("does not expose a menu seam on its parent link", async () => {
    await renderInProvider(navigationFor("/?view=board"), { variant: "sheet" });
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(dashboard.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("carries no rail-toggle and no bell — the Sheet's own trigger and the header's bell own those while narrow", async () => {
    await renderInProvider(navigationFor("/"), { variant: "sheet", showBell: false });
    expect(host.querySelector('[data-testid="rail-toggle"]')).toBeNull();
    expect(host.querySelector('[data-testid="rail-notifications"]')).toBeNull();
  });

  it("keeps the labelled Notification preferences row inside its account menu", async () => {
    await renderInProvider(navigationFor("/"), { variant: "sheet" });
    await click(accountTrigger()!);
    const preferences = document.querySelector('[data-testid="navigation-rail-preferences"]');
    expect(preferences?.textContent?.trim()).toBe("Notification preferences");
    expect(preferences?.getAttribute("href")).toBe("/settings/notifications/preferences");
  });
});

describe("rail tooltips (#122, #426)", () => {
  async function hover(element: Element) {
    await act(async () => {
      element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
      element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      await Promise.resolve();
    });
  }

  it.each([
    ["Dashboard", () => testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!],
    ["Notice board", () => testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Notice board")!],
    ["Admin", () => testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Admin")!],
    ["Notification preferences", () => settingsLink()!],
    ["Terry Lee", () => accountTrigger()!],
  ])("shows %s as a tooltip on hover", async (label, find) => {
    await renderInProvider(navigationFor("/"));
    expect(document.querySelector('[data-testid^="rail-tooltip-"]')).toBeNull();

    await hover(find());

    await waitFor(() => {
      const tooltip = document.querySelector('[data-testid^="rail-tooltip-"]');
      expect(tooltip).not.toBeNull();
      expect(tooltip?.textContent).toBe(label);
    });
  });
});

describe("NavigationRail — showBell", () => {
  it("mounts the bell by default and omits it when showBell is false", async () => {
    await renderInProvider(navigationFor("/"));
    expect(host.querySelector('[data-testid="rail-notifications"]')).not.toBeNull();

    await renderInProvider(navigationFor("/"), { showBell: false });
    expect(host.querySelector('[data-testid="rail-notifications"]')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// #113 — which of the rail's own two menus gets the backdrop: the account panel is a full
// navigation surface and dims the page; the notification panel (`quincy/NotificationBell.tsx`'s
// `reui/popover.tsx`) is a small dropdown list and does not. `menu-backdrop` is
// `quincy/menu.tsx`'s own `MenuPrimitive.Backdrop` test seam.
// -----------------------------------------------------------------------------

describe("account vs notification backdrop (#113)", () => {
  it("account navigation dims the page; the notification panel does not, and the rest of the page stays interactive", async () => {
    const outsideButton = document.createElement("button");
    outsideButton.textContent = "Outside";
    const outsideClick = vi.fn();
    outsideButton.addEventListener("click", outsideClick);
    document.body.appendChild(outsideButton);

    await renderInProvider(navigationFor("/"));
    const accountTrigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]')!;
    await click(accountTrigger);
    await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-testid="menu-backdrop"]')).toHaveLength(1);

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(document.querySelectorAll('[data-testid="menu-backdrop"]')).toHaveLength(0);

    const bellTrigger = document.querySelector<HTMLElement>('[data-testid="rail-notification-trigger"]')!;
    await click(bellTrigger);
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-testid="menu-backdrop"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="rail-sheet-scrim"]')).toHaveLength(0);

    await click(outsideButton);
    expect(outsideClick).toHaveBeenCalledTimes(1);
    outsideButton.remove();
  });

  it("the Sheet's own scrim is not doubled by its nested account menu", async () => {
    await renderInSheet(navigationFor("/"));
    expect(document.querySelectorAll('[data-testid="rail-sheet-scrim"]')).toHaveLength(1);

    const accountTrigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]')!;
    await click(accountTrigger);
    await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());

    // `backdrop={!isSheet}` (`NavigationRail.tsx`) — the Sheet's own scrim already dims the page,
    // so the nested account menu must not add a second one.
    expect(document.querySelectorAll('[data-testid="menu-backdrop"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="rail-sheet-scrim"]')).toHaveLength(1);
  });
});

describe("the account menu inside a modal Sheet — focus after Escape (#122 P3)", () => {
  it("returns focus to the account trigger synchronously, not the Sheet dialog popup", async () => {
    await renderInSheet(navigationFor("/"));
    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]')!;
    await click(trigger);
    const menuItem = document.querySelector<HTMLElement>('[data-testid="navigation-rail-signout"]')!;
    await act(async () => { menuItem.focus(); await Promise.resolve(); });
    expect(document.activeElement).toBe(menuItem);

    // Synchronous, in the SAME act as the Escape dispatch — no transition wait. happy-dom removes
    // the popup synchronously here and never reproduces the Dialog's `restoreFocus: "popup"`
    // refocus, so this asserts the fix's mechanism (the trigger focused before unmount), not the
    // defect itself.
    await act(async () => {
      menuItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(trigger);
    // Focus landing on the Sheet's OWN dialog popup (not merely "inside" it, which the trigger
    // always legitimately is here) is `restoreFocus: "popup"`'s own refocus target.
    expect(document.activeElement).not.toBe(document.querySelector('[data-testid="rail-sheet"]'));
  });

  it("leaves the plain wide rail's own Escape-returns-focus behaviour unchanged", async () => {
    // No `container` (page-level): confirms the account menu's own trigger returns focus the same
    // way outside any Sheet.
    await renderInProvider(navigationFor("/"));
    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]')!;
    await click(trigger);
    await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

    expect(document.activeElement).toBe(trigger);
  });
});

describe("the account menu's side, by variant (#122 P3)", () => {
  it("opens above the trigger in the Sheet — the root Menu's own collision avoidance has no left/right fallback in a 288px container", async () => {
    await renderInProvider(navigationFor("/"), { variant: "sheet" });
    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]')!;
    await click(trigger);
    // Base UI's Popup (`role="menu"`) carries `data-side` directly — no positioner traversal needed.
    expect(document.querySelector('[role="menu"]')?.getAttribute("data-side")).toBe("top");
  });

  it("opens to the right of the trigger on the wide rail, unchanged", async () => {
    await renderInProvider(navigationFor("/"), { variant: "rail" });
    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]')!;
    await click(trigger);
    expect(document.querySelector('[role="menu"]')?.getAttribute("data-side")).toBe("right");
  });
});

describe("the account menu's sign out", () => {
  it("calls signOut when the menu item is activated", async () => {
    // Presence in the DOM is not the behaviour. This is the assertion that would catch the item
    // rendering correctly while its `onClick` never reaches the transport — the failure mode of
    // handing a handler to a primitive's `render` prop rather than to the element itself.
    signOutMock.mockClear();
    await renderInProvider(navigationFor("/"));

    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]');
    await act(async () => { trigger!.click(); await Promise.resolve(); await Promise.resolve(); });

    const signOut = document.querySelector<HTMLElement>('[data-testid="navigation-rail-signout"]');
    expect(signOut, "the menu must be open before the item can be activated").not.toBeNull();
    await act(async () => { signOut!.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  // #217 fix round 5, item 3 (Sol re-review, BLOCKER). Sign-out at a URL carrying a Dashboard
  // search used to leave it there -- `App.tsx` hands that URL to `SignIn`, and `lib/auth.ts`'s
  // `beginSignIn` preserves it as the OAuth return destination, so signing back in (as anyone)
  // re-applied it. Only the explicit sign-out ACTION scrubs the CURRENT location; a cold deep link
  // to the same URL while signed out must still apply after sign-in (`router.test.ts`'s own
  // "accepts a canonical Calendar destination and preserves it through OAuth return" pins that this
  // fix does not touch).
  it("scrubs the Dashboard search from the URL before signing out, via replace not push", async () => {
    signOutMock.mockClear();
    window.history.replaceState(null, "", "/?view=board&q=smith");
    const lengthBefore = window.history.length;
    await renderInProvider(navigationFor("/?view=board&q=smith"));

    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]');
    await act(async () => { trigger!.click(); await Promise.resolve(); await Promise.resolve(); });
    const signOut = document.querySelector<HTMLElement>('[data-testid="navigation-rail-signout"]');
    await act(async () => { signOut!.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(`${window.location.pathname}${window.location.search}`).toBe("/?view=board");
    // `replace`, not `push` -- correcting the current entry creates no new history entry.
    expect(window.history.length).toBe(lengthBefore);
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  // #217 fix round 6, item 1 (Sol re-review, BLOCKER). The scrub above reads the URL, but a
  // keystroke within the last `DASHBOARD_SEARCH_DEBOUNCE_MS` has not reached the URL yet -- it is
  // still a pending timer. The URL-level scrub is then a no-op (there is no `q` to strip), and
  // while `signOut()` awaits the network that timer fires, commits through whichever writer is
  // registered (`Dashboard.tsx`'s own), and puts `q` BACK in the URL -- the next sign-in shows it
  // again, straight off that URL (`Dashboard.tsx`'s `committedQuery`, derived at render from
  // `dashboardSearchOf(parsedRoute)` -- #217 build step 4 -- reads no store copy to "adopt").
  // `handleSignOut` must cancel the pending timer and discard the draft SYNCHRONOUSLY, before
  // awaiting anything (including the URL scrub, which reads a location that might otherwise still
  // be one keystroke stale) -- `dropDashboardSearchOwnership` already does both (it calls the
  // store's own `clearTimer()`), so a late timer callback is provably inert: the real `setTimeout`
  // was cancelled outright, not merely out-raced.
  it("cancels a still-pending debounce and discards the draft synchronously, before signOut() resolves", async () => {
    signOutMock.mockClear();
    __resetDashboardSearchStoreForTest();
    const writer = vi.fn();
    const unregisterWriter = setDashboardSearchUrlWriter(writer);
    window.history.replaceState(null, "", "/");
    await renderInProvider(navigationFor("/"));

    // Menu opened with real timers (Base UI's own open transition relies on real
    // rAF/microtask timing); fake timers are only switched on once the pending debounce itself
    // needs deterministic control.
    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]');
    await act(async () => { trigger!.click(); await Promise.resolve(); await Promise.resolve(); });
    const signOutButton = document.querySelector<HTMLElement>('[data-testid="navigation-rail-signout"]');
    expect(signOutButton, "the menu must be open before Sign out can be activated").not.toBeNull();

    vi.useFakeTimers();
    try {
      // Typed 100ms ago -- still mid-debounce, nothing committed, no `q` in the URL yet.
      act(() => { setDashboardSearchDraft("smith", "u1"); });
      expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "smith" });
      expect(writer).not.toHaveBeenCalled();

      // `signOut()` itself is a pending promise the test controls, so the race window between the
      // synchronous scrub and the network resolving is exercised directly.
      let resolveSignOut!: () => void;
      signOutMock.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSignOut = resolve; }));

      await act(async () => { signOutButton!.click(); await Promise.resolve(); });

      // Synchronously, before `signOut()` has had any chance to resolve: the debounce is already
      // gone.
      expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "" });

      act(() => { vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 700); });
      expect(`${window.location.pathname}${window.location.search}`).toBe("/");
      expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "" });
      expect(writer).not.toHaveBeenCalled();

      await act(async () => { resolveSignOut(); await Promise.resolve(); await Promise.resolve(); });
      expect(`${window.location.pathname}${window.location.search}`).toBe("/");
      expect(writer).not.toHaveBeenCalled();

      unregisterWriter();
    } finally {
      vi.useRealTimers();
      __resetDashboardSearchStoreForTest();
    }
  });

  it("surfaces a failure in the rail rather than swallowing it", async () => {
    // The alert deliberately lives OUTSIDE the menu panel: `closeOnClick` unmounts the panel, so an
    // error rendered inside it would vanish before it could be read.
    signOutMock.mockClear();
    signOutMock.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    await renderInProvider(navigationFor("/"));

    const trigger = document.querySelector<HTMLElement>('[data-testid="navigation-rail-account"]');
    await act(async () => { trigger!.click(); await Promise.resolve(); await Promise.resolve(); });
    const signOut = document.querySelector<HTMLElement>('[data-testid="navigation-rail-signout"]');
    await act(async () => {
      signOut!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = host.querySelector('[role="alert"]');
    expect(alert, "a failed sign out must leave a visible alert in the rail").not.toBeNull();
    expect(alert?.textContent).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// #122 P3 — the account panel's nav-workspace shape: preferences, a separator, then sign out
// -----------------------------------------------------------------------------

describe("the account menu panel (#426)", () => {
  async function openAccountMenu(variant: NavigationRailVariant = "rail", location = "/") {
    await renderInProvider(navigationFor(location), { variant });
    await click(accountTrigger()!);
    return document.querySelector('[role="menu"]')!;
  }

  it("holds the account's name and email, then a separator, then Sign out — and no preferences row on the rail", async () => {
    const menu = await openAccountMenu();

    // The ARIA association Base UI's `Group`/`GroupLabel` actually build, not a raw tag scan:
    // `role="group"` wraps the labelled content, and `aria-labelledby` points at the label's own id.
    const group = menu.querySelector('[role="group"]')!;
    const label = document.getElementById(group.getAttribute("aria-labelledby")!)!;
    expect(label, "the group's aria-labelledby must resolve to a real element").not.toBeNull();
    expect(label.textContent).toContain("Account");
    expect(label.textContent).toContain(USER.name);
    expect(label.textContent).toContain(USER.email);

    const separator = menu.querySelector('[role="separator"]')!;
    const signOut = menu.querySelector('[data-testid="navigation-rail-signout"]')!;
    expect(signOut.textContent?.trim()).toBe("Sign out");
    // `compareDocumentPosition`, not a flattened text scan — the separator carries no text of its own.
    expect(follows(group, separator)).toBe(true);
    expect(follows(separator, signOut)).toBe(true);

    // Settings is its own rail icon; the menu no longer carries a preferences row (ADR 0015).
    expect(menu.querySelector('[data-testid="navigation-rail-preferences"]')).toBeNull();
    expect(menu.textContent).not.toContain("Notification preferences");
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["Sign out"]);
  });

  it("keeps Sign out ONLY inside the avatar menu — nowhere else in the rail, open or closed", async () => {
    await renderInProvider(navigationFor("/"));
    const everyRailControl = () => [...host.querySelectorAll("a, button")].map((element) => accessibleName(element) ?? "");
    expect(everyRailControl().some((name) => /sign\s?out/i.test(name))).toBe(false);
    expect(host.textContent).not.toMatch(/sign\s?out/i);

    await click(accountTrigger()!);
    // The panel portals to `document.body`; the rail itself still holds no second Sign out.
    expect(document.querySelectorAll('[data-testid="navigation-rail-signout"]')).toHaveLength(1);
    expect(host.textContent).not.toMatch(/sign\s?out/i);
  });

  it("dims the page behind the avatar menu with the account scrim, which the bell panel does not have", async () => {
    await openAccountMenu();
    expect(document.querySelectorAll('[data-testid="menu-backdrop"]')).toHaveLength(1);
  });

  it("orders the Sheet's panel as Account label, then the labelled preferences row, then a separator, then sign out", async () => {
    const menu = await openAccountMenu("sheet");
    const group = menu.querySelector('[role="group"]')!;
    const preferences = menu.querySelector('[data-testid="navigation-rail-preferences"]')!;
    const separator = menu.querySelector('[role="separator"]')!;
    const signOut = menu.querySelector('[data-testid="navigation-rail-signout"]')!;
    expect(preferences.getAttribute("href")).toBe("/settings/notifications/preferences");
    expect(follows(group, preferences)).toBe(true);
    expect(follows(preferences, separator)).toBe(true);
    expect(follows(separator, signOut)).toBe(true);
  });

  it("marks the Sheet's preferences row current only on the notifications preferences route", async () => {
    const menu = await openAccountMenu("sheet", "/settings/notifications/preferences");
    const preferences = menu.querySelector('[data-testid="navigation-rail-preferences"]')!;
    expect(preferences.hasAttribute("data-active")).toBe(true);
    expect(preferences.getAttribute("aria-current")).toBe("page");
  });

  it.each(["/settings/notifications", "/"])("does not mark the Sheet's preferences row current on %s (#115)", async (location) => {
    const menu = await openAccountMenu("sheet", location);
    const preferences = menu.querySelector('[data-testid="navigation-rail-preferences"]')!;
    expect(preferences.hasAttribute("data-active")).toBe(false);
    expect(preferences.hasAttribute("aria-current")).toBe(false);
  });

  it("Escape closes the menu and returns focus to the account trigger", async () => {
    await renderInProvider(navigationFor("/"));
    const trigger = accountTrigger()!;
    await click(trigger);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

    expect(document.activeElement).toBe(trigger);
  });
});
