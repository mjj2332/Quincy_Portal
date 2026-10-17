import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPageDto } from "@quincy/shared";
import { BASE, byLabel, byTestId, click, downloadUrl, film, flush, handle, json, locked, mediaUrl, page, pdf, photo, render, SLUG, tab, tabNames, unlockUrl, until, type Mounted } from "../testing/delivery-fixtures";
import { DeliveryApp } from "./DeliveryApp";

vi.mock("../components/LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
vi.mock("embla-carousel-react", async () => (await import("../testing/delivery-fixtures")).fakeEmblaModule());

type Call = { url: string; init: RequestInit | undefined };
let calls: Call[];
let route: (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let mounted: Mounted | null = null;
const dto = (): DeliveryPageDto => page([photo(1), locked(2), film(3), pdf(4, "floorplan")], { coverHandle: handle(1) });
beforeEach(() => {
  calls = []; route = () => json(dto());
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return route(url, init); }));
});
afterEach(async () => { await mounted?.unmount(); mounted = null; vi.unstubAllGlobals(); vi.useRealTimers(); document.title = ""; document.body.innerHTML = ""; });
const open = async () => { mounted = await render(<DeliveryApp slug={SLUG} />); await flush(); return mounted; };
const text = () => document.body.textContent ?? "";
const reads = () => calls.filter((call) => call.url === BASE);

describe("fetch states", () => {
  it("shows a skeleton while the page loads, then the page, and reads only the page address with no credentials", async () => {
    let release!: (response: Response) => void;
    route = () => new Promise<Response>((resolve) => { release = resolve; });
    mounted = await render(<DeliveryApp slug={SLUG} />);
    expect(byTestId("delivery-loading")!.getAttribute("aria-busy")).toBe("true");
    expect(byTestId("delivery-loading")!.children.length).toBeGreaterThan(2);
    await act(async () => { release(json(dto())); }); await flush();
    expect(byTestId("delivery-loading")).toBeNull();
    expect(byTestId("delivery-page")).not.toBeNull();
    expect(calls.map((call) => call.url)).toEqual([BASE]);
    expect(calls[0]!.init).toMatchObject({ credentials: "omit" });
  });
  it("sets the document title to the street and keeps nothing in storage", async () => {
    const before = [localStorage.length, sessionStorage.length];
    await open();
    expect(document.title).toBe("12 Example St");
    expect([localStorage.length, sessionStorage.length]).toEqual(before);
    expect(document.cookie).toBe("");
  });
  it.each([404, 403, 400])("shows one 'This page isn't available.' for a %s, with nothing else", async (status) => {
    route = () => new Response("Not found", { status });
    await open();
    expect(byTestId("delivery-gone")!.textContent).toBe("This page isn't available.");
    expect(byTestId("delivery-page")).toBeNull();
    const credit = byTestId("delivery-gone-credit")!;
    expect(credit.textContent).toBe("Quincy Productions · info@quincyproductions.com.au");
    expect(credit.querySelector("a")!.getAttribute("href")).toBe("mailto:info@quincyproductions.com.au");
  });
  it("offers a retry for a 5xx or a dropped connection, and the retry reads again", async () => {
    route = () => new Response("", { status: 503 });
    await open();
    expect(byTestId("guest-unreachable")).not.toBeNull();
    route = () => json(dto());
    await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Try again")); await flush();
    expect(byTestId("delivery-page")).not.toBeNull();
    expect(reads()).toHaveLength(2);
  });
  it("counts the Retry-After seconds down on a 429 and then offers Try again", async () => {
    vi.useFakeTimers();
    route = () => json({ error: "too_many_attempts" }, 429, { "retry-after": "3" });
    mounted = await render(<DeliveryApp slug={SLUG} />); await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const retry = () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Try again") as HTMLButtonElement;
    expect(byTestId("delivery-limited")!.textContent).toContain("Try again in 3 seconds.");
    expect(retry().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(byTestId("delivery-limited")!.textContent).toContain("You can try again now.");
    expect(retry().disabled).toBe(false);
    route = () => json(dto());
    await click(retry()); await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(byTestId("delivery-page")).not.toBeNull();
  });
  it("says the page was updated, with a reload, when the body is not the current shape", async () => {
    route = () => json({ ...dto(), items: [{ ...photo(1), premium: undefined }] });
    await open();
    expect(byTestId("delivery-outdated")!.textContent).toContain("This page was updated.");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Reload")).toBe(true);
  });
  it("ignores a response that arrives after the page has gone, and one that was overtaken by a newer read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let first!: (response: Response) => void;
    route = () => new Promise<Response>((resolve) => { first = resolve; });
    const view = await render(<DeliveryApp slug={SLUG} />);
    await view.unmount(); mounted = null;
    await act(async () => { first(json(dto())); }); await flush();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
  it("lets the newest read win when an older one lands last", async () => {
    const resolvers: ((response: Response) => void)[] = [];
    route = (_url) => new Promise<Response>((resolve) => { resolvers.push(resolve); });
    // The first read fails, the person retries, and the retry answers before the first one's late reply is read.
    mounted = await render(<DeliveryApp slug={SLUG} />);
    await act(async () => { resolvers[0]!(new Response("", { status: 503 })); }); await flush();
    await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Try again")); await flush();
    await act(async () => { resolvers[1]!(json(dto())); }); await flush();
    expect(byTestId("delivery-page")).not.toBeNull();
  });
  it("aborts the read of a page it leaves", async () => {
    route = () => new Promise<Response>(() => undefined);
    await open();
    const signal = calls[0]!.init!.signal!;
    expect(signal.aborted).toBe(false);
    await mounted!.unmount(); mounted = null;
    expect(signal.aborted).toBe(true);
  });
});

describe("share", () => {
  it("shares the page's own absolute address, on the current origin, with no query or hash", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open();
    await click(byTestId("delivery-share")); await flush();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/d/${SLUG}`);
    Reflect.deleteProperty(navigator, "clipboard");
  });
});

describe("downloads", () => {
  it("links one Download, to the original, on an unlocked photo", async () => {
    await open();
    const tile = document.querySelector(`[data-handle="${handle(1)}"]`)!;
    const links = [...tile.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([downloadUrl(1)]);
    expect(links.every((a) => a.hasAttribute("download"))).toBe(true);
  });
  it("never links a download for the locked item, and keeps Download all in the hero, not the Premium panel", async () => {
    await open();
    await click(tab("Premium"));
    const lockedTile = document.querySelector(`[data-handle="${handle(2)}"]`)!;
    expect(lockedTile.querySelectorAll("a")).toHaveLength(0);
    expect(document.querySelector('[data-testid="delivery-panel-premium"]')!.textContent).not.toMatch(/download all/i);
    expect(document.querySelector('[data-testid="delivery-hero"]')!.textContent).toMatch(/download all/i);
    expect(calls.map((call) => call.url)).toEqual([BASE]);
  });
});

describe("request unlock", () => {
  const request = async () => { await click(tab("Premium")); await click(byLabel("Request unlock: Photo 02")); await flush(); };
  const status = () => byTestId("delivery-unlock-status")!.textContent;
  const posts = () => calls.filter((call) => call.init?.method === "POST");

  it("POSTs `{}` to the item's unlock-request URL with no credentials, disables the button while sending, and then says it was requested", async () => {
    let answer!: (response: Response) => void;
    route = (url, init) => init?.method === "POST" ? new Promise<Response>((resolve) => { answer = resolve; }) : json(dto());
    await open();
    await click(tab("Premium")); await click(byLabel("Request unlock: Photo 02"));
    expect((byLabel("Request unlock: Photo 02") as HTMLButtonElement).disabled).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ url: unlockUrl(2), init: { method: "POST", body: "{}", credentials: "omit" } });
    await act(async () => { answer(json({ status: "requested" }, 202)); }); await flush();
    expect(status()).toBe("Requested. The studio will be in touch.");
    expect(byLabel("Request unlock: Photo 02")).toBeNull();
  });
  it("says the same for already_requested, and the state survives a tab change and the viewer", async () => {
    route = (url, init) => init?.method === "POST" ? json({ status: "already_requested" }, 202) : json(dto());
    await open(); await request();
    expect(status()).toBe("Requested. The studio will be in touch.");
    await click(tab("Gallery")); await click(tab("Premium"));
    expect(status()).toBe("Requested. The studio will be in touch.");
    await click(byLabel("Open Photo 02")); await until(() => byTestId("delivery-lightbox"));
    expect(byTestId("delivery-lightbox")!.textContent).toContain("Requested. The studio will be in touch.");
    expect(posts()).toHaveLength(1);
  });
  it("does not send twice while one is in flight", async () => {
    route = (url, init) => init?.method === "POST" ? new Promise<Response>(() => undefined) : json(dto());
    await open(); await request();
    await click(byLabel("Request unlock: Photo 02"));
    expect(posts()).toHaveLength(1);
  });
  it("re-reads the page on 409 not_locked and shows the item unlocked, with downloads", async () => {
    let unlocked = false;
    route = (url, init) => {
      if (init?.method === "POST") { unlocked = true; return json({ error: "not_locked" }, 409); }
      return json(unlocked ? page([photo(1), photo(2, { premium: true }), film(3), pdf(4, "floorplan")], { coverHandle: handle(1) }) : dto());
    };
    await open(); await request();
    expect(reads()).toHaveLength(2);
    expect(tabNames()).toContain("Premium");
    expect(byLabel("Request unlock: Photo 02")).toBeNull();
    const tile = document.querySelector(`[data-handle="${handle(2)}"]`)!;
    expect([...tile.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([downloadUrl(2)]);
    expect(byTestId("delivery-page")).not.toBeNull();
  });
  it("counts a 429 down from Retry-After and lets the person try again at zero", async () => {
    vi.useFakeTimers();
    route = (url, init) => init?.method === "POST" ? json({ error: "too_many_attempts", retryAfterSeconds: 4 }, 429, { "retry-after": "4" }) : json(dto());
    mounted = await render(<DeliveryApp slug={SLUG} />); await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await click(tab("Premium")); await click(byLabel("Request unlock: Photo 02")); await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(status()).toBe("Too many requests. Try again in 4 seconds.");
    expect((byLabel("Request unlock: Photo 02") as HTMLButtonElement).disabled).toBe(true);
    await click(tab("Gallery")); await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); await click(tab("Premium"));
    expect(status()).toBe("Too many requests. Try again in 2 seconds."); // the wait is a deadline, not a fresh count on remount
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect((byLabel("Request unlock: Photo 02") as HTMLButtonElement).disabled).toBe(false);
    route = (url, init) => init?.method === "POST" ? json({ status: "requested" }, 202) : json(dto());
    await click(byLabel("Request unlock: Photo 02")); await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(status()).toBe("Requested. The studio will be in touch.");
  });
  it("shows the gone page on a 404", async () => {
    route = (url, init) => init?.method === "POST" ? new Response("Not found", { status: 404 }) : json(dto());
    await open(); await request();
    expect(byTestId("delivery-gone")).not.toBeNull();
  });
  it("stays gone when a 404 on one item overtakes the page re-read another item's 409 started", async () => {
    let answerRead!: (response: Response) => void; let reads = 0;
    const two = () => page([photo(1), locked(2), locked(3)], { coverHandle: handle(1) });
    route = (url, init) => {
      if (init?.method === "POST") return url === unlockUrl(2) ? json({ error: "not_locked" }, 409) : new Response("Not found", { status: 404 });
      reads += 1; return reads === 1 ? json(two()) : new Promise<Response>((resolve) => { answerRead = resolve; });
    };
    await open(); await click(tab("Premium"));
    await click(byLabel("Request unlock: Photo 02")); await flush(); // 409: a quiet re-read is now out
    expect(reads).toBe(2);
    await click(byLabel("Request unlock: Photo 03")); await flush(); // 404: the page is gone
    expect(byTestId("delivery-gone")).not.toBeNull();
    await act(async () => { answerRead(json(two())); }); await flush();
    expect(byTestId("delivery-gone")).not.toBeNull();
    expect(byTestId("delivery-page")).toBeNull();
  });
  it("ignores an unlock answer that was started before the page went gone", async () => {
    let answerFirst!: (response: Response) => void;
    const two = () => page([photo(1), locked(2), locked(3)], { coverHandle: handle(1) });
    route = (url, init) => {
      if (init?.method !== "POST") return json(two());
      return url === unlockUrl(2) ? new Promise<Response>((resolve) => { answerFirst = resolve; }) : new Response("Not found", { status: 404 });
    };
    await open(); await click(tab("Premium"));
    await click(byLabel("Request unlock: Photo 02"));
    await click(byLabel("Request unlock: Photo 03")); await flush();
    expect(byTestId("delivery-gone")).not.toBeNull();
    await act(async () => { answerFirst(json({ error: "not_locked" }, 409)); }); await flush();
    expect(byTestId("delivery-gone")).not.toBeNull();
    expect(reads()).toHaveLength(1); // the stale 409 did not start another read
  });
  it("stays gone when the re-read after one 409 answers 404 and another 409 lands later, even if every later read would fail", async () => {
    let answerSecond!: (response: Response) => void; let reads = 0;
    const two = () => page([photo(1), locked(2), locked(3)], { coverHandle: handle(1) });
    route = (url, init) => {
      if (init?.method === "POST") return url === unlockUrl(2) ? json({ error: "not_locked" }, 409) : new Promise<Response>((resolve) => { answerSecond = resolve; });
      reads += 1;
      if (reads === 1) return json(two());
      if (reads === 2) return new Response("Not found", { status: 404 }); // the page was switched off: the re-read after the first 409 finds it gone
      throw new TypeError("offline"); // any later read would show Unreachable
    };
    await open(); await click(tab("Premium"));
    await click(byLabel("Request unlock: Photo 03")); // pending
    await click(byLabel("Request unlock: Photo 02")); await flush(); // 409, then its re-read is a 404
    expect(byTestId("delivery-gone")).not.toBeNull();
    const before = reads;
    await act(async () => { answerSecond(json({ error: "not_locked" }, 409)); }); await flush();
    expect(reads).toBe(before); // the stale 409 started no read
    expect(byTestId("delivery-gone")).not.toBeNull();
    expect(text()).not.toMatch(/reach|offline|try again/i);
  });
  it.each(["network", "500"])("says it couldn't send, and lets the person try again, on a %s failure", async (kind) => {
    route = (url, init) => { if (init?.method !== "POST") return json(dto()); if (kind === "network") throw new TypeError("offline"); return new Response("", { status: 500 }); };
    await open(); await request();
    expect(status()).toBe("Couldn't send. Try again.");
    expect((byLabel("Request unlock: Photo 02") as HTMLButtonElement).disabled).toBe(false);
  });
  it("a locked film is requested from its tile: a failure is retried from the same tile, which then reads as requested (#882, V3)", async () => {
    const films = () => page([photo(1), locked(5, { kind: "video", label: "Video 05", url: null, thumbUrl: null })], { coverHandle: handle(1) });
    let fail = true;
    route = (url, init) => { if (init?.method !== "POST") return json(films()); return fail ? new Response("", { status: 500 }) : json({ status: "requested" }, 202); };
    await open(); await click(tab("Premium"));
    const tile = () => document.querySelector<HTMLElement>(`[data-testid="delivery-film-item"][data-handle="${handle(5)}"]`)!;
    const control = () => tile().querySelector<HTMLElement>('[data-testid="delivery-film-open"]')!;
    const tileStatus = () => tile().querySelector('[data-testid="delivery-unlock-status"]')!.textContent;
    await click(control()); await flush();
    expect(tileStatus()).toBe("Couldn't send. Try again."); expect(control().getAttribute("aria-label")).toBe("Request unlock: Video 05");
    fail = false;
    await click(control()); await flush();
    expect(posts().map((call) => call.url)).toEqual([unlockUrl(5), unlockUrl(5)]);
    expect(tileStatus()).toBe("Requested. The studio will be in touch.");
    expect(control().getAttribute("aria-label")).toBe("Unlock requested: Video 05"); expect(control().getAttribute("aria-disabled")).toBe("true");
    await click(control()); await flush();
    expect(posts()).toHaveLength(2);
  });
});

describe("download all slot (#787 slice 7)", () => {
  const zipCalls = () => calls.filter((call) => call.url.includes("/zips/"));
  it("offers Download all when the set has an unlocked photo, and requests nothing until it is opened", async () => {
    await open();
    expect(byTestId("delivery-download-all")).not.toBeNull();
    expect(zipCalls()).toEqual([]);
  });
  it("offers no control when every photo is locked", async () => {
    route = () => json(page([locked(1), locked(2), film(3)]));
    await open();
    expect(byTestId("delivery-download-all")).toBeNull();
  });
  it("offers no control when the page has no photos at all", async () => {
    route = () => json(page([film(1), pdf(2, "floorplan")]));
    await open();
    expect(byTestId("delivery-download-all")).toBeNull();
  });
  it("shows the page-gone screen when a zip read answers 404", async () => {
    route = (url) => (url.includes("/zips/") ? new Response("Not found", { status: 404 }) : json(dto()));
    await open(); await click(byTestId("delivery-download-all")); await flush();
    expect(byTestId("delivery-gone")).not.toBeNull();
    expect(byTestId("delivery-page")).toBeNull();
  });
});

