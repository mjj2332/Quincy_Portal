import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { ConnectedApps } from "./ConnectedApps";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiDeleteMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiDelete: (path: string) => apiDeleteMock(path) };
});

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
const app = { id: "c1", clientName: "Claude Desktop", redirectHost: "claude.ai", scopes: ["read", "write"], createdAt: Date.UTC(2026, 9, 1), lastUsedAt: null, status: "active" };

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue([app]);
  apiDeleteMock.mockReset().mockResolvedValue(undefined);
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; document.body.replaceChildren(); });

async function mount() { await act(async () => { root!.render(<ConnectedApps />); await Promise.resolve(); }); await flush(); }
const revokeButton = () => [...document.querySelectorAll<HTMLElement>("button")].find((el) => el.textContent?.includes("Revoke"));

describe("ConnectedApps", () => {
  it("lists each app with its host, scope badges and last used", async () => {
    await mount();
    expect(apiGetMock).toHaveBeenCalledWith("/api/connected-apps");
    const row = document.querySelector('[data-testid="connected-app-row"]')!;
    expect(row.textContent).toContain("Claude Desktop");
    expect(row.textContent).toContain("claude.ai");
    expect(row.textContent).toContain("Never used");
    expect(row.textContent).toContain("Read");
    expect(row.textContent).toContain("Write");
  });

  it("shows an empty state when nothing is connected", async () => {
    apiGetMock.mockResolvedValue([]);
    await mount();
    expect(document.querySelector('[data-testid="connected-apps-empty"]')?.textContent).toContain("No connected apps");
  });

  it("revokes only after the confirm dialog, and Cancel changes nothing", async () => {
    await mount();
    await act(async () => { revokeButton()!.click(); await Promise.resolve(); });
    await flush();
    expect(document.querySelector('[data-testid="connected-app-revoke-confirm"]')?.textContent).toContain("Disconnect Claude Desktop?");
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="connected-app-revoke-cancel"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(apiDeleteMock).not.toHaveBeenCalled();
    await act(async () => { revokeButton()!.click(); await Promise.resolve(); });
    await flush();
    await act(async () => { document.querySelector<HTMLElement>('[data-testid="connected-app-revoke-action"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(apiDeleteMock).toHaveBeenCalledWith("/api/connected-apps/c1");
    expect(document.querySelector('[data-testid="connected-apps-empty"]')).not.toBeNull();
  });

  it("reports a load failure", async () => {
    apiGetMock.mockRejectedValue(new ApiError("Boom", 500));
    await mount();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Boom");
  });
});
