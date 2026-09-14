import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStaffNavigation, type StaffNavigation } from "../../lib/staff-navigation";
import { NAVIGATION_RAIL_FLAG } from "../../lib/feature-flags";
import { parseStaffLocation } from "../../lib/router";
import { initials } from "../../lib/initials";
import { SidebarProvider } from "@/components/reui/sidebar";
import { TooltipProvider } from "@/components/reui/tooltip";
import { NavigationRail, type NavigationRailVariant } from "./NavigationRail";

// Sign out cannot be exercised against a real session — it would destroy the session every other
// check depends on — so the transport is mocked and the wiring asserted here instead. The handler
// itself is a copy of the Topbar's, but the path through `MenuPrimitive.Item`'s `render` is new.
const signOutMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../lib/auth", () => ({ signOut: signOutMock }));

// #112 — the rail now mounts `NotificationBell` (`showBell` defaults to true) beside the wordmark,
// which polls `apiGet` on mount. Unmocked, that is a real `fetch()` in every test in this file, not
// just the ones below that care about the bell — mirrors `Topbar.dom.test.tsx`'s own mock, with an
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
  // this `act` boundary. Same shape as `Topbar.dom.test.tsx`'s own `render` helper.
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

/**
 * #122: `reui/sidebar.tsx`'s primitives throw outside a `SidebarProvider`. `open` is wired to
 * `variant` rather than left uncontrolled, because `SidebarMenuButton`'s own tooltip visibility
 * (`hidden={state !== "collapsed" || isMobile}`) reads the SAME context this provider owns — a
 * `variant="collapsed"` render needs `open={false}` (state "collapsed") for its tooltip test to
 * mean anything, the same way `RailedShell` derives the provider's `open` from its own `mode`.
 * `isMobile` is stubbed false in `beforeEach` (below) for every test in this file; the narrow
 * boundary itself is `reui/sidebar.dom.test.tsx`'s and `App-navigation-rail-shell.dom.test.tsx`'s.
 */
async function renderInProvider(
  navigation: StaffNavigation,
  options: { user?: { name?: string | null; email?: string | null }; variant?: NavigationRailVariant; showBell?: boolean } = {},
) {
  const { user = USER, variant = "expanded", showBell } = options;
  await render(
    <SidebarProvider open={variant !== "collapsed"} onOpenChange={() => {}}>
      <TooltipProvider delay={0}>
        <NavigationRail navigation={navigation} user={user} variant={variant} showBell={showBell} />
      </TooltipProvider>
    </SidebarProvider>,
  );
}

/** A real MouseEvent, `detail: 1` — `InternalLink`'s interception treats `detail === 0` as a
 * synthetic/keyboard click and does not intercept it, so a bare `.click()` never reaches
 * `locationStore().push()`. Mirrors `App-navigation-rail-shell.dom.test.tsx`'s own `click()`. */
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
const FULL_CAPABILITIES = { adminBackend: true, viewProductionCalendar: true };

function navigationFor(location: string, remembered: "list" | "kanban" | "calendar" = "kanban") {
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
  it("renders the model's items and children in the model's order, as real anchors", async () => {
    await renderInProvider(navigationFor("/"));

    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Admin"]);
    expect(linkTexts("navigation-rail-child-link")).toEqual(["List", "Kanban", "Calendar"]);

    // Every destination is an anchor with a real href — the rail cannot navigate through
    // `useNavigate`, which the read-only history makes a no-op.
    for (const link of [...testids("navigation-rail-link"), ...testids("navigation-rail-child-link")]) {
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBeTruthy();
    }
  });

  it("takes every href from the model rather than composing its own", async () => {
    const navigation = navigationFor("/");
    await renderInProvider(navigation);

    // One query for both hooks, so the result is in DOCUMENT order — a child sits inside its
    // parent's item, so concatenating the two hooks separately would compare the wrong sequence.
    const rendered = [
      ...host.querySelectorAll(
        '[data-testid="navigation-rail-link"], [data-testid="navigation-rail-child-link"]',
      ),
    ].map((element) => element.getAttribute("href"));
    const modelled = navigation.groups
      .flatMap((group) => group.items)
      .flatMap((item) => [item.href, ...(item.children ?? []).map((child) => child.href)]);

    expect(rendered).toEqual(modelled);
  });

  it("links Calendar at the bare intent URL", async () => {
    await renderInProvider(navigationFor("/"));
    const calendar = testids("navigation-rail-child-link").find(
      (element) => element.textContent?.trim() === "Calendar",
    );
    expect(calendar?.getAttribute("href")).toBe("/?view=calendar");
  });

  it("marks the active item with a present data-active, the boolean-presence form the primitive's paint selects on", async () => {
    // Not incidental: base-nova's full `sidebar.tsx` maps `isActive` through Base UI's own `state`,
    // which renders a boolean as a VALUELESS attribute (`data-active=""`) rather than the string
    // `"true"`/`"false"` #111's trimmed primitive used to write explicitly — and its paint
    // (`data-active:bg-sidebar-accent`, a Tailwind boolean-presence variant) is written to match.
    await renderInProvider(navigationFor("/?view=list"));

    const active = testids("navigation-rail-child-link").filter((element) => element.hasAttribute("data-active"));
    expect(active.map((element) => element.textContent?.trim())).toEqual(["List"]);

    const kanban = testids("navigation-rail-child-link").find(
      (element) => element.textContent?.trim() === "Kanban",
    );
    expect(kanban?.hasAttribute("data-active")).toBe(false);
  });

  it("renders no children when the model closes the group", async () => {
    const navigation = navigationFor("/admin");
    expect(navigation.expandedItemId).toBeNull();
    await renderInProvider(navigation);
    expect(testids("navigation-rail-child-link")).toEqual([]);
  });

  it("gives every item an icon", async () => {
    await renderInProvider(navigationFor("/"));
    for (const link of [...testids("navigation-rail-link"), ...testids("navigation-rail-child-link")]) {
      const icon = link.querySelector("svg");
      expect(icon).not.toBeNull();
      // The label is the accessible name; an announced icon would double it.
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("exposes a named navigation landmark", async () => {
    // Reported independently by both reviewers. The Topbar this replaces has
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
    await renderInProvider(navigationFor("/?view=kanban"));

    const current = [
      ...host.querySelectorAll('[aria-current="page"]'),
    ].map((element) => element.textContent?.trim());
    expect(current).toEqual(["Kanban"]);

    // And it is not left on everything.
    const all = [...testids("navigation-rail-link"), ...testids("navigation-rail-child-link")];
    expect(all.filter((element) => element.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("gives a parent aria-current only when it is itself the destination", async () => {
    // The parent Dashboard item is active on every Dashboard route, but while its children show,
    // the active CHILD is the current page and the parent is only its ancestor. Two elements
    // claiming `aria-current="page"` is a defect, and it is what the first implementation did.
    await renderInProvider(navigationFor("/admin"));
    const current = [
      ...host.querySelectorAll('[aria-current="page"]'),
    ].map((element) => element.textContent?.trim());
    expect(current).toEqual(["Admin"]);
  });

  it("renders the wordmark and the identity", async () => {
    await renderInProvider(navigationFor("/"));
    expect(testids("navigation-rail-brand")[0]?.getAttribute("href")).toBe("/");
    expect(testids("navigation-rail-identity")[0]?.textContent).toContain("Terry Lee");
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

  it("names the flag nowhere in its output", async () => {
    // #80's flag leaked `kanban2` into a user-visible aria-label (docs/lessons.md:1689). The shell
    // decides whether to mount the rail; the rail itself must not know the flag exists.
    await renderInProvider(navigationFor("/"));
    expect(host.innerHTML).not.toContain(NAVIGATION_RAIL_FLAG);
    expect(host.innerHTML.toLowerCase()).not.toContain("nav_rail");
    expect(host.innerHTML.toLowerCase()).not.toContain("nav-rail");
  });

  // -------------------------------------------------------------------------
  // AC4 — a fourth Dashboard child costs nothing here
  // -------------------------------------------------------------------------

  it("renders a fourth Dashboard child with no change to this component", async () => {
    // The point of the model holding children as a LIST. This appends a synthetic "Timeline" to the
    // REAL model's output — not to a fixture — and asserts the rail renders four children in order
    // with its own source untouched. If the rail ever hard-codes List/Kanban/Calendar, this fails.
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
                {
                  id: "dashboard-timeline",
                  label: "Timeline",
                  href: "/?view=timeline",
                  icon: "calendar",
                  active: false,
                },
              ],
            },
            ...group.items.slice(1),
          ],
        },
      ],
    };

    await renderInProvider(widened);

    expect(linkTexts("navigation-rail-child-link")).toEqual([
      "List",
      "Kanban",
      "Calendar",
      "Timeline",
    ]);
    expect(
      testids("navigation-rail-child-link")[3]?.getAttribute("href"),
    ).toBe("/?view=timeline");
  });

  it("omits Calendar entirely when the model omits it", async () => {
    const navigation = buildStaffNavigation(parseStaffLocation("/"), "kanban", {
      adminBackend: true,
      viewProductionCalendar: false,
    });
    await renderInProvider(navigation);
    expect(linkTexts("navigation-rail-child-link")).toEqual(["List", "Kanban"]);
    expect(host.textContent).not.toContain("Calendar");
  });
});

// -----------------------------------------------------------------------------
// #112/#122 — variants, the collapsed rail's menu and tooltips, and the sheet's touch targets
// -----------------------------------------------------------------------------

describe("NavigationRail variant — expanded (unchanged)", () => {
  it("shows visible labels, by default", async () => {
    await renderInProvider(navigationFor("/"));
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(accessibleName(dashboard)).toBe("Dashboard");
  });

  it("does not expose a menu seam on its parent link — its children are always inline here", async () => {
    await renderInProvider(navigationFor("/"));
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(dashboard.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("carries a rail-toggle with aria-expanded=\"true\" in its own header (#122)", async () => {
    await renderInProvider(navigationFor("/"));
    const toggle = host.querySelector('[data-testid="rail-toggle"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("carries the bell in its own header, not a separate shell header", async () => {
    await renderInProvider(navigationFor("/"));
    expect(host.querySelector('[data-testid="rail-notifications"]')).not.toBeNull();
  });
});

describe("NavigationRail variant — collapsed", () => {
  it("keeps every icon link's accessible name even though the label is visually hidden", async () => {
    await renderInProvider(navigationFor("/"), { variant: "collapsed" });
    // Visually hidden text is still the link's accessible name — it is in the DOM, only hidden by
    // CSS a happy-dom assertion cannot see, so this asserts the name itself rather than the class
    // that hides it.
    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Admin"]);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(accessibleName(dashboard)).toBe("Dashboard");
  });

  it("shows the account trigger's initials only, dropping the name/email and the chevron", async () => {
    await renderInProvider(navigationFor("/"), { variant: "collapsed" });
    const identity = host.querySelector('[data-testid="navigation-rail-identity"]') as HTMLElement;
    expect(identity.textContent?.trim()).toBe(initials(USER.name));
    expect(identity.querySelector("svg")).toBeNull();
  });

  it("carries a rail-toggle with aria-expanded=\"false\"", async () => {
    await renderInProvider(navigationFor("/"), { variant: "collapsed" });
    const toggle = host.querySelector('[data-testid="rail-toggle"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves Admin — an item with no children — a plain link, never a menu trigger", async () => {
    await renderInProvider(navigationFor("/admin"), { variant: "collapsed" });
    const admin = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Admin")!;
    expect(admin.tagName).toBe("A");
    expect(admin.getAttribute("href")).toBeTruthy();
    expect(admin.hasAttribute("aria-haspopup")).toBe(false);
  });

  describe("the Dashboard children, as a click-opened menu (#122)", () => {
    it("is closed until the item is clicked", async () => {
      await renderInProvider(navigationFor("/?view=kanban"), { variant: "collapsed" });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(testids("navigation-rail-child-link")).toEqual([]);
    });

    it("opens a role=menu with the children in model order, on click", async () => {
      await renderInProvider(navigationFor("/?view=kanban"), { variant: "collapsed" });
      const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;

      await click(dashboard);

      expect(document.querySelector('[role="menu"]')).not.toBeNull();
      expect(
        [...document.querySelectorAll('[data-testid="navigation-rail-child-link"]')].map(
          (el) => el.textContent?.trim(),
        ),
      ).toEqual(["List", "Kanban", "Calendar"]);
    });

    it("gives the active child aria-current=\"page\" inside the open menu", async () => {
      await renderInProvider(navigationFor("/?view=kanban"), { variant: "collapsed" });
      const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
      await click(dashboard);

      const current = [...document.querySelectorAll('[aria-current="page"]')].map((el) => el.textContent?.trim());
      expect(current).toEqual(["Kanban"]);
    });

    it("gives the active child a present data-active, and no attribute at all on the inactive ones (#122 Sol review)", async () => {
      // `MenuPrimitive.LinkItem` has no active concept of its own — `NavigationRail` writes
      // `data-active` by hand, and must write it the same way base-nova's own primitive does:
      // present (`""`) when active, ABSENT (not `"false"`) otherwise. Tailwind's `data-active:`
      // variant matches on presence alone, so a literal `"false"` string would still match it.
      await renderInProvider(navigationFor("/?view=kanban"), { variant: "collapsed" });
      const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
      await click(dashboard);

      const kanban = [...document.querySelectorAll('[data-testid="navigation-rail-child-link"]')].find(
        (el) => el.textContent?.trim() === "Kanban",
      )!;
      const list = [...document.querySelectorAll('[data-testid="navigation-rail-child-link"]')].find(
        (el) => el.textContent?.trim() === "List",
      )!;

      expect(kanban.hasAttribute("data-active")).toBe(true);
      expect(list.hasAttribute("data-active")).toBe(false);
    });

    it("Escape closes the menu and returns focus to the Dashboard trigger", async () => {
      await renderInProvider(navigationFor("/?view=kanban"), { variant: "collapsed" });
      const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
      await click(dashboard);
      expect(document.querySelector('[role="menu"]')).not.toBeNull();

      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

      expect(document.activeElement).toBe(dashboard);
    });

    it("activating a child changes the location and closes the menu", async () => {
      window.history.replaceState(null, "", "/?view=kanban");
      await renderInProvider(navigationFor("/?view=kanban"), { variant: "collapsed" });
      const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
      await click(dashboard);

      const listLink = [...document.querySelectorAll('[data-testid="navigation-rail-child-link"]')].find(
        (el) => el.textContent?.trim() === "List",
      )!;
      await click(listLink);

      expect(window.location.search).toBe("?view=list");
      await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    });
  });
});

describe("NavigationRail variant — sheet", () => {
  it("shows visible labels", async () => {
    const navigation = navigationFor("/?view=kanban");
    await renderInProvider(navigation, { variant: "sheet" });
    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Admin"]);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(accessibleName(dashboard)).toBe("Dashboard");
  });

  it("gives every link, sub-link, account trigger, bell trigger and the brand/home link the 44px touch-target seam", async () => {
    await renderInProvider(navigationFor("/?view=kanban"), { variant: "sheet" });

    for (const link of [...testids("navigation-rail-link"), ...testids("navigation-rail-child-link")]) {
      expect(link.getAttribute("data-touch-target")).toBe("true");
    }
    expect(host.querySelector('[data-testid="navigation-rail-identity"]')?.getAttribute("data-touch-target")).toBe("true");
    expect(host.querySelector('[data-testid="navigation-rail-brand"]')?.getAttribute("data-touch-target")).toBe("true");
    expect(document.querySelector('[data-touch-target="true"] svg')).not.toBeNull();
  });

  it("shows the flyout's parent-model behaviour inline, not as a menu", async () => {
    await renderInProvider(navigationFor("/?view=kanban"), { variant: "sheet" });
    // Children are already showing — the model's `expandedItemId`, exactly like `expanded` — with
    // no click or hover needed, unlike `collapsed`.
    expect(linkTexts("navigation-rail-child-link")).toEqual(["List", "Kanban", "Calendar"]);
  });

  it("does not expose a menu seam on its parent link — its children are always inline here", async () => {
    await renderInProvider(navigationFor("/?view=kanban"), { variant: "sheet" });
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(dashboard.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("carries no rail-toggle — the Sheet's own trigger owns collapse while narrow", async () => {
    await renderInProvider(navigationFor("/"), { variant: "sheet" });
    expect(host.querySelector('[data-testid="rail-toggle"]')).toBeNull();
  });
});

describe("collapsed rail tooltips (#122)", () => {
  it("shows the item's label as a tooltip on hover while collapsed", async () => {
    await renderInProvider(navigationFor("/"), { variant: "collapsed" });
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;

    expect(document.querySelector('[data-testid^="rail-tooltip-"]')).toBeNull();

    await act(async () => {
      dashboard.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
      dashboard.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      dashboard.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const tooltip = document.querySelector('[data-testid^="rail-tooltip-"]');
      expect(tooltip).not.toBeNull();
      expect(tooltip?.textContent).toBe("Dashboard");
    });
  });

  it("does not show a tooltip while expanded — the label is already visible", async () => {
    // `SidebarMenuButton`'s own `tooltip` prop (`reui/sidebar.tsx`) renders the content with a
    // `hidden` attribute rather than omitting it while `state !== "collapsed"` — so this asserts
    // `hidden`, not absence from the document.
    await renderInProvider(navigationFor("/"), { variant: "expanded" });
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;

    await act(async () => {
      dashboard.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
      dashboard.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      dashboard.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const tooltip = document.querySelector('[data-testid^="rail-tooltip-"]');
    expect(tooltip, "the primitive renders the tooltip content hidden, not absent").not.toBeNull();
    expect(tooltip?.hasAttribute("hidden")).toBe(true);
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
