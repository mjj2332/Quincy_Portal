import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/reui/sidebar";
import { TooltipProvider } from "@/components/reui/tooltip";
import { PrincipalFreshnessBoundary } from "../PrincipalFreshnessBoundary";
import { ShellSearch } from "./ShellSearch";
import {
  __resetDashboardSearchStoreForTest,
  DASHBOARD_SEARCH_DEBOUNCE_MS,
  __getDashboardSearchSnapshotForTest,
  setDashboardSearchUrlWriter,
} from "../../lib/dashboard-search-store";

/**
 * #217 fix round 4, item 3 (BLOCKER) — the rail's `ShellSearch` renders on EVERY staff route, so a
 * signed-in-again principal's very first render must never carry the previous principal's search
 * text, and no timer that principal armed may go on to write a URL for the next one. The full
 * `PrincipalFreshnessBoundary` + `ShellSearch` pairing is exercised together, the same wiring
 * `App.tsx` gives the real app — a `ShellSearch`-only harness would prove nothing about the
 * boundary's own unmount/sign-out cleanup (this file's last two tests).
 *
 * `Probe`'s own `useLayoutEffect` is the "capture before any effect has run" technique: React
 * flushes EVERY layout effect in a commit, tree-wide, before it flushes ANY passive effect in that
 * same commit (`useEffect`, which is what `PrincipalFreshnessBoundary`'s own reset is) — a
 * documented ordering guarantee, not an `act()`-specific one. So `Probe`'s callback genuinely runs
 * after B's own render has committed to the DOM but strictly before the boundary's reset effect
 * has had any chance to run, inside one ordinary `act(() => {...})` call — no raw, unwrapped
 * `render()` call needed (React 18+ concurrent roots do not commit synchronously outside `act`, so
 * reading the DOM right after an un-acted `render()` call reads the PREVIOUS commit, not B's).
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const sessionRefetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api", () => ({ apiGet: (path: string) => apiGetMock(path) }));
vi.mock("../../lib/auth", () => ({ useSession: () => ({ refetch: sessionRefetchMock }) }));

const routerMock = vi.hoisted(() => ({ push: vi.fn<(location: string) => void>() }));
vi.mock("../../lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/router")>();
  return { ...actual, locationStore: () => ({ getLocation: () => "/", push: routerMock.push }) };
});

function accessSnapshot(id: string) {
  return { principal: { id, role: "editor" as const, authorizationEpoch: 0 }, authorizationFingerprint: `${id}-0`, projects: [] };
}

function mockAccessSnapshotFor(id: string) {
  apiGetMock.mockImplementation((path: string) => (path.includes("access-snapshot") ? Promise.resolve(accessSnapshot(id)) : Promise.resolve({})));
}

function Probe({ onLayout }: { onLayout: () => void }) {
  useLayoutEffect(() => {
    onLayout();
  });
  return null;
}

// `variant="sheet"` by default: its field is inline, so the isolation behaviour (render-time snapshot
// for the CURRENT principal, layout-effect ownership claim) is observable without opening anything.
// That logic sits in `ShellSearch`'s body and is variant-independent; the `rail` variant — the wide
// shell's only one since #426 — gets its own cases below, with the popover opened.
function harness(id: string, onLayout?: () => void, variant: "rail" | "sheet" = "sheet") {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PrincipalFreshnessBoundary principalId={id} role="editor" authorizationEpoch={0}>
        <SidebarProvider open={false}>
          <TooltipProvider delay={0}>
            <ShellSearch variant={variant} isDashboard={false} principalId={id} />
          </TooltipProvider>
        </SidebarProvider>
        {onLayout ? <Probe onLayout={onLayout} /> : null}
      </PrincipalFreshnessBoundary>
    </QueryClientProvider>
  );
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  apiGetMock.mockReset();
  mockAccessSnapshotFor("user-a");
  sessionRefetchMock.mockReset();
  routerMock.push.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  __resetDashboardSearchStoreForTest();
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root.unmount();
  });
  host.remove();
  document.body.replaceChildren();
  __resetDashboardSearchStoreForTest();
});

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("ShellSearch + PrincipalFreshnessBoundary — principal isolation (#217 fix round 4, item 3)", () => {
  it("B's FIRST committed render shows an empty input, captured before any effect has run", async () => {
    await act(async () => {
      root.render(harness("user-a"));
      await Promise.resolve();
    });
    const inputA = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(inputA, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

    mockAccessSnapshotFor("user-b");
    let capturedValue: string | null = null;
    act(() => {
      root.render(harness("user-b", () => {
        capturedValue = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value;
      }));
    });
    expect(capturedValue).toBe("");
  });

  it("impersonation start and stop each show an empty input, captured before any effect has run", async () => {
    await act(async () => {
      root.render(harness("admin-1"));
      await Promise.resolve();
    });
    const adminInput = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(adminInput, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

    // Impersonation start.
    mockAccessSnapshotFor("editor-2");
    let capturedAtStart: string | null = null;
    act(() => {
      root.render(harness("editor-2", () => {
        capturedAtStart = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value;
      }));
    });
    expect(capturedAtStart).toBe("");
    const impersonatedInput = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(impersonatedInput, "jones");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("jones");

    // Impersonation stop: back to the admin's own id — must ALSO start empty, not resurrect
    // whatever the admin was typing before impersonation began.
    mockAccessSnapshotFor("admin-1");
    let capturedAtStop: string | null = null;
    act(() => {
      root.render(harness("admin-1", () => {
        capturedAtStop = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value;
      }));
    });
    expect(capturedAtStop).toBe("");
  });

  it("a timer armed by A never commits or writes a URL under B, even if it would otherwise fire before B's own reset effect has run", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));

      await act(async () => {
        root.render(harness("user-a"));
        await Promise.resolve();
      });
      const inputA = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputA, "smith");
        inputA.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // Still mid-debounce.
      expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
      expect(writes).toEqual([]);

      // The armed timer is advanced past its debounce from INSIDE the layout-effect callback —
      // strictly before B's own boundary reset (a passive effect) has run — modelling "a
      // near-expiry timer can commit before the effect runs" deterministically.
      mockAccessSnapshotFor("user-b");
      act(() => {
        root.render(harness("user-b", () => {
          vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 50);
        }));
      });

      expect(writes).toEqual([]);
      unregister();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sign-out then signing back in as the SAME id starts empty", async () => {
    await act(async () => {
      root.render(harness("user-a"));
      await Promise.resolve();
    });
    const input = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

    // Sign-out: the WHOLE authenticated subtree unmounts (`App.tsx` renders `<SignIn>` instead) —
    // nothing here re-renders with a different principal, it just goes away.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(host);

    // Sign back in as the SAME person.
    await act(async () => {
      root.render(harness("user-a"));
      await Promise.resolve();
    });
    const inputAfterSignIn = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(inputAfterSignIn.value).toBe("");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("");
  });
});

describe("ShellSearch rail variant + PrincipalFreshnessBoundary — principal isolation (#426)", () => {
  async function openPopover() {
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      await Promise.resolve();
    });
    for (let tick = 0; tick < 50 && !document.querySelector('[data-testid="shell-search"]'); tick += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }

  it("B's first committed render of an already-open rail popover shows an empty input, captured before any effect has run", async () => {
    await act(async () => {
      root.render(harness("user-a", undefined, "rail"));
      await Promise.resolve();
    });
    await openPopover();
    const inputA = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(inputA, "the rail popover must be open").not.toBeNull();
    await type(inputA, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

    mockAccessSnapshotFor("user-b");
    let capturedValue: string | null = null;
    act(() => {
      root.render(harness("user-b", () => {
        capturedValue = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')?.value ?? null;
      }, "rail"));
    });
    // Either the popover stayed open and shows no leftover text, or it closed — never A's "smith".
    expect(capturedValue === "" || capturedValue === null).toBe(true);
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("");
  });

  it("sign-out then signing back in as the SAME id starts empty, through the rail popover", async () => {
    await act(async () => {
      root.render(harness("user-a", undefined, "rail"));
      await Promise.resolve();
    });
    await openPopover();
    await type(document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

    await act(async () => { root.unmount(); });
    root = createRoot(host);
    await act(async () => {
      root.render(harness("user-a", undefined, "rail"));
      await Promise.resolve();
    });
    await openPopover();
    expect(document.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!.value).toBe("");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("");
  });
});
