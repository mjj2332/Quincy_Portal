import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/reui/sidebar";
import { TooltipProvider } from "@/components/reui/tooltip";
import { ShellSearch, type ShellSearchHandle, type ShellSearchProps } from "./ShellSearch";
import {
  __getDashboardSearchSnapshotForTest,
  __resetDashboardSearchStoreForTest,
} from "../../lib/dashboard-search-store";

const routerMock = vi.hoisted(() => ({ push: vi.fn<(location: string) => void>() }));
vi.mock("../../lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/router")>();
  return { ...actual, locationStore: () => ({ getLocation: () => "/admin", push: routerMock.push }) };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

async function render(value: ReactNode) {
  await act(async () => {
    root.render(value);
    await Promise.resolve();
  });
}

async function renderSearch(props: Partial<ShellSearchProps> & { variant: ShellSearchProps["variant"] }, ref?: React.RefObject<ShellSearchHandle | null>) {
  await render(
    <SidebarProvider open={props.variant !== "collapsed"} onOpenChange={() => {}}>
      <TooltipProvider delay={0}>
        <ShellSearch ref={ref} variant={props.variant} isDashboard={props.isDashboard ?? false} principalId={props.principalId ?? "principal-a"} />
      </TooltipProvider>
    </SidebarProvider>,
  );
}

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function keydown(target: EventTarget, init: KeyboardEventInit) {
  let defaultPrevented = false;
  await act(async () => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    defaultPrevented = !target.dispatchEvent(event);
    await Promise.resolve();
  });
  return defaultPrevented;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  routerMock.push.mockClear();
  __resetDashboardSearchStoreForTest();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  __resetDashboardSearchStoreForTest();
});

describe("ShellSearch adversarial mode matrix (#217)", () => {
  it.each(["expanded", "collapsed", "sheet"] as const)("renders a usable search surface in %s mode", async (variant) => {
    await renderSearch({ variant });
    if (variant === "collapsed") {
      expect(host.querySelector('[data-testid="shell-search-trigger"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="shell-search"]')).toBeNull();
    } else {
      expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')).not.toBeNull();
    }
  });

  // #217 design-review, item 8: a single Escape on a non-empty collapsed-popover draft now BOTH
  // clears it and closes the popover, where it previously took two. `keydown`'s dispatch already
  // bubbles (`bubbles: true`), which is what lets it reach the real Popover's own Escape handling.
  it("clears a non-empty collapsed-popover draft AND closes the popover on the same Escape", async () => {
    await renderSearch({ variant: "collapsed" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    const input = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await inputValue(input, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

    await keydown(input, { key: "Escape" });

    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "", query: "" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("uses the normalized, encoded committed value for Enter from each inline mode off Dashboard", async () => {
    for (const variant of ["expanded", "sheet"] as const) {
      await renderSearch({ variant, isDashboard: false });
      const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
      await inputValue(input, "  smith   + co  ");
      await keydown(input, { key: "Enter" });
      expect(__getDashboardSearchSnapshotForTest().query).toBe("smith + co");
      expect(routerMock.push).toHaveBeenLastCalledWith("/?q=smith+%2B+co");
      await renderSearch({ variant, isDashboard: false });
      await act(async () => {
        __resetDashboardSearchStoreForTest();
        await Promise.resolve();
      });
    }
  });

  it("exposes the real input element through the ref in all three modes for shortcut focus plumbing", async () => {
    const ref = createRef<ShellSearchHandle>();
    for (const variant of ["expanded", "sheet", "collapsed"] as const) {
      await renderSearch({ variant }, ref);
      await act(async () => ref.current?.focus());
      const input = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]');
      expect(ref.current?.getElement()).toBe(input);
      expect(document.activeElement).toBe(input);
      await renderSearch({ variant: "expanded" }, ref);
    }
  });
});
