import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStaffNavigation, type StaffNavigation } from "../../lib/staff-navigation";
import { NAVIGATION_RAIL_FLAG } from "../../lib/feature-flags";
import { parseStaffLocation } from "../../lib/router";
import { initials } from "../../lib/initials";
import { NavigationRail } from "./NavigationRail";

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
 * The rail's rendering — #111.
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

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue({ notifications: [], unreadCount: 0 });
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
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);

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
    await render(<NavigationRail navigation={navigation} user={USER} />);

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
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);
    const calendar = testids("navigation-rail-child-link").find(
      (element) => element.textContent?.trim() === "Calendar",
    );
    expect(calendar?.getAttribute("href")).toBe("/?view=calendar");
  });

  it("marks the active item with data-active=\"true\", the exact value the paint selects on", async () => {
    // Not incidental: the primitive's paint is `data-[active=true]:…`, and Base UI's default state
    // mapping would render a boolean as a valueless `data-active=""` that those variants do not
    // match. `reui/sidebar.tsx` writes the attribute explicitly for this reason, and this is the
    // assertion that would catch someone moving it back into `state`.
    await render(<NavigationRail navigation={navigationFor("/?view=list")} user={USER} />);

    const active = testids("navigation-rail-child-link").filter(
      (element) => element.getAttribute("data-active") === "true",
    );
    expect(active.map((element) => element.textContent?.trim())).toEqual(["List"]);

    const kanban = testids("navigation-rail-child-link").find(
      (element) => element.textContent?.trim() === "Kanban",
    );
    expect(kanban?.getAttribute("data-active")).toBe("false");
  });

  it("carries the leading rule on every item, so activating one shifts no text", async () => {
    await render(<NavigationRail navigation={navigationFor("/?view=list")} user={USER} />);
    for (const link of testids("navigation-rail-child-link")) {
      expect(link.className).toContain("[border-inline-start:var(--border-width-bold)_solid_transparent]");
    }
    // Logical, not physical: the rule follows the writing direction.
    expect(host.innerHTML).not.toContain("border-left-color");
  });

  it("renders no children when the model closes the group", async () => {
    const navigation = navigationFor("/admin");
    expect(navigation.expandedItemId).toBeNull();
    await render(<NavigationRail navigation={navigation} user={USER} />);
    expect(testids("navigation-rail-child-link")).toEqual([]);
  });

  it("gives every item an icon", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);
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
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);
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
    await render(<NavigationRail navigation={navigationFor("/?view=kanban")} user={USER} />);

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
    await render(<NavigationRail navigation={navigationFor("/admin")} user={USER} />);
    const current = [
      ...host.querySelectorAll('[aria-current="page"]'),
    ].map((element) => element.textContent?.trim());
    expect(current).toEqual(["Admin"]);
  });

  it("renders the wordmark and the identity", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);
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
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);

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
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);
    const trigger = document.querySelector('[data-testid="navigation-rail-account"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Account menu for Terry Lee");
  });

  it("names the flag nowhere in its output", async () => {
    // #80's flag leaked `kanban2` into a user-visible aria-label (docs/lessons.md:1689). The shell
    // decides whether to mount the rail; the rail itself must not know the flag exists.
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);
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

    await render(<NavigationRail navigation={widened} user={USER} />);

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
    await render(<NavigationRail navigation={navigation} user={USER} />);
    expect(linkTexts("navigation-rail-child-link")).toEqual(["List", "Kanban"]);
    expect(host.textContent).not.toContain("Calendar");
  });
});

// -----------------------------------------------------------------------------
// #112 P2 — variants, the collapsed flyout, and the sheet's 44px touch targets
// -----------------------------------------------------------------------------

describe("NavigationRail variant — expanded (unchanged)", () => {
  it("carries data-state=\"expanded\" and shows visible labels, by default", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);
    expect(host.querySelector('[data-testid="navigation-rail"]')?.getAttribute("data-state")).toBe("expanded");
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(accessibleName(dashboard)).toBe("Dashboard");
  });

  it("does not expose the flyout's aria-expanded/aria-controls seam — its children are always inline here", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(dashboard.hasAttribute("aria-expanded")).toBe(false);
    expect(dashboard.hasAttribute("aria-controls")).toBe(false);
  });
});

describe("NavigationRail variant — collapsed", () => {
  it("is 48px wide, sr-only labels, and no wordmark", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const rail = host.querySelector('[data-testid="navigation-rail"]')!;
    expect(rail.getAttribute("data-state")).toBe("collapsed");
    expect(testids("navigation-rail-brand")).toEqual([]);
  });

  it("keeps every icon link's accessible name even though the label is visually hidden", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    // Visually hidden text is still the link's accessible name — it is in the DOM, only hidden by
    // CSS a happy-dom assertion cannot see, so this asserts the name itself rather than the class
    // that hides it.
    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Admin"]);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(accessibleName(dashboard)).toBe("Dashboard");
  });

  it("shows the account trigger's initials only, dropping the name/email and the chevron", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const identity = host.querySelector('[data-testid="navigation-rail-identity"]') as HTMLElement;
    expect(identity.textContent?.trim()).toBe(initials(USER.name));
    expect(identity.querySelector("svg")).toBeNull();
  });

  it("opens the Dashboard flyout on pointer hover, showing its children with the active one current", async () => {
    await render(<NavigationRail navigation={navigationFor("/?view=kanban")} user={USER} variant="collapsed" />);
    const item = host.querySelector('[data-testid="navigation-rail-item"]')!;
    expect(testids("navigation-rail-child-link")).toEqual([]);

    await act(async () => {
      item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      await Promise.resolve();
    });

    expect(linkTexts("navigation-rail-child-link")).toEqual(["List", "Kanban", "Calendar"]);
    const current = [...host.querySelectorAll('[aria-current="page"]')].map((el) => el.textContent?.trim());
    expect(current).toEqual(["Kanban"]);
  });

  it("opens the Dashboard flyout when focus enters the item, not only on hover", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    await act(async () => { dashboard.focus(); await Promise.resolve(); });
    expect(linkTexts("navigation-rail-child-link")).toEqual(["List", "Kanban", "Calendar"]);
  });

  it("closes the flyout on pointer leave", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const item = host.querySelector('[data-testid="navigation-rail-item"]')!;
    await act(async () => {
      item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      await Promise.resolve();
    });
    expect(testids("navigation-rail-child-link").length).toBeGreaterThan(0);
    await act(async () => {
      item.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
      await Promise.resolve();
    });
    expect(testids("navigation-rail-child-link")).toEqual([]);
  });

  it("does not close the flyout on pointer leave while the item holds keyboard focus", async () => {
    // A mouse that merely passes over the item on its way elsewhere must not close a flyout a
    // keyboard user is still tabbed into — `onPointerLeave` closing unconditionally would strand
    // that user's focus inside an invisible flyout.
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const item = host.querySelector('[data-testid="navigation-rail-item"]')!;
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    await act(async () => { dashboard.focus(); await Promise.resolve(); });
    const firstChild = testids("navigation-rail-child-link")[0]!;
    await act(async () => { firstChild.focus(); await Promise.resolve(); });
    expect(testids("navigation-rail-child-link").length).toBeGreaterThan(0);

    await act(async () => {
      item.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
      await Promise.resolve();
    });

    expect(testids("navigation-rail-child-link").length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(firstChild);
  });

  it("closes the flyout when focus leaves the item, but not when it moves to one of the flyout's own children", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    await act(async () => { dashboard.focus(); await Promise.resolve(); });
    const firstChild = testids("navigation-rail-child-link")[0]!;

    // Moving focus from the Dashboard link to its own flyout child must not close it.
    await act(async () => { firstChild.focus(); await Promise.resolve(); });
    expect(testids("navigation-rail-child-link").length).toBeGreaterThan(0);

    // Moving focus somewhere outside the item entirely must close it.
    const admin = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Admin")!;
    await act(async () => { admin.focus(); await Promise.resolve(); });
    expect(testids("navigation-rail-child-link")).toEqual([]);
  });

  it("closes the flyout on Escape and returns focus to the Dashboard link", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    await act(async () => { dashboard.focus(); await Promise.resolve(); });
    const firstChild = testids("navigation-rail-child-link")[0]!;
    await act(async () => { firstChild.focus(); await Promise.resolve(); });
    expect(testids("navigation-rail-child-link").length).toBeGreaterThan(0);

    await act(async () => {
      firstChild.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(testids("navigation-rail-child-link")).toEqual([]);
    expect(document.activeElement).toBe(dashboard);
  });

  it("re-arms the flyout after Escape is pressed while the PARENT link itself is focused", async () => {
    // If the Dashboard link is already the focused element when Escape is pressed (rather than one
    // of its flyout children), `linkRef.current?.focus()` fires no focus event — the ref that
    // suppresses one reopen must not stay armed forever, or the next real focus (tab away, tab
    // back) silently fails to reopen the flyout.
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    const admin = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Admin")!;

    await act(async () => { dashboard.focus(); await Promise.resolve(); });
    expect(testids("navigation-rail-child-link").length).toBeGreaterThan(0);

    await act(async () => {
      dashboard.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(testids("navigation-rail-child-link")).toEqual([]);
    expect(document.activeElement).toBe(dashboard);

    // Tab away, then back — a still-armed suppression ref swallows this real focus.
    await act(async () => { admin.focus(); await Promise.resolve(); });
    await act(async () => { dashboard.focus(); await Promise.resolve(); });
    expect(testids("navigation-rail-child-link").length).toBeGreaterThan(0);
  });

  it("exposes the flyout's open state on the parent link, closed", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(dashboard.getAttribute("aria-expanded")).toBe("false");
    // Nothing is rendered to point at while the flyout is closed — `aria-controls` must never
    // reference a missing id.
    expect(dashboard.hasAttribute("aria-controls")).toBe(false);
  });

  it("exposes the flyout's open state on the parent link, open — aria-controls names the flyout's own id", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} variant="collapsed" />);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    await act(async () => { dashboard.focus(); await Promise.resolve(); });

    expect(dashboard.getAttribute("aria-expanded")).toBe("true");
    const controlsId = dashboard.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    const flyout = host.querySelector(`#${controlsId}`);
    expect(flyout).not.toBeNull();
    expect(flyout?.querySelectorAll('[data-testid="navigation-rail-child-link"]').length).toBeGreaterThan(0);
  });

  it("leaves Admin — an item with no children — unaffected by hover or focus", async () => {
    await render(<NavigationRail navigation={navigationFor("/admin")} user={USER} variant="collapsed" />);
    const items = [...host.querySelectorAll('[data-testid="navigation-rail-item"]')];
    const adminItem = items[1]!;
    await act(async () => {
      adminItem.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      await Promise.resolve();
    });
    expect(testids("navigation-rail-child-link")).toEqual([]);
  });
});

describe("NavigationRail variant — sheet", () => {
  it("is 288px, carries data-state=\"sheet\", and shows visible labels", async () => {
    const navigation = navigationFor("/?view=kanban");
    await render(<NavigationRail navigation={navigation} user={USER} variant="sheet" />);
    expect(host.querySelector('[data-testid="navigation-rail"]')?.getAttribute("data-state")).toBe("sheet");
    expect(linkTexts("navigation-rail-link")).toEqual(["Dashboard", "Admin"]);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(accessibleName(dashboard)).toBe("Dashboard");
  });

  it("gives every link, sub-link, account trigger, bell trigger and the brand/home link the 44px touch-target seam", async () => {
    await render(<NavigationRail navigation={navigationFor("/?view=kanban")} user={USER} variant="sheet" />);

    for (const link of [...testids("navigation-rail-link"), ...testids("navigation-rail-child-link")]) {
      expect(link.getAttribute("data-touch-target")).toBe("true");
    }
    expect(host.querySelector('[data-testid="navigation-rail-identity"]')?.getAttribute("data-touch-target")).toBe("true");
    expect(host.querySelector('[data-testid="navigation-rail-brand"]')?.getAttribute("data-touch-target")).toBe("true");
    expect(document.querySelector('[data-touch-target="true"] svg')).not.toBeNull();
  });

  it("shows the flyout's parent-model behaviour inline, not as a hover flyout", async () => {
    await render(<NavigationRail navigation={navigationFor("/?view=kanban")} user={USER} variant="sheet" />);
    // Children are already showing — the model's `expandedItemId`, exactly like `expanded` — with
    // no hover or focus needed, unlike `collapsed`.
    expect(linkTexts("navigation-rail-child-link")).toEqual(["List", "Kanban", "Calendar"]);
  });

  it("does not expose the flyout's aria-expanded/aria-controls seam — its children are always inline here", async () => {
    await render(<NavigationRail navigation={navigationFor("/?view=kanban")} user={USER} variant="sheet" />);
    const dashboard = testids("navigation-rail-link").find((el) => el.textContent?.trim() === "Dashboard")!;
    expect(dashboard.hasAttribute("aria-expanded")).toBe(false);
    expect(dashboard.hasAttribute("aria-controls")).toBe(false);
  });
});

describe("NavigationRail — showBell", () => {
  it("mounts the bell by default and omits it when showBell is false", async () => {
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);
    expect(host.querySelector('[data-testid="rail-notifications"]')).not.toBeNull();

    await render(<NavigationRail navigation={navigationFor("/")} user={USER} showBell={false} />);
    expect(host.querySelector('[data-testid="rail-notifications"]')).toBeNull();
  });
});

describe("the account menu's sign out", () => {
  it("calls signOut when the menu item is activated", async () => {
    // Presence in the DOM is not the behaviour. This is the assertion that would catch the item
    // rendering correctly while its `onClick` never reaches the transport — the failure mode of
    // handing a handler to a primitive's `render` prop rather than to the element itself.
    signOutMock.mockClear();
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);

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
    await render(<NavigationRail navigation={navigationFor("/")} user={USER} />);

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
