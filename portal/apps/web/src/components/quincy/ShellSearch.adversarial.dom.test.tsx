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
    <SidebarProvider open={false}>
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

describe("ShellSearch adversarial mode matrix (#217, #426)", () => {
  it.each(["rail", "sheet"] as const)("renders a usable search surface in %s mode", async (variant) => {
    await renderSearch({ variant });
    if (variant === "rail") {
      expect(host.querySelector('[data-testid="shell-search-trigger"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="shell-search"]')).toBeNull();
    } else {
      expect(host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')).not.toBeNull();
    }
  });

  // #217 design-review, item 8: a single Escape on a non-empty rail-popover draft now BOTH
  // clears it and closes the popover, where it previously took two. `keydown`'s dispatch already
  // bubbles (`bubbles: true`), which is what lets it reach the real Popover's own Escape handling.
  it("clears a non-empty rail-popover draft AND closes the popover on the same Escape", async () => {
    await renderSearch({ variant: "rail" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!;
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    const input = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await inputValue(input, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

    await keydown(input, { key: "Escape" });

    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("uses the normalized, encoded committed value for Enter from each mode off Dashboard", async () => {
    for (const variant of ["rail", "sheet"] as const) {
      await renderSearch({ variant, isDashboard: false });
      if (variant === "rail") {
        await act(async () => {
          host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!.click();
          await Promise.resolve();
        });
      }
      const input = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
      await inputValue(input, "  smith   + co  ");
      await keydown(input, { key: "Enter" });
      // #217 build, step 5 (sanctioned): the committed value used to be read back from the store's
      // own `.query`; the URL push IS the commit now, so this asserts on it directly.
      expect(routerMock.push).toHaveBeenLastCalledWith("/?q=smith+%2B+co");
      await act(async () => {
        __resetDashboardSearchStoreForTest();
        await Promise.resolve();
      });
      // Back to a closed, other-mode render so the next iteration starts clean.
      await renderSearch({ variant: variant === "rail" ? "sheet" : "rail", isDashboard: false });
    }
  });

  it("exposes the real input element through the ref in both modes for shortcut focus plumbing", async () => {
    const ref = createRef<ShellSearchHandle>();
    for (const variant of ["sheet", "rail"] as const) {
      await renderSearch({ variant }, ref);
      await act(async () => ref.current?.focus());
      for (let tick = 0; tick < 50 && !document.querySelector('[data-testid="shell-search"]'); tick += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      }
      const input = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]');
      expect(input).not.toBeNull();
      expect(ref.current?.getElement()).toBe(input);
      expect(document.activeElement).toBe(input);
      await renderSearch({ variant: "sheet" }, ref);
    }
  });
});
