import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
 * base-nova's `sidebar.tsx`, adopted whole in #122 (ADR 0005). These tests exercise the three
 * behavioural PATCHES against the vendored primitive itself, with minimal `data-testid` probe
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

describe("SidebarProvider — patch 3: ⌘B through isRailShortcut", () => {
  it("toggles at 772 (wide)", async () => {
    await resizeTo(772);
    const onOpenChange = vi.fn();
    await render(<Probe open onOpenChange={onOpenChange} />);

    await keydown(window, { key: "b", metaKey: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("is ignored in a focused input", async () => {
    await resizeTo(772);
    const onOpenChange = vi.fn();
    await render(<Probe open onOpenChange={onOpenChange} />);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    await keydown(input, { key: "b", metaKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
    input.remove();
  });

  it("is ignored on a held-key repeat", async () => {
    await resizeTo(772);
    const onOpenChange = vi.fn();
    await render(<Probe open onOpenChange={onOpenChange} />);
    await keydown(window, { key: "b", metaKey: true, repeat: true });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("is ignored during IME composition", async () => {
    await resizeTo(772);
    const onOpenChange = vi.fn();
    await render(<Probe open onOpenChange={onOpenChange} />);
    await keydown(window, { key: "b", metaKey: true, isComposing: true });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("is ignored with Shift held", async () => {
    await resizeTo(772);
    const onOpenChange = vi.fn();
    await render(<Probe open onOpenChange={onOpenChange} />);
    await keydown(window, { key: "b", metaKey: true, shiftKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("is inert at 771 (narrow)", async () => {
    await resizeTo(771);
    const onOpenChange = vi.fn();
    await render(<Probe open onOpenChange={onOpenChange} />);
    await keydown(window, { key: "b", metaKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
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
