import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountGuest } from "./mount-guest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let host: HTMLElement | null = null;
afterEach(() => { host?.remove(); host = null; vi.restoreAllMocks(); window.sessionStorage.clear(); });
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };

describe("mountGuest: the fragment is scrubbed before the chunk is requested", () => {
  it("with the import rejecting, location.hash is empty and replaceState ran before the import promise was created; Reload reopens the link with the in-memory token", async () => {
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=boot-token`);
    host = document.createElement("div");
    document.body.appendChild(host);
    const order: string[] = [];
    const replace = vi.spyOn(window.history, "replaceState");
    replace.mockImplementation(function (this: History, ...args) { order.push("replaceState"); return Object.getPrototypeOf(window.history).replaceState.apply(this, args); });
    const importer = vi.fn(() => {
      order.push("import");
      return Promise.reject(new Error("chunk gone"));
    });
    const reopen = vi.fn();
    await act(async () => { mountGuest(host!, importer, reopen); });
    await flush();
    expect(order).toEqual(["replaceState", "import"]);
    expect(window.location.hash).toBe("");
    expect(host.querySelector('[data-testid="guest-load-failure"]')).not.toBeNull();
    await act(async () => { host!.querySelector<HTMLButtonElement>("button")!.click(); });
    await flush();
    // A full reload, not an in-place retry: the browser caches the rejected import, and a deploy removed the old chunk.
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith("boot-token", null, null);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("hands the film id from the fragment to GuestApp as initialVideoId, and Reload reopens with it", async () => {
    const film = "11111111-1111-4111-8111-000000000001";
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=boot-token&v=${film}`);
    host = document.createElement("div");
    document.body.appendChild(host);
    const seen: unknown[] = [];
    const importer = vi.fn(() => Promise.resolve({ GuestApp: (props: { token: string | null; initialVideoId?: string | null }) => { seen.push(props); return null; } }));
    await act(async () => { mountGuest(host!, importer as never, vi.fn()); });
    await flush();
    expect(seen[0]).toEqual({ token: "boot-token", initialVideoId: film, pageSlug: null });
    expect(window.location.hash).toBe("");
  });

  it("hands the validated Delivery page address to GuestApp as pageSlug (#882), and Reload reopens with it", async () => {
    const film = "11111111-1111-4111-8111-000000000001"; const slug = "14-harbour-st-mosman-d234xz";
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=boot-token&v=${film}&p=${slug}`);
    host = document.createElement("div");
    document.body.appendChild(host);
    const seen: unknown[] = [];
    const importer = vi.fn(() => Promise.resolve({ GuestApp: (props: unknown) => { seen.push(props); return null; } }));
    await act(async () => { mountGuest(host!, importer as never, vi.fn()); });
    await flush();
    expect(seen[0]).toEqual({ token: "boot-token", initialVideoId: film, pageSlug: slug });
  });

  it("after an ordinary reload (the fragment already scrubbed) still hands GuestApp the Delivery page, with no token (#882)", async () => {
    const slug = "14-harbour-st-mosman-d234xz";
    window.history.replaceState(null, "", `/d/review?link=${LINK}#t=boot-token&p=${slug}`);
    const seen: unknown[] = [];
    const importer = vi.fn(() => Promise.resolve({ GuestApp: (props: unknown) => { seen.push(props); return null; } }));
    host = document.createElement("div"); document.body.appendChild(host);
    await act(async () => { mountGuest(host!, importer as never, vi.fn()); });
    await flush();
    host.remove();
    // The reload: the same scrubbed address, a fresh boot.
    host = document.createElement("div"); document.body.appendChild(host);
    await act(async () => { mountGuest(host!, importer as never, vi.fn()); });
    await flush();
    expect(seen.at(-1)).toEqual({ token: null, initialVideoId: null, pageSlug: slug });
  });
});
