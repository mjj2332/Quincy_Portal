import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stopImpersonatingMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const refetchMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("../lib/auth", () => ({ stopImpersonating: stopImpersonatingMock, useSession: () => ({ refetch: refetchMock }) }));

import { ImpersonationBanner } from "./ImpersonationBanner";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  stopImpersonatingMock.mockReset().mockResolvedValue(undefined);
  refetchMock.mockReset().mockResolvedValue(undefined);
  window.history.replaceState(null, "", "/projects/target");
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host.remove(); window.history.replaceState(null, "", "/");
});

describe("ImpersonationBanner", () => {
  it("shows the exact target identity and exits through the stock client transition", async () => {
    let resolveExit!: () => void;
    stopImpersonatingMock.mockImplementation(() => new Promise<void>((resolve) => { resolveExit = resolve; }));
    await act(async () => { root!.render(<ImpersonationBanner user={{ name: "Editor Example", role: "editor" }} invalidated={false} />); });
    expect(host.textContent).toContain("Acting as Editor Example (Editor) · Exit");
    const button = host.querySelector<HTMLButtonElement>('[data-testid="impersonation-exit"]')!;
    await act(async () => { button.click(); });
    expect(button.disabled).toBe(true);
    resolveExit();
    await flush();
    expect(stopImpersonatingMock).toHaveBeenCalledTimes(1);
    expect(refetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/");
  });

  it("keeps Exit available and shows the persistent manual fallback when stock Exit fails", async () => {
    stopImpersonatingMock.mockRejectedValueOnce(new Error("flag is off"));
    await act(async () => { root!.render(<ImpersonationBanner user={{ name: "Photographer Example", role: "photographer" }} invalidated={true} />); });
    expect(host.querySelector("[data-invalidated='true']")).not.toBeNull();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="impersonation-exit"]')!;
    await act(async () => { button.click(); await Promise.resolve(); });
    const alert = host.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toBe("Could not automatically exit. Sign out completely and sign back in as Admin to restore your session.");
    expect(alert.title).toBe(alert.textContent);
    expect(alert.parentElement).toBe(host.querySelector('[aria-label="Impersonation status"]'));
    expect(button.disabled).toBe(false);
    expect(refetchMock).not.toHaveBeenCalled();
  });

  it("keeps Exit off the legacy scoped-override class and on the inverted hover colour utility", async () => {
    await act(async () => { root!.render(<ImpersonationBanner user={{ name: "Editor Example", role: "editor" }} invalidated={false} />); });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="impersonation-exit"]')!;
    // Guards against a future "cleanup" reintroducing `.button--text`, whose
    // `:hover:not(:disabled)` (0,3,0) outranked the old scoped override (0,2,0) — see E-11/E-12.
    expect(button.classList.contains("button--text")).toBe(false);
    expect(button.classList.contains("hover:not-disabled:!text-on-inverse")).toBe(true);
  });
});
