import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rail's collapse, header, breadcrumb and Sheet, mounted by the real shell — #112. A separate
 * file from `App-navigation-rail.dom.test.tsx` and `App.dom.test.tsx`, both of which mock the real
 * chrome away; this file needs it.
 *
 * `window.innerWidth = N` does not work under this vitest + happy-dom setup: `populateGlobal`
 * (vitest's environment glue) traps that setter into a side table on the OUTER global proxy, which
 * never reaches the real internal happy-dom `Window` that `matchMedia`'s `MediaQueryList` actually
 * reads `innerWidth` from. `window.happyDOM.setViewport({ width })` is the supported escape hatch —
 * `happyDOM` is an object reference so the proxy always returns the same real instance, and
 * `setViewport` dispatches a genuine `resize` event itself, which is what `useMediaQuery`'s
 * `MediaQueryList` "change" listener is subscribed to.
 */
function setViewportWidth(width: number) {
  const happyWindow = window as unknown as { happyDOM: { setViewport(viewport: { width: number }): void } };
  happyWindow.happyDOM.setViewport({ width });
}

const sessionState = vi.hoisted(() => ({
  value: {
    data: { user: { id: "u1", name: "Ada Lovelace", role: "admin" } },
    isPending: false,
    refetch: vi.fn<() => Promise<void>>(),
  },
}));

vi.mock("./lib/auth", () => ({
  useSession: () => sessionState.value,
  stopImpersonating: vi.fn<() => Promise<void>>(),
  consumeSignInDestination: () => null,
  signOut: vi.fn<() => Promise<void>>(),
}));
// The rail's own bell (`NotificationBell`, mounted by `NavigationRail` and/or `ShellHeader`) polls
// the notifications endpoint on mount. Without this every test in this file reaches the network.
vi.mock("./lib/api", () => ({
  apiGet: vi.fn(async () => ({ notifications: [], unreadCount: 0 })),
  apiPost: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
}));
vi.mock("./lib/stages", () => ({ StagesProvider: ({ children }: { children: unknown }) => children }));
vi.mock("./screens/Dashboard", () => ({ Dashboard: () => <main>Dashboard</main> }));
vi.mock("./screens/ProjectWorkspace", () => ({ ProjectWorkspace: () => <main>Project</main> }));
vi.mock("./screens/SignIn", () => ({ SignIn: () => <main>Sign in</main> }));
vi.mock("./screens/Admin", () => ({ Admin: () => <main>Admin</main> }));
vi.mock("./screens/CreateProject", () => ({ CreateProject: () => <main>Create</main> }));
vi.mock("./screens/EditProject", () => ({ EditProject: () => <main>Edit</main> }));
vi.mock("./lib/query-client", () => ({
  QuincyQueryProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import App from "./App";
import { apiGet } from "./lib/api";
import { signOut } from "./lib/auth";
import { RAIL_PREFERENCE_KEY } from "./lib/shell-rail";
import { __resetDashboardSearchStoreForTest, getDashboardSearchSnapshot } from "./lib/dashboard-search-store";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Same shim `NoticeBoard.dom.test.tsx` already carries, for the same reason: under this toolchain's
 * Node runtime, Node's OWN native `globalThis.localStorage` (a Web Storage global Node now ships,
 * gated on `--localstorage-file`) wins over happy-dom's environment-provided `window.localStorage`
 * and is non-functional without that flag (`setItem`/`clear` are not even functions on it) — not a
 * defect in this file's code, and not something a `vitest.config` change should paper over for the
 * whole suite when a plain in-memory `Storage` replacement, scoped to the tests that need a real
 * one, already has a precedent.
 */
function installLocalStorageShim() {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  } });
}

/**
 * happy-dom (20.11.1) seeds each `MediaQueryList` "change" listener's last-seen state to `false`
 * instead of the list's current `matches` (`happy-dom/lib/match-media/MediaQueryList.js`
 * `addEventListener`), so a listener attached while `(max-width: 771px)` already matches swallows
 * the first narrow → wide transition. Browsers seed from the real state; this shim does the same,
 * scoped to this file, reading `matches` from happy-dom's own list.
 */
const happyDomMatchMedia = window.matchMedia.bind(window);
function installMatchMediaShim() {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => {
    const list = happyDomMatchMedia(query);
    const resizeListeners = new Map<unknown, () => void>();
    const add = (listener: (event: { matches: boolean; media: string }) => void) => {
      let last = list.matches;
      const onResize = () => {
        if (list.matches === last) return;
        last = list.matches;
        listener({ matches: last, media: list.media });
      };
      resizeListeners.set(listener, onResize);
      window.addEventListener("resize", onResize);
    };
    const remove = (listener: unknown) => {
      const onResize = resizeListeners.get(listener);
      if (onResize) window.removeEventListener("resize", onResize);
      resizeListeners.delete(listener);
    };
    return {
      get matches() { return list.matches; },
      media: list.media,
      onchange: null,
      addEventListener: (type: string, listener: (event: { matches: boolean; media: string }) => void) => {
        if (type === "change") add(listener);
      },
      removeEventListener: (type: string, listener: unknown) => {
        if (type === "change") remove(listener);
      },
      addListener: add,
      removeListener: remove,
      dispatchEvent: () => false,
    };
  } });
}

beforeEach(() => {
  sessionState.value = {
    data: { user: { id: "u1", name: "Ada Lovelace", role: "admin" } },
    isPending: false,
    refetch: vi.fn<() => Promise<void>>(),
  };
  installLocalStorageShim();
  installMatchMediaShim();
  window.localStorage.clear();
  setViewportWidth(1024);
  vi.mocked(signOut).mockClear();
  // `lib/dashboard-search-store.ts` is a module-level singleton, shared by every test in this
  // file the same way `window.localStorage` would be.
  __resetDashboardSearchStoreForTest();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  installLocalStorageShim();
  window.localStorage.clear();
  setViewportWidth(1024);
  vi.unstubAllEnvs();
  // Restores the module-level `apiGet` mock's default resolved value, for any test (like the
  // nonzero-badge one below) that overrides it — the mock itself is one `vi.fn()` shared by the
  // whole file, not reconstructed per test.
  vi.mocked(apiGet).mockResolvedValue({ notifications: [], unreadCount: 0 });
  __resetDashboardSearchStoreForTest();
});

async function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

async function tick() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function resizeTo(width: number) {
  await act(async () => {
    setViewportWidth(width);
    await Promise.resolve();
  });
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).focus?.();
    // `detail: 1` matters, not just realism: `InternalLink`'s `shouldInterceptInternalLink`
    // (`lib/router.ts`) treats `event.detail === 0` as a synthetic/keyboard-issued click and
    // deliberately does NOT call `preventDefault()` for one, so the SPA push through
    // `locationStore().push()` never runs — without this, happy-dom instead performs its OWN
    // real (but asynchronous, and popstate-free) anchor navigation on the unprevented click,
    // which changes `window.location` by a completely different path than the one under test and
    // never calls the router's own `notify()`, so anything subscribed to `locationStore()` (like
    // `RailedShell`'s close-on-location effect) never sees it.
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function keydown(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * A full realistic pointer press — pointerdown, mousedown, pointerup, mouseup, then click — for
 * dismissing Base UI's Backdrop. A bare synthetic `click` (what the shared `click()` helper above
 * sends) is not enough there: `useDismiss`'s outside-press handling tracks whether a press STARTED
 * inside the floating tree via React props (`onPointerDown`/`onMouseDown`, bound to the popup and
 * backdrop) before it ever looks at the trailing `click`, so a `click` with no preceding
 * pointerdown/mousedown pair is indistinguishable from a press that started elsewhere and never
 * reaches the outside-dismiss branch. A real backdrop press is this whole sequence, not one event.
 */
async function press(element: Element) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Base UI's Popup unmount, on close, waits for `getAnimations()` on the popup element to settle
 * (`useOpenChangeComplete`/`useAnimationsFinished`) before it actually removes the DOM — happy-dom
 * has no `Element.getAnimations`, so that hook falls back to firing immediately rather than
 * waiting on a real transition, but it still does so from a `useEffect`, one tick removed from the
 * event that triggered the close. A real-timer poll (mirroring `ConfirmDialog.dom.test.tsx`'s own
 * `waitForClose`) is what covers that tick regardless of exactly which microtask/macrotask it lands
 * on, rather than guessing a fixed number of `Promise.resolve()` flushes.
 */
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

function rail(host: ParentNode) {
  return host.querySelector<HTMLElement>('[data-testid="navigation-rail"]');
}
function railToggle(host: ParentNode) {
  // #122: the toggle moved from `ShellHeader` into `NavigationRail`'s own header as a
  // `SidebarTrigger` (`reui/sidebar.tsx`) — `rail-toggle`, not `shell-header-rail-toggle`.
  return host.querySelector<HTMLButtonElement>('[data-testid="rail-toggle"]');
}
function sheetTrigger(host: ParentNode) {
  return host.querySelector<HTMLButtonElement>('[data-testid="shell-header-sheet-trigger"]');
}

describe("the railed shell's collapse, header, breadcrumb and Sheet (#112)", () => {
  it("flips data-state via the header toggle, writes storage, and a remount with a pre-set collapsed starts collapsed", async () => {
    const host = await renderAt("/");
    expect(rail(host)?.getAttribute("data-state")).toBe("expanded");
    expect(railToggle(host)?.getAttribute("aria-expanded")).toBe("true");

    await click(railToggle(host)!);
    expect(rail(host)?.getAttribute("data-state")).toBe("collapsed");
    expect(railToggle(host)?.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem(RAIL_PREFERENCE_KEY)).toBe("collapsed");

    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.replaceChildren();

    const rehost = await renderAt("/");
    expect(rail(rehost)?.getAttribute("data-state")).toBe("collapsed");
  });

  it("flips data-state via ⌘B and writes storage", async () => {
    const host = await renderAt("/");
    expect(rail(host)?.getAttribute("data-state")).toBe("expanded");

    await keydown(window, { key: "b", metaKey: true });
    expect(rail(host)?.getAttribute("data-state")).toBe("collapsed");
    expect(window.localStorage.getItem(RAIL_PREFERENCE_KEY)).toBe("collapsed");

    await keydown(window, { key: "b", metaKey: true });
    expect(rail(host)?.getAttribute("data-state")).toBe("expanded");
    expect(window.localStorage.getItem(RAIL_PREFERENCE_KEY)).toBe("expanded");
  });

  it("does nothing for ⌘B inside a focused input", async () => {
    // A real `<input>` planted alongside the shell — Tiptap binds Mod-B to bold, and any other
    // editable surface must win the keystroke the same way.
    const host = await renderAt("/");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    await keydown(input, { key: "b", metaKey: true });
    expect(rail(host)?.getAttribute("data-state")).toBe("expanded");
    expect(window.localStorage.getItem(RAIL_PREFERENCE_KEY)).toBeNull();
    input.remove();
  });

  it("wide: the header contains only the breadcrumb nav — no toggle button of its own (#122)", async () => {
    const host = await renderAt("/");
    const header = host.querySelector('[data-testid="shell-header"]')!;
    expect(header).not.toBeNull();
    // #122: the toggle moved into NavigationRail's own header — ShellHeader carries no button
    // at all while wide.
    expect(header.querySelectorAll("button")).toHaveLength(0);
    expect(header.querySelector('[data-testid="shell-breadcrumb"]')).not.toBeNull();
    expect(header.querySelector('[data-testid="shell-header-sheet-trigger"]')).toBeNull();
    expect(header.querySelector('[data-testid="rail-notifications"]')).toBeNull();
  });

  it("reads Home › Dashboard › Kanban, and clicking Dashboard changes the location", async () => {
    const host = await renderAt("/?view=kanban");
    const crumb = host.querySelector('[data-testid="shell-breadcrumb"]')!;
    expect(crumb.textContent).toContain("Home");
    expect(crumb.textContent).toContain("Dashboard");
    expect(crumb.textContent).toContain("Kanban");
    expect(crumb.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe("Kanban");

    // Home › Dashboard › Kanban is 3 segments, so 2 separators — asserted structurally (every
    // `li` that is not a separator is a segment) rather than hard-coding "2", so this still means
    // the right thing if the trail's own length changes.
    const allSegmentLis = crumb.querySelectorAll("li");
    const separators = crumb.querySelectorAll('li[aria-hidden="true"]');
    expect(separators.length).toBe(allSegmentLis.length - separators.length - 1);
    // Tempo's bullet separator (a painted span), not the vendor's default chevron icon.
    for (const separator of separators) expect(separator.querySelector("svg")).toBeNull();

    const dashboardLink = [...crumb.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Dashboard")!;
    expect(dashboardLink.getAttribute("href")).toBe("/");
    await click(dashboardLink);
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });

  it("exactly one Primary navigation landmark, wide", async () => {
    const host = await renderAt("/");
    expect(host.querySelectorAll('nav[aria-label="Primary navigation"]')).toHaveLength(1);
  });

  it("wide header contains no button and exactly one nav, and every a sits inside the nav (#122)", async () => {
    const host = await renderAt("/?view=kanban");
    const header = host.querySelector('[data-testid="shell-header"]')!;
    // #122: the toggle moved into NavigationRail's own header — the breadcrumb nav is the only
    // interactive landmark left in ShellHeader while wide.
    expect(header.querySelectorAll("button")).toHaveLength(0);
    expect(header.querySelectorAll("nav")).toHaveLength(1);
    const nav = header.querySelector("nav")!;
    const anchors = [...header.querySelectorAll("a")];
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect(nav.contains(anchor)).toBe(true);
  });

  describe("below 772px", () => {
    it("has no in-flow rail; the trigger opens a named dialog with a backdrop; Escape closes it and returns focus", async () => {
      const host = await renderAt("/");
      await resizeTo(600);
      await tick();

      expect(rail(host)).toBeNull();
      const trigger = sheetTrigger(host);
      expect(trigger).not.toBeNull();
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull();

      await click(trigger!);
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      const titleId = dialog?.getAttribute("aria-labelledby") ?? "";
      expect(document.getElementById(titleId)?.textContent).toBe("Navigation");
      expect(dialog?.contains(document.getElementById(titleId))).toBe(true);
      expect(sheetTrigger(host)?.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector('[data-testid="rail-sheet"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="rail-sheet-scrim"]')).not.toBeNull();
      expect(document.querySelectorAll('nav[aria-label="Primary navigation"]')).toHaveLength(1);

      await keydown(document.querySelector('[data-testid="rail-sheet"]')!, { key: "Escape" });
      await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
      expect(sheetTrigger(host)?.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(sheetTrigger(host));
    });

    // #217 fix round 2, item 2 (Sol's diff review): `sheetInitialFocus()` returned `undefined` for
    // an ORDINARY hamburger-tap open, which `@base-ui/react/dialog`'s own `DialogPopup` prop docs
    // define as "do nothing" -- not "use the default behaviour" (that is `true`/`null`) -- so focus
    // was left on the (now inert, outside the modal) trigger instead of moving into the Sheet.
    it("an ordinary hamburger-tap open moves focus inside the Sheet, not left on the inert trigger", async () => {
      const host = await renderAt("/");
      await resizeTo(600);
      await tick();
      const trigger = sheetTrigger(host)!;

      await click(trigger);

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(document.activeElement).not.toBe(trigger);
      expect(dialog?.contains(document.activeElement)).toBe(true);
    });

    it("a scrim click closes the Sheet", async () => {
      const host = await renderAt("/");
      await resizeTo(600);
      await tick();

      await click(sheetTrigger(host)!);
      expect(document.querySelector('[data-testid="rail-sheet"]')).not.toBeNull();

      const scrim = document.querySelector('[data-testid="rail-sheet-scrim"]')!;
      await press(scrim);
      await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
    });

    it("clicking a Sheet nav link closes it", async () => {
      const host = await renderAt("/?view=kanban");
      await resizeTo(600);
      await tick();

      await click(sheetTrigger(host)!);
      const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
      // The Dashboard link's own href ("/") differs from the current "/?view=kanban", so
      // following it is a genuine location change RailedShell's close-on-location effect reacts to.
      const dashboardLink = [...sheet.querySelectorAll('[data-testid="navigation-rail-link"]')]
        .find((a) => a.textContent?.trim() === "Dashboard")! as HTMLAnchorElement;
      await click(dashboardLink);
      await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
      expect(window.location.pathname).toBe("/");
    });

    it("the account menu opened inside the Sheet portals inside rail-sheet, and Sign out is focusable", async () => {
      const host = await renderAt("/");
      await resizeTo(600);
      await tick();

      await click(sheetTrigger(host)!);
      const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
      const accountTrigger = sheet.querySelector<HTMLButtonElement>('[data-testid="navigation-rail-account"]')!;
      await click(accountTrigger);

      const signOut = document.querySelector<HTMLElement>('[data-testid="navigation-rail-signout"]');
      expect(signOut).not.toBeNull();
      expect(sheet.contains(signOut)).toBe(true);
      signOut!.focus();
      expect(document.activeElement).toBe(signOut);
      // The trigger and the menu item are both buttons, not `a[href]` — opening the account menu
      // and clicking inside it must not be mistaken for following a nav link and close the Sheet.
      expect(document.querySelector('[data-testid="rail-sheet"]')).not.toBeNull();
    });

    it("reaches Dashboard, Admin and Notification preferences inside the open Sheet (#113)", async () => {
      // Each destination closes the Sheet on activation, so this is three separate renders, not
      // one Sheet followed three times — each block unmounts its own root before the next
      // `renderAt` reassigns the shared `root`/`host`, the same discipline the file's own
      // remount test above uses, or the earlier renders' `⌘B` window listeners and storage
      // effects leak into every later test in this file.
      {
        const host = await renderAt("/admin");
        await resizeTo(600);
        await tick();
        await click(sheetTrigger(host)!);
        const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
        const dashboardLink = [...sheet.querySelectorAll('[data-testid="navigation-rail-link"]')]
          .find((a) => a.textContent?.trim() === "Dashboard")! as HTMLAnchorElement;
        expect(dashboardLink.getAttribute("href")).toBe("/");
        await click(dashboardLink);
        await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
        expect(window.location.pathname).toBe("/");
        if (root) await act(async () => root!.unmount());
        root = null;
        document.body.replaceChildren();
      }
      {
        const host = await renderAt("/");
        await resizeTo(600);
        await tick();
        await click(sheetTrigger(host)!);
        const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
        const adminLink = [...sheet.querySelectorAll('[data-testid="navigation-rail-link"]')]
          .find((a) => a.textContent?.trim() === "Admin")! as HTMLAnchorElement;
        expect(adminLink.getAttribute("href")).toBe("/admin");
        await click(adminLink);
        await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
        expect(window.location.pathname).toBe("/admin");
        if (root) await act(async () => root!.unmount());
        root = null;
        document.body.replaceChildren();
      }
      {
        // Notification preferences sits behind the Sheet's own nested account menu, not the rail
        // itself — #122 P3's account panel, reused unchanged inside the Sheet.
        const host = await renderAt("/");
        await resizeTo(600);
        await tick();
        await click(sheetTrigger(host)!);
        const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
        const accountTrigger = sheet.querySelector<HTMLButtonElement>('[data-testid="navigation-rail-account"]')!;
        await click(accountTrigger);
        const preferences = document.querySelector<HTMLAnchorElement>('[data-testid="navigation-rail-preferences"]')!;
        expect(preferences.getAttribute("href")).toBe("/settings/notifications/preferences");
        await click(preferences);
        await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
        expect(window.location.pathname).toBe("/settings/notifications/preferences");
      }
    });

    it("gives Admin aria-current inside the Sheet when it is the active route (#113)", async () => {
      const host = await renderAt("/admin");
      await resizeTo(600);
      await tick();
      await click(sheetTrigger(host)!);
      const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
      const adminLink = [...sheet.querySelectorAll('[data-testid="navigation-rail-link"]')]
        .find((a) => a.textContent?.trim() === "Admin")!;
      expect(adminLink.getAttribute("aria-current")).toBe("page");
      expect(adminLink.getAttribute("data-active")).toBe("");
      const dashboardLink = [...sheet.querySelectorAll('[data-testid="navigation-rail-link"]')]
        .find((a) => a.textContent?.trim() === "Dashboard")!;
      expect(dashboardLink.hasAttribute("data-active")).toBe(false);
    });

    it("gives the Sheet's brand link the rail's own 44px touch-target utility, a real href and its accessible name (#113)", async () => {
      const host = await renderAt("/");
      await resizeTo(600);
      await tick();
      await click(sheetTrigger(host)!);
      const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
      const brand = sheet.querySelector<HTMLAnchorElement>('[data-testid="navigation-rail-brand"]')!;
      // `SHEET_TOUCH_TARGET` (`NavigationRail.tsx`) — the real utility the rail applies in
      // `sheet`, not the retired Topbar's own `max-[721px]:min-h-[44px]`.
      expect(brand.className).toContain("min-h-[44px]");
      expect(brand.classList.contains("button--text")).toBe(false);
      expect(brand.getAttribute("href")).toBe("/");
      expect(brand.getAttribute("aria-label")).toBe("Quincy Portal home");
    });

    it("calls signOut once from the Sheet's own nested account menu (#113)", async () => {
      const host = await renderAt("/");
      await resizeTo(600);
      await tick();
      await click(sheetTrigger(host)!);
      const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
      const accountTrigger = sheet.querySelector<HTMLButtonElement>('[data-testid="navigation-rail-account"]')!;
      await click(accountTrigger);
      const signOutButton = document.querySelector<HTMLButtonElement>('[data-testid="navigation-rail-signout"]')!;
      await click(signOutButton);
      expect(vi.mocked(signOut)).toHaveBeenCalledTimes(1);
    });

    it("clicking the already-current Kanban link inside the Sheet closes it too", async () => {
      // The current route's link publishes the same location, so the close-on-location effect alone
      // would leave the Sheet open.
      const host = await renderAt("/?view=kanban");
      await resizeTo(771);
      await tick();

      await click(sheetTrigger(host)!);
      const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
      const kanbanLink = sheet.querySelector<HTMLAnchorElement>('[aria-current="page"]')!;
      expect(kanbanLink.textContent?.trim()).toBe("Kanban");

      await click(kanbanLink);
      await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
      expect(window.location.search).toBe("?view=kanban");
    });

    it("⌘B changes neither storage nor the DOM", async () => {
      const host = await renderAt("/");
      await resizeTo(600);
      await tick();

      await keydown(window, { key: "b", metaKey: true });
      expect(window.localStorage.getItem(RAIL_PREFERENCE_KEY)).toBeNull();
      expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull();
      expect(sheetTrigger(host)).not.toBeNull();
    });

    it("the bell and its badge are in the header, not the Sheet", async () => {
      // `mockResolvedValue`, not `-Once`: the WIDE-mode bell (`NavigationRail`'s own, mounted
      // first at this test's default 1024px) polls once too, and a one-shot value would be
      // consumed by that mount before the narrow-mode bell under test ever asks.
      vi.mocked(apiGet).mockResolvedValue({ notifications: [], unreadCount: 5 });
      const host = await renderAt("/");
      await resizeTo(600);
      await tick();

      const header = host.querySelector('[data-testid="shell-header"]')!;
      expect(header.querySelector('[data-testid="rail-notifications"]')).not.toBeNull();
      await waitFor(() => expect(header.querySelector('[data-testid="rail-notification-badge"]')?.textContent).toBe("5"));

      await click(sheetTrigger(host)!);
      const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
      expect(sheet.querySelector('[data-testid="rail-notifications"]')).toBeNull();
      expect(sheet.querySelector('[data-testid="rail-notification-badge"]')).toBeNull();
    });

    it("is absent at 772 and present at 771 — a single-stage collapse, unlike the retired Topbar's two", async () => {
      const host = await renderAt("/");
      // 1007px and 1008px were the Topbar's OWN first collapse stage (`identity`/`avatar` hiding
      // independently of the Sheet trigger) — the rail replaces that two-stage collapse with one,
      // so both leave the wide shell (rail present, no header trigger) entirely unchanged.
      await resizeTo(1008);
      await tick();
      expect(sheetTrigger(host)).toBeNull();
      expect(railToggle(host)).not.toBeNull();
      expect(rail(host)).not.toBeNull();

      await resizeTo(1007);
      await tick();
      expect(sheetTrigger(host)).toBeNull();
      expect(railToggle(host)).not.toBeNull();
      expect(rail(host)).not.toBeNull();

      await resizeTo(772);
      await tick();
      expect(sheetTrigger(host)).toBeNull();
      expect(railToggle(host)).not.toBeNull();

      await resizeTo(771);
      await tick();
      expect(sheetTrigger(host)).not.toBeNull();
      expect(railToggle(host)).toBeNull();
    });

    it("keeps the narrow header bell mounted at 771px under an impersonation banner", async () => {
      sessionState.value = {
        data: { user: { id: "target", name: "Editor Target", role: "editor" }, session: { impersonatedBy: "u1" } },
        isPending: false,
        refetch: vi.fn<() => Promise<void>>(),
      } as unknown as typeof sessionState.value;
      const host = await renderAt("/");
      await resizeTo(771);
      await tick();

      expect(host.querySelector('aside[aria-label="Impersonation status"]')).not.toBeNull();
      expect(rail(host)).toBeNull();
      const header = host.querySelector('[data-testid="shell-header"]')!;
      expect(header.querySelector('[data-testid="shell-header-sheet-trigger"]')).not.toBeNull();
      expect(header.querySelector('[data-testid="rail-notifications"]')).not.toBeNull();
      expect(header.querySelector('[data-testid="rail-notification-trigger"]')).not.toBeNull();
    });
  });

  it("widening reapplies a stored collapsed", async () => {
    window.localStorage.setItem(RAIL_PREFERENCE_KEY, "collapsed");
    setViewportWidth(600);
    const host = await renderAt("/");
    expect(rail(host)).toBeNull();
    expect(sheetTrigger(host)).not.toBeNull();

    await resizeTo(1024);
    await tick();
    expect(rail(host)?.getAttribute("data-state")).toBe("collapsed");
    expect(railToggle(host)?.getAttribute("aria-expanded")).toBe("false");
  });

  it("widening then re-narrowing closes the Sheet and keeps the rail mode rules consistent", async () => {
    const host = await renderAt("/");
    await resizeTo(600);
    await tick();
    await click(sheetTrigger(host)!);
    expect(document.querySelector('[data-testid="rail-sheet"]')).not.toBeNull();

    await resizeTo(1024);
    await tick();
    expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull();
    expect(rail(host)?.getAttribute("data-state")).toBe("expanded");
    expect(sheetTrigger(host)).toBeNull();

    await resizeTo(600);
    await tick();
    await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
    expect(rail(host)).toBeNull();
    expect(sheetTrigger(host)).not.toBeNull();
  });
});

describe("⌘K project search (#217, replacing #122 P3's navigate-then-latch)", () => {
  it("wide, from Admin: focuses the rail's search input without navigating", async () => {
    const host = await renderAt("/admin");
    expect(window.location.pathname).toBe("/admin");

    await keydown(window, { key: "k", metaKey: true });

    expect(window.location.pathname).toBe("/admin");
    expect(document.activeElement).toBe(host.querySelector('[data-testid="shell-search"]'));
  });

  it("wide, already on a Dashboard view: focuses the input without touching the URL", async () => {
    const host = await renderAt("/?view=kanban");

    await keydown(window, { key: "k", metaKey: true });

    expect(window.location.search).toBe("?view=kanban");
    expect(document.activeElement).toBe(host.querySelector('[data-testid="shell-search"]'));
  });

  // #217 fix round 1, item 6: Sol's diff review found the narrow/Sheet case's "inert" assertion
  // wrong -- with the Sheet already open (its input visible), ⌘K must focus it; with the Sheet
  // closed, ⌘K must open it and focus the input once it mounts. Neither ever navigates.
  it("narrow, Sheet closed: ⌘K opens the Sheet and focuses its search input", async () => {
    await renderAt("/admin");
    await resizeTo(600);
    await tick();
    expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull();

    await keydown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).not.toBeNull());

    expect(window.location.pathname).toBe("/admin");
    const searchInput = document.querySelector('[data-testid="shell-search"]');
    expect(searchInput).not.toBeNull();
    expect(document.activeElement).toBe(searchInput);
  });

  it("narrow, Sheet already open: ⌘K focuses its search input directly", async () => {
    const host = await renderAt("/admin");
    await resizeTo(600);
    await tick();
    await click(sheetTrigger(host)!);
    const searchInput = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    // Move focus away first, so a passing test can't be an accident of where it already was.
    sheetTrigger(host)!.focus();
    expect(document.activeElement).not.toBe(searchInput);

    await keydown(window, { key: "k", metaKey: true });

    expect(window.location.pathname).toBe("/admin");
    expect(document.activeElement).toBe(searchInput);
  });

  // Restores the Sheet focus-return regression coverage removed alongside the old
  // `suppressSheetFinalFocusRef` mechanism (#217): a ⌘K-triggered open, unlike the deleted
  // navigate-then-latch flow, never suppresses the Sheet's own default close-restores-focus-to-
  // trigger behaviour, since there is no longer a second, Dashboard-owned input to preserve focus
  // toward.
  it("does not leave focus restoration broken after a ⌘K-triggered Sheet open", async () => {
    const host = await renderAt("/admin");
    await resizeTo(600);
    await tick();

    await keydown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).not.toBeNull());
    expect(document.activeElement).toBe(document.querySelector('[data-testid="shell-search"]'));

    await keydown(document.querySelector('[data-testid="rail-sheet"]')!, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
    expect(document.activeElement).toBe(sheetTrigger(host));
  });

  it("ignores an editable target and a held-key repeat", async () => {
    await renderAt("/admin");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    await keydown(input, { key: "k", metaKey: true });
    expect(window.location.pathname).toBe("/admin");
    expect(document.activeElement).toBe(input);

    await keydown(window, { key: "k", metaKey: true, repeat: true });
    expect(window.location.pathname).toBe("/admin");
    expect(document.activeElement).toBe(input);

    input.remove();
  });

  it("typing then Enter inside the Sheet's search closes the Sheet and navigates", async () => {
    const host = await renderAt("/admin");
    await resizeTo(600);
    await tick();

    await click(sheetTrigger(host)!);
    const sheet = document.querySelector('[data-testid="rail-sheet"]')!;
    const searchInput = sheet.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(searchInput, "smith");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await keydown(searchInput, { key: "Enter" });

    await waitFor(() => expect(document.querySelector('[data-testid="rail-sheet"]')).toBeNull());
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?q=smith");
    expect(getDashboardSearchSnapshot().query).toBe("smith");
  });

  it("leaves ⌘B untouched", async () => {
    const host = await renderAt("/");
    await keydown(window, { key: "b", metaKey: true });
    expect(rail(host)?.getAttribute("data-state")).toBe("collapsed");
  });
});

/**
 * #217 fix round 3, item 1 (Sol's whole-branch review), extended by round 4, item 1 (Sol
 * re-review, BLOCKER). `staff-navigation.ts`'s own model stays pure (`NavigationRail.dom.test.tsx`
 * covers it unchanged) — this exercises the REAL shell (`app-router.tsx`'s `ShellRoute`), which
 * grafts the live search store's value back onto the rail's Dashboard child hrefs. `Dashboard` is
 * mocked in this file, so every assertion here is on the URL and the rail's own input directly.
 * The Calendar child link now carries `q` itself, on the bare intent (`staff-routes.ts`'s
 * `DashboardCalendarIntentRoute` gained one in round 4 specifically because a native navigation —
 * keyboard Enter, cmd/middle-click, a reload — loads `href` as a fresh document with no in-memory
 * store left to fall back on); `Dashboard.tsx`'s own canonicaliser reading that same `q` back off
 * the route into the concrete facet URL is covered separately in `Dashboard-calendar.dom.test.tsx`.
 */
describe("rail Dashboard child links carry the live search (#217 fix round 3, item 1; round 4, item 1)", () => {
  function childLink(host: ParentNode, label: string) {
    return [...host.querySelectorAll('[data-testid="navigation-rail-child-link"]')].find((element) => element.textContent?.trim() === label) as HTMLAnchorElement | undefined;
  }

  async function typeAndCommit(host: ParentNode, value: string) {
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await keydown(input, { key: "Enter" });
  }

  it("click List → Kanban → Calendar → List with a committed q keeps it in the URL and the input at every step", async () => {
    const host = await renderAt("/?view=list");
    await typeAndCommit(host, "smith");
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value).toBe("smith");

    await click(childLink(host, "Kanban")!);
    expect(window.location.search).toContain("view=kanban");
    expect(window.location.search).toContain("q=smith");
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value).toBe("smith");

    await click(childLink(host, "Calendar")!);
    // The Calendar child link is the bare intent, carrying its OWN `q` now (#217 fix round 4,
    // item 1) — reading it back off the route into a concrete facet URL is `Dashboard.tsx`'s own
    // canonicaliser's job, exercised in `Dashboard-calendar.dom.test.tsx` instead (`Dashboard` is
    // mocked in this file).
    expect(window.location.search).toBe("?view=calendar&q=smith");
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value).toBe("smith");

    await click(childLink(host, "List")!);
    expect(window.location.search).toContain("view=list");
    expect(window.location.search).toContain("q=smith");
    expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value).toBe("smith");
  });

  it("carries the search into a List/Kanban rail click even mid-debounce, before the 300ms commit", async () => {
    const host = await renderAt("/?view=list");
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "smith");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    // No Enter, no wait: still inside the 300ms debounce when the rail link is clicked.
    await click(childLink(host, "Kanban")!);
    expect(window.location.search).toContain("q=smith");
  });

  it("an empty search omits `q` from every Dashboard child href", async () => {
    const host = await renderAt("/?view=list");
    expect(childLink(host, "Kanban")!.getAttribute("href")).toBe("/?view=kanban");
    expect(childLink(host, "List")!.getAttribute("href")).toBe("/?view=list");
    expect(childLink(host, "Calendar")!.getAttribute("href")).toBe("/?view=calendar");
  });

  // #217 fix round 4, item 1 (Sol re-review, BLOCKER). The `href` attribute itself, not just the
  // URL a click ends up at -- this is what a keyboard Enter, cmd/middle-click or "open in new tab"
  // actually reads, none of which go through React's click handler at all.
  it("the Calendar child link's href attribute carries q, like List and Kanban", async () => {
    const host = await renderAt("/?view=list");
    await typeAndCommit(host, "smith");
    expect(childLink(host, "List")!.getAttribute("href")).toBe("/?view=list&q=smith");
    expect(childLink(host, "Kanban")!.getAttribute("href")).toBe("/?view=kanban&q=smith");
    expect(childLink(host, "Calendar")!.getAttribute("href")).toBe("/?view=calendar&q=smith");
  });

  // #217 fix round 4, item 2 (Sol re-review, do-with-1). A raw, not-yet-committed draft carries
  // stray whitespace no caller pre-processes any more -- `staffPathFor` normalises it itself
  // (strip, collapse, trim, cap), so every rail href reflects exactly what the store's own
  // committed `query` would, never a differently-shaped value.
  it("every Dashboard child href normalises whitespace in the live draft the same way the store's own commit does", async () => {
    const host = await renderAt("/?view=list");
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  smith   street  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    // Still mid-debounce: the href reflects the raw draft directly, normalised at build time.
    expect(childLink(host, "List")!.getAttribute("href")).toBe("/?view=list&q=smith+street");
    expect(childLink(host, "Kanban")!.getAttribute("href")).toBe("/?view=kanban&q=smith+street");
    expect(childLink(host, "Calendar")!.getAttribute("href")).toBe("/?view=calendar&q=smith+street");
  });
});
