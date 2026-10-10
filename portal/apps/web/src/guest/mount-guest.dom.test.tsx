import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountGuest } from "./mount-guest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let host: HTMLElement | null = null;
afterEach(() => { host?.remove(); host = null; vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };

describe("mountGuest: the fragment is scrubbed before the chunk is requested", () => {
  it("with the import rejecting, location.hash is empty and replaceState ran before the import promise was created; Reload retries in place with the token", async () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=boot-token`);
    host = document.createElement("div");
    document.body.appendChild(host);
    const order: string[] = [];
    const replace = vi.spyOn(window.history, "replaceState");
    replace.mockImplementation(function (this: History, ...args) { order.push("replaceState"); return Object.getPrototypeOf(window.history).replaceState.apply(this, args); });
    const received: Array<string | null> = [];
    let attempt = 0;
    const importer = vi.fn(() => {
      order.push("import");
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("chunk gone"));
      return Promise.resolve({ GuestApp: ({ token }: { token: string | null }) => { received.push(token); return <div data-testid="guest-app-stub" />; } });
    });
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    await act(async () => { mountGuest(host!, importer); });
    await flush();
    expect(order).toEqual(["replaceState", "import"]);
    expect(window.location.hash).toBe("");
    expect(host.querySelector('[data-testid="guest-load-failure"]')).not.toBeNull();
    await act(async () => { host!.querySelector<HTMLButtonElement>("button")!.click(); });
    await flush();
    expect(importer).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="guest-app-stub"]')).not.toBeNull();
    expect([...new Set(received)]).toEqual(["boot-token"]);
    expect(reload).not.toHaveBeenCalled();
  });
});
