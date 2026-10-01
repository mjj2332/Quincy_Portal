import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "./sidebar";

/**
 * base-nova's `sidebar.tsx`, adopted whole in #122 (ADR 0005). These tests exercise the
 * behavioural PATCHES (patch 3, the ⌘B shortcut, was retired by #426 and is pinned absent) against the vendored primitive itself, with minimal `data-testid` probe
 * components — never the primitive's own `data-slot` values (`testing/test-seam.guard.test.ts`
 * guard F). The conformance edits (imports, the `--sidebar-width` rename, the removed focus ring,
 * `bg-background` → `bg-[color:var(--bg-canvas)]`) are non-behavioural and are not re-tested here;
 * see the file's own header.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setViewportWidth(width: number) {
  const happyWindow = window as unknown as { happyDOM: { setViewport(viewport: { width: number }): void } };
  happyWindow.happyDOM.setViewport({ width });
}

/**
 * happy-dom (20.11.1) seeds each `MediaQueryList` "change" listener's last-seen state to `false`
 * instead of the list's current `matches`, so a listener attached while `(max-width: 771px)`
 * already matches swallows the first narrow → wide transition. Mirrors
 * `App-navigation-rail-shell.dom.test.tsx`'s own shim.
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

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); });
}

async function tick() {
  await act(async () => { await Promise.resolve(); });
}

async function resizeTo(width: number) {
  await act(async () => { setViewportWidth(width); await Promise.resolve(); });
}

async function keydown(target: EventTarget, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  installMatchMediaShim();
  setViewportWidth(1024);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
  setViewportWidth(1024);
});

function Probe({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <SidebarProvider open={open} onOpenChange={onOpenChange}>
      <Sidebar collapsible="icon" data-testid="probe-sidebar">
        <SidebarContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive data-testid="probe-active-item">Active</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
        <SidebarTrigger data-testid="probe-trigger" />
      </Sidebar>
    </SidebarProvider>
  );
}

describe("SidebarProvider — patch 1: no cookie", () => {
  it("SidebarTrigger's click calls onOpenChange, and never writes document.cookie", async () => {
    const onOpenChange = vi.fn();
    const cookieSetter = vi.fn();
    const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", { configurable: true, set: cookieSetter, get: () => "" });

    try {
      await render(<Probe open onOpenChange={onOpenChange} />);
      const trigger = host.querySelector<HTMLButtonElement>('[data-testid="probe-trigger"]')!;
      await act(async () => { trigger.click(); await Promise.resolve(); });

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(cookieSetter).not.toHaveBeenCalled();
    } finally {
      if (originalDescriptor) Object.defineProperty(document, "cookie", originalDescriptor);
    }
  });
});

describe("SidebarProvider — patch 2: one breakpoint", () => {
  function IsMobileProbe() {
    const { isMobile } = useSidebar();
    return <span data-testid="probe-is-mobile">{String(isMobile)}</span>;
  }

  it("useSidebar().isMobile is false at 772 and true at 771", async () => {
    await resizeTo(772);
    await render(
      <SidebarProvider open onOpenChange={() => {}}>
        <IsMobileProbe />
      </SidebarProvider>,
    );
    expect(host.querySelector('[data-testid="probe-is-mobile"]')?.textContent).toBe("false");

    await resizeTo(771);
    await tick();
    expect(host.querySelector('[data-testid="probe-is-mobile"]')?.textContent).toBe("true");
  });
});

describe("SidebarProvider — patch 3 retired: no keyboard shortcut (#426, ADR 0015)", () => {
  // The rail has no collapse, so the vendor's ⌘B handler (and the app's own replacement for it) is
  // deleted. These replace the six toggle/ignore cases the retired patch carried: a shortcut that
  // never fires cannot fire in an input, on a repeat, mid-IME, with Shift, or while narrow either.
  function stateOf() {
    return document.querySelector('[data-testid="probe-sidebar"]')?.closest("[data-state]")?.getAttribute("data-state");
  }

  it.each([772, 771])("does not toggle on ⌘B at %ipx", async (width) => {
    await resizeTo(width);
    const onOpenChange = vi.fn();
    await render(<Probe open onOpenChange={onOpenChange} />);
    const before = stateOf();
    // Narrow renders the Sheet branch instead of the rail, so there is no rail state to read there.
    if (width === 772) expect(before, "the probe must expose a real provider state").toBe("expanded");

    await keydown(window, { key: "b", metaKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(stateOf()).toBe(before);
  });

  it.each([772, 771])("does not toggle on Ctrl+B at %ipx", async (width) => {
    await resizeTo(width);
    const onOpenChange = vi.fn();
    await render(<Probe open onOpenChange={onOpenChange} />);
    const before = stateOf();
    // Narrow renders the Sheet branch instead of the rail, so there is no rail state to read there.
    if (width === 772) expect(before, "the probe must expose a real provider state").toBe("expanded");

    await keydown(window, { key: "b", ctrlKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(stateOf()).toBe(before);
  });

  it("does not toggle on ⌘B with the provider uncontrolled either", async () => {
    await resizeTo(772);
    await render(
      <SidebarProvider>
        <Sidebar collapsible="icon" data-testid="probe-sidebar"><SidebarContent /></Sidebar>
      </SidebarProvider>,
    );
    const before = stateOf();
    await keydown(window, { key: "b", metaKey: true });
    expect(stateOf()).toBe(before);
  });

  it("registers no keydown listener at all — the vendor handler is not restored", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "sidebar.tsx"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code).not.toMatch(/addEventListener\(\s*["']keydown["']/);
    expect(code).not.toMatch(/SIDEBAR_KEYBOARD_SHORTCUT/);
  });
});

describe("SidebarMenuButton — isActive", () => {
  it("renders a present data-active attribute when isActive, absent otherwise", async () => {
    await resizeTo(1024);
    await render(<Probe open onOpenChange={() => {}} />);
    const item = host.querySelector('[data-testid="probe-active-item"]');
    expect(item?.hasAttribute("data-active")).toBe(true);
  });
});
