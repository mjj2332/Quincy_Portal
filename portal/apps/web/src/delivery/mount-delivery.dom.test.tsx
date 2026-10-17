import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountDelivery } from "./mount-delivery";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SLUG = "12-example-st-23456b";
let host: HTMLElement | null = null;
afterEach(() => { host?.remove(); host = null; document.head.querySelectorAll("meta[data-delivery]").forEach((meta) => meta.remove()); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); };
const open = () => { host = document.createElement("div"); document.body.appendChild(host); return host; };

describe("mountDelivery", () => {
  it("adds the noindex and no-referrer metas synchronously, before the chunk resolves", async () => {
    const importer = vi.fn(() => new Promise<never>(() => undefined));
    await act(async () => { mountDelivery(open(), importer, `/d/${SLUG}`); });
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate a meta that is already there", async () => {
    const importer = vi.fn(() => new Promise<never>(() => undefined));
    await act(async () => { mountDelivery(open(), importer, `/d/${SLUG}`); mountDelivery(open(), importer, `/d/${SLUG}`); });
    expect(document.head.querySelectorAll('meta[name="robots"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[name="referrer"]')).toHaveLength(1);
  });

  it("renders the lazy app with the slug from the path", async () => {
    const App = ({ slug }: { slug: string }) => <p data-testid="app">{slug}</p>;
    await act(async () => { mountDelivery(open(), () => Promise.resolve({ DeliveryApp: App }), `/d/${SLUG}`); });
    await flush();
    expect(host!.querySelector('[data-testid="app"]')?.textContent).toBe(SLUG);
  });

  it("hands the app the film a review's Back returns to, read from the fragment, and nothing for any other fragment", async () => {
    const App = ({ returnToVideo }: { slug: string; returnToVideo?: string | null }) => <p data-testid="app">{String(returnToVideo)}</p>;
    const film = "bbbbbbbb-bbbb-4bbb-8bbb-000000000003";
    await act(async () => { mountDelivery(open(), () => Promise.resolve({ DeliveryApp: App }), `/d/${SLUG}`, undefined, `#v=${film}`); });
    await flush();
    expect(host!.querySelector('[data-testid="app"]')?.textContent).toBe(film);
    host!.remove();
    await act(async () => { mountDelivery(open(), () => Promise.resolve({ DeliveryApp: App }), `/d/${SLUG}`, undefined, "#v=not-a-film"); });
    await flush();
    expect(host!.querySelector('[data-testid="app"]')?.textContent).toBe("null");
  });

  it("shows the load failure when the chunk cannot load, and Reload is a full reload (no in-place retry)", async () => {
    const importer = vi.fn(() => Promise.reject(new Error("chunk gone")));
    const reload = vi.fn();
    await act(async () => { mountDelivery(open(), importer, `/d/${SLUG}`, reload); });
    await flush();
    expect(host!.querySelector('[data-testid="guest-load-failure"]')).not.toBeNull();
    await act(async () => { host!.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("renders nothing and requests no chunk for a path that is not a page address", async () => {
    const importer = vi.fn();
    await act(async () => { mountDelivery(open(), importer, `/d/${SLUG}/`); });
    expect(importer).not.toHaveBeenCalled();
    expect(host!.innerHTML).toBe("");
  });
});
