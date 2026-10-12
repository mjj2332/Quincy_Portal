import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryZipManifest } from "@quincy/shared";
import { allByTestId, byTestId, click, flush, json, render, SLUG, type Mounted } from "../testing/delivery-fixtures";
import { createDeliveryApi } from "./delivery-api";
import { DeliveryDownloadAll } from "./DeliveryDownloadAll";

const BASE = `/d/api/pages/${SLUG}`;
type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let route: (url: string, method: string) => Response | Promise<Response>;
let mounted: Mounted | null = null;
let gone: ReturnType<typeof vi.fn<() => void>>;
const manifest = (over: Partial<DeliveryZipManifest> = {}): DeliveryZipManifest => ({ size: "web", setNumber: 1, photos: 12, totalBytes: 24 * 1024 ** 2, tooLarge: false, leftOut: [], archive: { state: "ready", pending: 0 }, ...over });
let answers: Partial<Record<"web" | "full", () => Response | Promise<Response>>>;
beforeEach(() => {
  vi.useRealTimers();
  calls = []; gone = vi.fn<() => void>(); answers = {};
  route = (url, method) => {
    const size = url.includes("/zips/full") ? "full" : "web";
    if (method === "POST") return json({ state: "preparing", pending: 2, retryAfterSeconds: 30 });
    return answers[size]?.() ?? json(manifest({ size }));
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, method: init?.method ?? "GET", body: init?.body }); return route(url, init?.method ?? "GET"); }));
});
afterEach(async () => { await mounted?.unmount(); mounted = null; vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ""; });
const show = async () => { mounted = await render(<DeliveryDownloadAll api={createDeliveryApi(SLUG)} onGone={gone} />); };
const openIt = async () => { await click(byTestId("delivery-download-all")); await flush(); };
const reads = (size?: string) => calls.filter((c) => c.method === "GET" && c.url.includes("/zips/") && (size === undefined || c.url === `${BASE}/zips/${size}`));
const posts = () => calls.filter((c) => c.method === "POST");
const status = () => byTestId("delivery-zip-status");
const link = () => byTestId("delivery-zip-start");
const pick = async (size: "web" | "full") => { await click(byTestId(`delivery-zip-size-${size}`)); await flush(); };

describe("opening", () => {
  it("renders only the button and fetches nothing until it is pressed", async () => {
    await show();
    expect(byTestId("delivery-download-all")!.textContent).toBe("Download all");
    expect(calls).toEqual([]);
    expect(byTestId("delivery-download-all-dialog")).toBeNull();
  });
  it("opens with Web-size selected, reads that manifest, shows the summary and a ready download anchor to the zip route", async () => {
    await show(); await openIt();
    const dialog = byTestId("delivery-download-all-dialog")!;
    expect(dialog.textContent).toContain("Download all photos");
    expect(reads().map((c) => c.url)).toEqual([`${BASE}/zips/web`]);
    expect(byTestId("delivery-zip-summary")!.textContent).toBe("In the zip: 12 photos · 24 MB");
    expect(byTestId("delivery-zip-size-web")!.getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain("Smaller JPEGs for websites and social media");
    expect(dialog.textContent).toContain("Original files for print");
    const a = link()!;
    expect(a.tagName).toBe("A"); expect(a.getAttribute("href")).toBe(`${BASE}/zips/web/photos.zip`); expect(a.hasAttribute("download")).toBe(true);
    expect(a.textContent).toBe("Download zip");
    expect(posts()).toEqual([]);
  });
  it("lists the locked photos left out by public label under Not included", async () => {
    answers.web = () => json(manifest({ leftOut: [{ label: "Photo 02", reason: "premium_locked" }, { label: "Photo 05", reason: "premium_locked" }] }));
    await show(); await openIt();
    const dialog = byTestId("delivery-download-all-dialog")!;
    expect(dialog.textContent).toContain("Not included");
    expect(allByTestId("delivery-zip-leftout-item").map((i) => i.textContent)).toEqual([expect.stringContaining("Photo 02"), expect.stringContaining("Photo 05")]);
  });
  it("Close closes the dialog and a late manifest after Close changes nothing", async () => {
    let release!: (r: Response) => void;
    answers.web = () => new Promise<Response>((resolve) => { release = resolve; });
    await show(); await openIt();
    await click(byTestId("delivery-zip-close")); await flush();
    expect(byTestId("delivery-download-all-dialog")).toBeNull();
    await act(async () => { release(json(manifest())); }); await flush();
    expect(byTestId("delivery-download-all-dialog")).toBeNull();
    expect(gone).not.toHaveBeenCalled();
  });
});

describe("size", () => {
  it("switching size reads the other manifest and points the anchor at it", async () => {
    answers.full = () => json(manifest({ size: "full", photos: 12, totalBytes: 3 * 1024 ** 3 }));
    await show(); await openIt(); await pick("full");
    expect(reads().map((c) => c.url)).toEqual([`${BASE}/zips/web`, `${BASE}/zips/full`]);
    expect(byTestId("delivery-zip-summary")!.textContent).toBe("In the zip: 12 photos · 3 GB");
    expect(link()!.getAttribute("href")).toBe(`${BASE}/zips/full/photos.zip`);
  });
  it("a late answer for the size left is ignored", async () => {
    let releaseWeb!: (r: Response) => void;
    answers.web = () => new Promise<Response>((resolve) => { releaseWeb = resolve; });
    answers.full = () => json(manifest({ size: "full", photos: 7, totalBytes: 1024 ** 3 }));
    await show(); await openIt(); await pick("full");
    await act(async () => { releaseWeb(json(manifest({ photos: 99 }))); }); await flush();
    expect(byTestId("delivery-zip-summary")!.textContent).toBe("In the zip: 7 photos · 1 GB");
    expect(link()!.getAttribute("href")).toBe(`${BASE}/zips/full/photos.zip`);
  });
  it("reopening starts again from Web-size with a fresh read", async () => {
    await show(); await openIt(); await pick("full");
    await click(byTestId("delivery-zip-close")); await flush();
    await openIt();
    expect(byTestId("delivery-zip-size-web")!.getAttribute("aria-checked")).toBe("true");
    expect(reads().at(-1)!.url).toBe(`${BASE}/zips/web`);
  });
});

describe("preparing", () => {
  beforeEach(() => { answers.web = () => json(manifest({ archive: { state: "preparing", pending: 2 } })); });
  it("asks once to prepare, says so, offers no anchor, and never downloads by itself", async () => {
    await show(); await openIt();
    expect(posts()).toHaveLength(1); expect(posts()[0]!.url).toBe(`${BASE}/zips/web/prepare`); expect(posts()[0]!.body).toBe("{}");
    expect(status()!.textContent).toContain("Preparing this download. This may take a few minutes.");
    expect(link()).toBeNull();
    const pending = byTestId("delivery-zip-start-pending") as HTMLButtonElement;
    expect(pending.disabled).toBe(true); expect(pending.getAttribute("href")).toBeNull(); expect(pending.textContent).toBe("Download zip");
  });
  it("polls the manifest and offers the anchor once ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await show();
    await act(async () => { byTestId("delivery-download-all")!.click(); await vi.advanceTimersByTimeAsync(10); });
    expect(status()!.textContent).toContain("Preparing");
    answers.web = () => json(manifest());
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(status()!.textContent).toContain("Your zip is ready");
    expect(link()!.getAttribute("href")).toBe(`${BASE}/zips/web/photos.zip`);
    expect(byTestId("delivery-zip-start-pending")).toBeNull();
    expect(posts()).toHaveLength(1);
  });
  it("after five minutes it says still preparing and Check again prepares once more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await show();
    await act(async () => { byTestId("delivery-download-all")!.click(); await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000); });
    expect(status()!.textContent).toContain("Still preparing. Check again in a minute.");
    expect(link()).toBeNull();
    await act(async () => { byTestId("delivery-zip-check-again")!.click(); await vi.advanceTimersByTimeAsync(10); });
    expect(posts()).toHaveLength(2);
  });
  it("a manifest 429 while polling shows the cooldown and suspends polling until Retry-After passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await show();
    await act(async () => { byTestId("delivery-download-all")!.click(); await vi.advanceTimersByTimeAsync(10); });
    const before = reads().length;
    answers.web = () => json({ error: "too_many_attempts" }, 429, { "retry-after": "90" });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(reads()).toHaveLength(before + 1);
    expect(status()!.textContent).toContain("Too many requests. Try again in 90 seconds.");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads()).toHaveLength(before + 1);
    answers.web = () => json(manifest());
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(reads()).toHaveLength(before + 2);
    expect(status()!.textContent).toContain("Your zip is ready");
  });
  it("closing stops the polling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await show();
    await act(async () => { byTestId("delivery-download-all")!.click(); await vi.advanceTimersByTimeAsync(10); });
    const before = reads().length;
    await act(async () => { byTestId("delivery-zip-close")!.click(); await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(reads()).toHaveLength(before);
  });
  it("a prepare answer that arrives after switching size changes nothing for the new size", async () => {
    let releasePrepare!: (r: Response) => void;
    route = (url, method) => method === "POST" ? new Promise<Response>((resolve) => { releasePrepare = resolve; }) : (url.includes("/full") ? json(manifest({ size: "full" })) : json(manifest({ archive: { state: "preparing", pending: 2 } })));
    await show(); await openIt(); await pick("full");
    await act(async () => { releasePrepare(json({ state: "unavailable", pending: 0 })); }); await flush();
    expect(byTestId("delivery-zip-problem")).toBeNull();
    expect(link()!.getAttribute("href")).toBe(`${BASE}/zips/full/photos.zip`);
  });
});

describe("refusals", () => {
  it("a manifest over the caps shows the limit and no anchor", async () => {
    answers.web = () => json(manifest({ tooLarge: true, photos: 301 }));
    await show(); await openIt();
    expect(byTestId("delivery-zip-problem")!.textContent).toContain("300 photos");
    expect(link()).toBeNull();
  });
  it("an archive the server says is too large or unavailable has no anchor", async () => {
    answers.web = () => json(manifest({ archive: { state: "too_large", pending: 0 } }));
    await show(); await openIt();
    expect(byTestId("delivery-zip-problem")).not.toBeNull(); expect(link()).toBeNull();
  });
  it("a manifest 429 shows cooldown copy, and Try again reads again", async () => {
    answers.web = () => json({ error: "too_many_attempts" }, 429, { "retry-after": "20" });
    await show(); await openIt();
    expect(byTestId("delivery-zip-problem")!.textContent).toContain("Too many requests. Try again in 20 seconds.");
    expect(link()).toBeNull();
    answers.web = () => json(manifest());
    await click(byTestId("delivery-zip-retry")); await flush();
    expect(link()).not.toBeNull();
  });
  it("a 429 on prepare shows cooldown copy", async () => {
    answers.web = () => json(manifest({ archive: { state: "preparing", pending: 2 } }));
    route = (url, method) => method === "POST" ? json({ error: "too_many_attempts" }, 429, { "retry-after": "45" }) : answers.web!();
    await show(); await openIt();
    expect(byTestId("delivery-zip-problem")!.textContent).toContain("Try again in 45 seconds");
    expect(link()).toBeNull();
  });
  it("a 404 means the page is gone: the dialog closes and onGone runs", async () => {
    answers.web = () => new Response("Not found", { status: 404 });
    await show(); await openIt();
    expect(gone).toHaveBeenCalledTimes(1);
    expect(byTestId("delivery-download-all-dialog")).toBeNull();
  });
  it("a dropped connection offers Try again", async () => {
    answers.web = () => new Response("", { status: 503 });
    await show(); await openIt();
    expect(byTestId("delivery-zip-problem")!.textContent).toContain("Couldn't check");
    expect(byTestId("delivery-zip-retry")).not.toBeNull(); expect(link()).toBeNull();
  });
  it("a set with no photos has nothing to download and no anchor", async () => {
    answers.web = () => json(manifest({ photos: 0, totalBytes: 0 }));
    await show(); await openIt();
    expect(byTestId("delivery-zip-problem")!.textContent).toContain("no photos");
    expect(link()).toBeNull();
  });
});
