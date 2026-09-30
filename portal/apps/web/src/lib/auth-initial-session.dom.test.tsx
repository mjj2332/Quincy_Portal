import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { PrincipalFreshnessBoundary } from "../components/PrincipalFreshnessBoundary";
import { useSession } from "./auth";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Split out of auth-focus-refresh.dom.test.tsx (#389). better-auth's client fetches the initial
// session exactly once per module instance (`isInitialized` in its query atom never resets), so
// "the first mount fetches the session" only holds for the FIRST mount in a file. It is therefore
// the only test here: a fresh file gets a fresh `authClient`, whatever order the suite runs in.
// The `fetch` stub must exist before `lib/auth` is imported (the client captures it at import).
const fetchMock = vi.hoisted(() => {
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
});
const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("./api", () => ({ apiGet: (path: string) => apiGetMock(path) }));

const principal = "11111111-1111-4111-8111-111111111111";
const now = () => new Date().toISOString();
const sessionPayload = {
  session: { id: "s1", token: "t", userId: principal, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: now(), updatedAt: now() },
  user: { id: principal, name: "Test", email: "t@example.test", emailVerified: true, image: null, role: "editor", active: true, authorizationEpoch: 0, createdAt: now(), updatedAt: now() },
};

function SessionConsumer() {
  useSession();
  return null;
}

describe("initial session fetch (#360)", () => {
  it("the first mount fetches the session", async () => {
    apiGetMock.mockResolvedValue({ principal: { id: principal, role: "editor", authorizationEpoch: 0 }, authorizationFingerprint: "fp", projects: [] });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(sessionPayload), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client },
        createElement(PrincipalFreshnessBoundary, { principalId: principal, role: "editor", authorizationEpoch: 0, children: createElement(SessionConsumer) })));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const sessionCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      return url.includes("/api/auth/get-session");
    }).length;
    await act(async () => { root.unmount(); });
    host.remove();
    client.clear();
    expect(sessionCalls).toBeGreaterThan(0);
  });
});
