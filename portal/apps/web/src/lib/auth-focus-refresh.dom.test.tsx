import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrincipalFreshnessBoundary } from "../components/PrincipalFreshnessBoundary";
import { useSession } from "./auth";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Uses the REAL `lib/auth` (unlike PrincipalFreshnessBoundary.dom.test.tsx, which mocks it) so the
// test sees every get-session request better-auth's client and the Portal's own listeners produce
// between them (#360). Only `apiGet` (the access snapshot) and `fetch` are stubbed.
//
// `createAuthClient` captures `globalThis.fetch` ONCE, when `lib/auth` is first imported
// (`customFetchImpl: fetch`, better-auth client config), so a `beforeEach` stub is too late: the
// stub must exist before the import, which is why it is installed in `vi.hoisted`. The
// no-unmocked-fetch guard reasserts its own `fetch` per test, which does not touch this captured
// reference.
const fetchMock = vi.hoisted(() => {
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
});
const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("./api", () => ({ apiGet: (path: string) => apiGetMock(path) }));

const principal = "11111111-1111-4111-8111-111111111111";
const sessionPayload = {
  session: { id: "s1", token: "t", userId: principal, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  user: { id: principal, name: "Test", email: "t@example.test", emailVerified: true, image: null, role: "editor", active: true, authorizationEpoch: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
};

function SessionConsumer() {
  useSession();
  return null;
}

let clock = Date.now();

describe("session refresh on focus / reconnect (#360)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const sessionCalls = () => fetchMock.mock.calls.filter(([input]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    return url.includes("/api/auth/get-session");
  }).length;
  const setVisibility = (state: "hidden" | "visible") => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); }); };

  beforeEach(async () => {
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ principal: { id: principal, role: "editor", authorizationEpoch: 0 }, authorizationFingerprint: "fp", projects: [] });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(sessionPayload), { status: 200, headers: { "content-type": "application/json" } }));
    // better-auth rate-limits focus/online refetches by wall clock (5s). Fake ONLY Date so each
    // test starts outside that window while real timers keep running.
    vi.useFakeTimers({ toFake: ["Date"] });
    clock += 60_000;
    vi.setSystemTime(clock);
    setVisibility("visible");
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client },
        createElement(PrincipalFreshnessBoundary, { principalId: principal, role: "editor", authorizationEpoch: 0, children: createElement(SessionConsumer) })));
    });
    await settle();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    client.clear();
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

  it("returning to a hidden tab produces exactly one session request", async () => {
    expect(sessionCalls()).toBeGreaterThan(0);
    const baseline = sessionCalls();
    setVisibility("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(sessionCalls() - baseline).toBe(1);
  });

  it("an online event produces exactly one session request", async () => {
    const baseline = sessionCalls();
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(sessionCalls() - baseline).toBe(1);
  });
});
