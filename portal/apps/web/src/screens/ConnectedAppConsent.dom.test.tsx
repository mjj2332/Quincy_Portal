import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { ConnectedAppConsent } from "./ConnectedAppConsent";

const HANDLE = "A".repeat(43);
const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});

let root: Root | null = null;
const assign = vi.fn();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
const consent = (over: Record<string, unknown> = {}) => ({ clientName: "Claude Desktop", redirectHost: "claude.ai", isLocalhost: false, scopes: ["read", "write"], warning: "This app will see Portal data you can see", ...over });

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue(consent());
  apiPostMock.mockReset().mockResolvedValue({ redirectTo: "https://claude.ai/cb?code=x" });
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { vi.unstubAllGlobals(); if (root) await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; document.body.replaceChildren(); });

async function mount(isAdmin = false) { await act(async () => { root!.render(<ConnectedAppConsent handle={HANDLE} isAdmin={isAdmin} />); await Promise.resolve(); }); await flush(); }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
// Base UI puts the id on its hidden input; its `.checked` / `.disabled` mirror the visible control.
const checkbox = (scope: string) => document.getElementById(`consent-scope-${scope}`) as HTMLInputElement | null;

describe("ConnectedAppConsent", () => {
  it("shows the client, redirect host, the warning, and read required", async () => {
    await mount();
    expect(apiGetMock).toHaveBeenCalledWith(`/api/connected-apps/consent/${HANDLE}`);
    expect(document.querySelector('[data-testid="consent-client"]')?.textContent).toBe("Claude Desktop");
    expect(document.querySelector('[data-testid="consent-host"]')?.textContent).toBe("claude.ai");
    expect(document.querySelector('[data-testid="consent-warning"]')?.textContent).toBe("This app will see Portal data you can see");
    expect(document.querySelector('[data-testid="consent-localhost"]')).toBeNull();
    expect(checkbox("read")?.checked).toBe(true);
    expect(checkbox("read")?.disabled).toBe(true);
    expect(checkbox("write")?.checked).toBe(false);
    expect(checkbox("admin")).toBeNull();
    // The warning is the real legend of the scope group, not a loose paragraph.
    const legend = document.querySelector("fieldset > legend");
    expect(legend?.textContent).toBe("This app will see Portal data you can see");
    expect(legend?.closest("fieldset")?.contains(checkbox("read"))).toBe(true);
  });

  it("flags a localhost redirect", async () => {
    apiGetMock.mockResolvedValue(consent({ redirectHost: "localhost", isLocalhost: true }));
    await mount();
    expect(document.querySelector('[data-testid="consent-localhost"]')).not.toBeNull();
  });

  it("offers admin only to admins, unchecked, with its own warning once ticked", async () => {
    apiGetMock.mockResolvedValue(consent({ scopes: ["read", "write", "admin"] }));
    await mount(false);
    expect(checkbox("admin")).toBeNull();
    await act(async () => { root!.unmount(); }); document.body.replaceChildren();
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await mount(true);
    expect(checkbox("admin")?.checked).toBe(false);
    expect(document.querySelector('[data-testid="consent-admin-warning"]')).toBeNull();
    await act(async () => { checkbox("admin")!.click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="consent-admin-warning"]')).not.toBeNull();
  });

  it("Approve posts the chosen scopes and leaves with window.location.assign", async () => {
    await mount();
    await act(async () => { button("Approve").click(); await Promise.resolve(); });
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/connected-apps/consent/${HANDLE}`, { decision: "approve", scopes: ["read"] });
  });

  it("Approve includes Write only when ticked", async () => {
    await mount();
    await act(async () => { checkbox("write")!.click(); await Promise.resolve(); });
    await act(async () => { button("Approve").click(); await Promise.resolve(); });
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/connected-apps/consent/${HANDLE}`, { decision: "approve", scopes: ["read", "write"] });
    expect(assign).toHaveBeenCalledWith("https://claude.ai/cb?code=x");
  });

  it("Deny posts a deny decision", async () => {
    await mount();
    await act(async () => { button("Deny").click(); await Promise.resolve(); });
    await flush();
    expect(apiPostMock).toHaveBeenCalledWith(`/api/connected-apps/consent/${HANDLE}`, { decision: "deny", scopes: [] });
    expect(assign).toHaveBeenCalled();
  });

  it("an expired or used handle is a clear error state", async () => {
    apiGetMock.mockRejectedValue(new ApiError("gone", 404));
    await mount();
    expect(document.querySelector('[data-testid="consent-expired"]')?.textContent).toContain("expired or was already used");
    expect(document.querySelector("button")).toBeNull();
    expect(document.body.textContent).not.toContain("An app is asking to act as you");
    expect(document.querySelector('[data-testid="consent-expired"]')?.parentElement?.querySelector('a[href="/settings/connected-apps"]')).not.toBeNull();
  });

  it("shows a refusal and stays on the page", async () => {
    apiPostMock.mockRejectedValue(new ApiError("Connecting an app is not available while impersonating", 403));
    await mount();
    await act(async () => { button("Approve").click(); await Promise.resolve(); });
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("impersonating");
    expect(assign).not.toHaveBeenCalled();
  });
});
