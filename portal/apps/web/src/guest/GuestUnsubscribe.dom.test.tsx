import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountGuestUnsubscribe } from "./mount-guest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement | null = null;
const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = () => host!.textContent ?? "";
const button = (label: string) => [...host!.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

type Fetch = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;
let fetchMock: Fetch;
const hashAtFetch: string[] = [];

async function open(hash = "#t=tok-123", respond: (call: number) => Response | Promise<Response> = () => reply(200, { subscribed: false })) {
  window.history.replaceState(null, "", `/d/unsubscribe${hash}`);
  hashAtFetch.length = 0;
  let call = 0;
  fetchMock = vi.fn(async () => { hashAtFetch.push(window.location.hash); return respond(call++); });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div"); document.body.appendChild(host);
  await act(async () => { mountGuestUnsubscribe(host!); });
  // The page is a lazy chunk: wait for it to render something.
  await vi.waitFor(() => { expect(host!.childElementCount).toBeGreaterThan(0); }, { timeout: 5000 });
  await flush();
}
const bodyOf = (n: number) => JSON.parse(String(fetchMock.mock.calls[n]![1]!.body)) as Record<string, unknown>;

beforeEach(() => { vi.spyOn(Storage.prototype, "setItem"); });
afterEach(() => { host?.remove(); host = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("GuestUnsubscribe (#741 15b)", () => {
  it("scrubs the fragment BEFORE the POST: location.hash is empty when fetch is called, and the token is in the body only", async () => {
    await open();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hashAtFetch).toEqual([""]);
    expect(window.location.hash).toBe("");
    expect(fetchMock.mock.calls[0]![0]).toBe("/d/api/unsubscribe");
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
    expect(bodyOf(0)).toEqual({ token: "tok-123" });
    expect(text()).toContain("You won't get emails about this review");
  });

  it("Resubscribe posts subscribed:true, then confirms and offers an Unsubscribe that undoes it", async () => {
    await open("#t=tok-123", (call) => reply(200, { subscribed: call === 1 }));
    await act(async () => { button("Resubscribe")!.click(); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)).toEqual({ token: "tok-123", subscribed: true });
    expect(text()).toContain("You'll get emails about this review again");
    expect(button("Resubscribe")).toBeUndefined();
    await act(async () => { button("Unsubscribe")!.click(); });
    await flush();
    expect(bodyOf(2)).toEqual({ token: "tok-123", subscribed: false });
    expect(text()).toContain("You won't get emails about this review");
  });

  it("an unknown token shows the unavailable state", async () => {
    await open("#t=nope", () => reply(404, { error: "not_found" }));
    expect(host!.querySelector('[data-testid="guest-unavailable"]')).not.toBeNull();
    expect(text()).toContain("This link isn't available.");
    expect(button("Resubscribe")).toBeUndefined();
  });

  it("a 503 on the first POST offers Retry; Retry re-POSTs the same token and a 200 shows the unsubscribed state", async () => {
    await open("#t=tok-123", (call) => (call === 0 ? reply(503, { error: "unavailable" }) : reply(200, { subscribed: false })));
    expect(host!.querySelector('[data-testid="guest-unavailable"]')).toBeNull();
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain("Try again.");
    expect(host!.textContent).toContain("We couldn't unsubscribe you just now");
    await act(async () => { button("Retry")!.click(); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)).toEqual({ token: "tok-123" });
    expect(text()).toContain("You won't get emails about this review");
    expect(button("Retry")).toBeUndefined();
  });

  it("a 429 shows Retry, not the unavailable state", async () => {
    await open("#t=tok-123", () => reply(429, { error: "rate_limited" }));
    expect(host!.querySelector('[data-testid="guest-unavailable"]')).toBeNull();
    expect(button("Retry")).toBeDefined();
  });

  it("keeps one request in flight: Retry is disabled while the retry is pending", async () => {
    let release: (r: Response) => void = () => {};
    await open("#t=tok-123", (call) => (call === 0 ? reply(500, {}) : new Promise<Response>((resolve) => { release = resolve; })));
    await act(async () => { button("Retry")!.click(); });
    expect((button("Retry") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { button("Retry")!.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { release(reply(200, { subscribed: false })); });
    await flush();
    expect(text()).toContain("You won't get emails about this review");
  });

  it("a 200 whose body read drops shows Retry, not the unavailable state", async () => {
    await open("#t=tok-123", () => { const r = reply(200, { subscribed: false }); vi.spyOn(r, "json").mockRejectedValue(new TypeError("connection lost")); return r; });
    expect(host!.querySelector('[data-testid="guest-unavailable"]')).toBeNull();
    expect(button("Retry")).toBeDefined();
  });

  it("a network error on the first POST offers Retry; no fragment makes no request", async () => {
    await open("#t=tok", () => { throw new Error("offline"); });
    expect(host!.querySelector('[data-testid="guest-unavailable"]')).toBeNull();
    expect(button("Retry")).toBeDefined();
    host!.remove(); host = null;
    await open("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host!.querySelector('[data-testid="guest-unavailable"]')).not.toBeNull();
  });

  it("a failed Resubscribe keeps the unsubscribed state and says so inline", async () => {
    await open("#t=tok-123", (call) => (call === 0 ? reply(200, { subscribed: false }) : reply(500, { error: "server_error" })));
    await act(async () => { button("Resubscribe")!.click(); });
    await flush();
    expect(host!.querySelector('[role="alert"]')).not.toBeNull();
    expect(text()).toContain("You won't get emails about this review");
    expect(button("Resubscribe")).toBeDefined();
  });

  it("keeps the token in memory only: nothing is written to storage", async () => {
    await open();
    expect(Storage.prototype.setItem).not.toHaveBeenCalled();
  });
});
