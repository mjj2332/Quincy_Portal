import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStaffNavigation, type StaffNavigation } from "../../lib/staff-navigation";
import { NAVIGATION_RAIL_FLAG } from "../../lib/feature-flags";
import { parseStaffLocation } from "../../lib/router";
import { NavigationRail } from "./NavigationRail";

// Sign out cannot be exercised against a real session — it would destroy the session every other
// check depends on — so the transport is mocked and the wiring asserted here instead. The handler
// itself is a copy of the Topbar's, but the path through `MenuPrimitive.Item`'s `render` is new.
const signOutMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../lib/auth", () => ({ signOut: signOutMock }));

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
  await act(async () => { root!.render(value); await Promise.resolve(); });
}

beforeEach(() => {
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
