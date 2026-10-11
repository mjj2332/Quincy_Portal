import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPageDto } from "@quincy/shared";
import { allByTestId, byLabel, byTestId, click, embla, fakeEmblaModule, film, flush, handle, locked, page, pdf, photo, press, render, tab, tabNames, until, type Mounted } from "../testing/delivery-fixtures";
import type { DeliveryHrefs, UnlockStates } from "./delivery-model";
import { DeliveryPage } from "./DeliveryPage";
import { SLIDE_MS } from "./DeliveryLightbox";
import { createDeliveryApi } from "./delivery-api";

vi.mock("../components/LazyImage", () => ({
  LazyImage: ({ src, alt, className, onFailedChange }: { src: string; alt: string; className?: string; onFailedChange?: (failed: boolean) => void }) => <img src={src} alt={alt} className={className} onError={() => { onFailedChange?.(true); }} />,
}));
vi.mock("embla-carousel-react", async () => (await import("../testing/delivery-fixtures")).fakeEmblaModule());

const hrefs: DeliveryHrefs = createDeliveryApi("12-example-st-23456b").hrefs;
let mounted: Mounted | null = null;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(async () => new Response("", { status: 500 })); vi.stubGlobal("fetch", fetchMock); });
afterEach(async () => { await mounted?.unmount(); mounted = null; vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ""; });

type Props = Partial<React.ComponentProps<typeof DeliveryPage>>;
const show = async (dto: DeliveryPageDto, props: Props = {}) => { mounted = await render(<DeliveryPage dto={dto} hrefs={hrefs} onRequestUnlock={() => undefined} unlockState={{}} {...props} />); return mounted; };
/** Re-renders the same tree with a new DTO, keeping state, as a refetch does. */
function Harness({ initial, after, unlockState = {} }: { initial: DeliveryPageDto; after: DeliveryPageDto; unlockState?: UnlockStates }) {
  const [dto, setDto] = useState(initial);
  return <><DeliveryPage dto={dto} hrefs={hrefs} onRequestUnlock={() => undefined} unlockState={unlockState} /><button type="button" data-testid="swap" onClick={() => { setDto(after); }}>swap</button></>;
}

describe("tabs", () => {
  it("orders Photos, Film, Floorplan, Description, hides empty tabs and keeps published order", async () => {
    await show(page([pdf(1, "copy"), photo(2), film(3), pdf(4, "floorplan"), photo(5)]));
    expect(tabNames()).toEqual(["Photos", "Film", "Floorplan", "Description"]);
    expect(allByTestId("delivery-tile").map((tile) => tile.dataset.handle)).toEqual([handle(2), handle(5)]);
  });
  it("hides every tab that has nothing in it and shows a calm empty state for an empty page", async () => {
    await show(page([photo(1)]));
    expect(tabNames()).toEqual(["Photos"]);
    await mounted!.unmount();
    await show(page([]));
    expect(tabNames()).toEqual([]);
    expect(byTestId("delivery-empty")).not.toBeNull();
  });
  it("adds Premium only when something is a paid extra, and keeps it, with the item, after an unlock", async () => {
    mounted = await render(<Harness initial={page([photo(1), locked(2)])} after={page([photo(1), photo(2, { premium: true, locked: false })])} />);
    expect(tabNames()).toEqual(["Photos", "Premium"]);
    await click(tab("Premium"));
    expect(allByTestId("delivery-tile").map((tile) => tile.dataset.handle)).toEqual([handle(2)]);
    expect(byTestId("delivery-premium-badge")).not.toBeNull();
    await click(byTestId("swap"));
    expect(tabNames()).toEqual(["Photos", "Premium"]);
    expect(byTestId("delivery-panel-premium")).not.toBeNull();
    expect(allByTestId("delivery-tile").map((tile) => tile.dataset.handle)).toEqual([handle(2)]);
    expect(byTestId("delivery-premium-badge")).toBeNull();
    expect(byTestId("delivery-panel-premium")!.querySelectorAll("a[download]")).toHaveLength(2);
  });
  it("keeps the chosen tab in memory while the page re-renders and falls back to the first tab when it disappears", async () => {
    mounted = await render(<Harness initial={page([photo(1), film(2)])} after={page([photo(1)])} />);
    await click(tab("Film"));
    expect(byTestId("delivery-panel-film")).not.toBeNull();
    await click(byTestId("swap"));
    expect(tabNames()).toEqual(["Photos"]);
    expect(byTestId("delivery-panel-photos")).not.toBeNull();
  });
  it("labels the tab list and its panels", async () => {
    await show(page([photo(1), film(2)]));
    expect(document.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Delivery sections");
    expect(byTestId("delivery-panel-photos")?.getAttribute("role")).toBe("tabpanel");
  });
});

describe("hero", () => {
  it("is the cover photo at web size, with a thumb srcset, high fetch priority and the street as the one h1", async () => {
    await show(page([photo(1), photo(2)], { coverHandle: handle(2) }));
    const img = byTestId("delivery-hero")!.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(photo(2).url);
    expect(img.getAttribute("srcset")).toBe(`${photo(2).thumbUrl} 640w, ${photo(2).url} 2048w`);
    expect(img.getAttribute("fetchpriority")).toBe("high");
    expect(img.getAttribute("alt")).toBe("Photo 02");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("h1")!.textContent).toBe("12 Example St, Suburbia");
  });
  it("falls back to the first unlocked photo when the cover is locked, and to text only when there is no photo to show", async () => {
    await show(page([locked(1), photo(2), photo(3)], { coverHandle: handle(1) }));
    expect(byTestId("delivery-hero")!.querySelector("img")!.getAttribute("src")).toBe(photo(2).url);
    await mounted!.unmount();
    await show(page([locked(1), film(2)], { coverHandle: handle(1) }));
    expect(byTestId("delivery-hero")!.querySelector("img")).toBeNull();
    expect(document.querySelector("h1")!.textContent).toBe("12 Example St, Suburbia");
  });
  it("says when it was delivered, in the studio's time zone, and not at all for a Preview", async () => {
    await show(page([photo(1)]));
    expect(byTestId("delivery-hero")!.textContent).toContain("Delivered 11 October 2026");
    await mounted!.unmount();
    await show(page([photo(1)], { publishedAt: null }));
    expect(byTestId("delivery-hero")!.textContent).not.toContain("Delivered");
  });
  it("offers Ask the studio as a mailto with the street as the subject", async () => {
    await show(page([photo(1)]));
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent === "Ask the studio")!;
    expect(link.getAttribute("href")).toBe("mailto:info@quincyproductions.com.au?subject=12%20Example%20St");
  });
  it("shows a processing tile, not a broken image or the original, when the hero derivative is missing", async () => {
    await show(page([photo(1)]));
    await act(async () => { byTestId("delivery-hero")!.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(byTestId("delivery-hero")!.querySelector("img")).toBeNull();
    expect(byTestId("delivery-hero")!.querySelector('[data-testid="delivery-processing"]')).not.toBeNull();
  });
  it("prints the studio footer from the one constant", async () => {
    await show(page([photo(1)]));
    expect(byTestId("delivery-footer")!.textContent).toBe("Quincy Productions · info@quincyproductions.com.au");
  });
});

describe("photo grid", () => {
  it("is four columns, two at 721 px and under the container, and every box carries its photo's own ratio", async () => {
    await show(page([photo(1), photo(2, { width: 3000, height: 4000 }), photo(3, { width: null, height: null })]));
    const grid = byTestId("delivery-grid")!;
    expect(grid.className).toContain("grid-cols-4");
    expect(grid.className).toContain("@max-[721px]:grid-cols-2");
    const ratios = allByTestId("delivery-tile").map((tile) => (tile.firstElementChild as HTMLElement).style.aspectRatio);
    expect(ratios).toEqual(["6000 / 4000", "3000 / 4000", "3 / 2"]);
  });
  it("loads the thumbnail in the grid, with alt text from the label, and opens the viewer from the tile only", async () => {
    await show(page([photo(1)]));
    const img = allByTestId("delivery-tile")[0]!.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(photo(1).thumbUrl);
    expect(img.getAttribute("alt")).toBe("Photo 01");
    expect(byLabel("Open Photo 01")).not.toBeNull();
  });
  it("shows a processing tile when a thumbnail is missing", async () => {
    await show(page([photo(1)]));
    await act(async () => { allByTestId("delivery-tile")[0]!.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(allByTestId("delivery-tile")[0]!.querySelector("img")).toBeNull();
    expect(byTestId("delivery-processing")).not.toBeNull();
  });
  it("keeps the open button outside any overflow-hidden ancestor within its tile, so its focus outline is not clipped", async () => {
    await show(page([photo(1), locked(2)]));
    for (const name of ["Photos", "Premium"]) {
      await click(tab(name));
      for (const tile of allByTestId("delivery-tile")) {
        const open = tile.querySelector<HTMLElement>('[aria-label^="Open "]')!;
        for (let node: HTMLElement | null = open.parentElement; node && node !== tile; node = node.parentElement) expect(node.className, `${name}: ${node.className}`).not.toMatch(/overflow-(hidden|clip)/);
      }
    }
  });
  it("tries a tile's picture again once an unlock refetch changes the item, after a failure on the locked preview", async () => {
    mounted = await render(<Harness initial={page([locked(2)])} after={page([photo(2, { premium: true })])} />);
    await click(tab("Premium"));
    await act(async () => { allByTestId("delivery-tile")[0]!.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(allByTestId("delivery-tile")[0]!.querySelector("img")).toBeNull();
    await click(byTestId("swap"));
    expect(allByTestId("delivery-tile")[0]!.querySelector("img")?.getAttribute("src")).toBe(photo(2).thumbUrl);
  });
  it("keeps every control at 44 px on a phone or a touch screen", async () => {
    await show(page([photo(1)]));
    for (const control of [...document.querySelectorAll<HTMLElement>('[data-testid="delivery-tile"] a')]) expect(control.className).toContain("max-[721px]:min-h-11");
    for (const trigger of document.querySelectorAll<HTMLElement>('[role="tab"]')) expect(trigger.className).toContain("max-[721px]:min-h-11");
  });
});

describe("downloads", () => {
  it("offers Web-size (the media URL) and Full-res (the download URL) as same-origin download anchors on an unlocked photo", async () => {
    await show(page([photo(1)]));
    const links = [...allByTestId("delivery-tile")[0]!.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.hasAttribute("download")])).toEqual([["Web-size", hrefs.media(handle(1))], ["Full-res", hrefs.download(handle(1))]].map(([text, href]) => [text, href, true]));
  });
  it("never links a download for a locked item, anywhere: grid, film, documents or the viewer", async () => {
    await show(page([locked(1), locked(2, { kind: "video", url: null, thumbUrl: null }), locked(3, { kind: "floorplan", url: null, thumbUrl: null }), locked(4, { kind: "copy", url: null, thumbUrl: null })]));
    await click(tab("Premium"));
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    expect([...document.querySelectorAll("a")].filter((a) => /\/(download|media)$/.test(a.getAttribute("href") ?? ""))).toHaveLength(0);
    await click(byLabel("Open Photo 01"));
    await flush();
    expect(byTestId("delivery-lightbox")).not.toBeNull();
    expect(byTestId("delivery-lightbox")!.querySelectorAll("a")).toHaveLength(0);
  });
  it("offers no download of any kind in Preview (hrefs null), but still shows the page", async () => {
    await show(page([photo(1), film(2), pdf(3, "floorplan"), pdf(4, "copy")]), { hrefs: null });
    for (const name of ["Photos", "Film", "Floorplan", "Description"]) { await click(tab(name)); expect(document.querySelectorAll("a[download]"), name).toHaveLength(0); }
    await click(tab("Floorplan"));
    expect(byLabel("View Floorplan 03")?.getAttribute("href")).toBe(pdf(3, "floorplan").url);
  });
});

describe("lightbox", () => {
  const open = async (items = [photo(1), photo(2), photo(3)], at = 1) => { await show(page(items)); await click(byLabel(`Open ${items[at]!.label}`)); await until(() => byTestId("delivery-lightbox")); };
  it("opens full-viewport on the inverse surface at the tapped photo, with a live counter, and names the dialog", async () => {
    await open();
    const box = byTestId("delivery-lightbox")!;
    expect(box.getAttribute("data-surface")).toBe("inverse");
    expect(box.getAttribute("role")).toBe("dialog");
    expect(box.getAttribute("aria-labelledby")).not.toBeNull();
    const counter = byTestId("delivery-lightbox-counter")!;
    expect(counter.textContent).toBe("Photo 2 of 3");
    expect(counter.getAttribute("aria-live")).toBe("polite");
    expect(embla.options).toMatchObject({ startIndex: 1 });
  });
  it("moves with ← and →, the buttons, and a swipe, and stops at either end", async () => {
    await open();
    const box = byTestId("delivery-lightbox")!;
    await press("ArrowRight", box);
    expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 3 of 3");
    expect(embla.api!.scrollTo).toHaveBeenLastCalledWith(2, false);
    await press("ArrowRight", box);
    expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 3 of 3");
    expect((byLabel("Next photo") as HTMLButtonElement).disabled).toBe(true);
    await press("ArrowLeft", box);
    await click(byLabel("Previous photo"));
    expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 1 of 3");
    expect((byLabel("Previous photo") as HTMLButtonElement).disabled).toBe(true);
    await embla.swipeTo(1);
    expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 2 of 3");
  });
  it("shows the web-size photo on screen and loads only its neighbours' <img>, with the label as alt", async () => {
    await open([photo(1), photo(2), photo(3), photo(4), photo(5)], 2);
    const imgs = [...byTestId("delivery-lightbox")!.querySelectorAll("img")];
    expect(imgs.map((img) => img.getAttribute("src"))).toEqual([photo(2).url, photo(3).url, photo(4).url]);
    expect(imgs[1]!.getAttribute("alt")).toBe("Photo 03");
  });
  it("preloads the photos either side of the one on screen", async () => {
    const created: string[] = [];
    class FakeImage { decoding = ""; set src(value: string) { created.push(value); } }
    vi.stubGlobal("Image", FakeImage);
    await open([photo(1), photo(2), photo(3), photo(4), photo(5)], 2);
    expect(created.sort()).toEqual([photo(1), photo(2), photo(4), photo(5)].map((p) => p.url).sort());
  });
  it("closes on Escape and returns focus to the tile that opened it", async () => {
    await show(page([photo(1), photo(2)]));
    const tile = byLabel("Open Photo 02") as HTMLButtonElement;
    tile.focus();
    await click(tile); await flush();
    expect(byTestId("delivery-lightbox")).not.toBeNull();
    await press("Escape", byTestId("delivery-lightbox")!); await flush(8);
    expect(byTestId("delivery-lightbox")).toBeNull();
    expect(document.activeElement).toBe(tile);
  });
  it("closes with the Close button", async () => {
    await open();
    await click(byLabel("Close")); await flush(8);
    expect(byTestId("delivery-lightbox")).toBeNull();
  });
  it("runs a slideshow the person starts and pauses, one photo per hold, stopping on the last", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await show(page([photo(1), photo(2), photo(3)])); await click(byLabel("Open Photo 01")); await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    const counter = () => byTestId("delivery-lightbox-counter")!.textContent;
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDE_MS * 3); });
    expect(counter()).toBe("Photo 1 of 3"); // nothing moves until it is started
    const toggle = () => [...byTestId("delivery-lightbox")!.querySelectorAll<HTMLElement>("button")].find((b) => /slideshow/i.test(b.textContent ?? ""))!;
    expect(toggle().textContent).toBe("Start slideshow");
    await click(toggle());
    expect(toggle().textContent).toBe("Pause slideshow"); expect(toggle().getAttribute("aria-pressed")).toBe("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDE_MS); });
    expect(counter()).toBe("Photo 2 of 3");
    await click(toggle());
    expect(toggle().textContent).toBe("Start slideshow");
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDE_MS * 3); });
    expect(counter()).toBe("Photo 2 of 3"); // paused: it stays
    await click(toggle());
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDE_MS); });
    expect(counter()).toBe("Photo 3 of 3");
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDE_MS); });
    expect(toggle().textContent).toBe("Start slideshow"); // ran out of photos
  });
  it("restarts the hold when the person moves on by hand", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await show(page([photo(1), photo(2), photo(3)])); await click(byLabel("Open Photo 01")); await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await click([...byTestId("delivery-lightbox")!.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Start slideshow")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDE_MS - 500); });
    await press("ArrowRight", byTestId("delivery-lightbox")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(SLIDE_MS - 500); });
    expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 2 of 3");
  });
  it("jumps instead of sliding under prefers-reduced-motion", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false, onchange: null })) as typeof window.matchMedia;
    try {
      await open();
      await press("ArrowRight", byTestId("delivery-lightbox")!);
      expect(embla.api!.scrollTo).toHaveBeenLastCalledWith(2, true);
      expect(embla.options).toMatchObject({ duration: 0 });
    } finally { window.matchMedia = original; }
  });
  it("shows the slide again after an unlock refetch when the locked preview had failed", async () => {
    mounted = await render(<Harness initial={page([locked(2)])} after={page([photo(2, { premium: true })])} />);
    await click(tab("Premium")); await click(byLabel("Open Photo 02")); await until(() => byTestId("delivery-lightbox"));
    const box = () => byTestId("delivery-lightbox")!;
    await act(async () => { box().querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(box().querySelector("img")).toBeNull();
    await click(byTestId("swap"));
    expect(box().querySelector("img")?.getAttribute("src")).toBe(photo(2).url);
  });
  it("jumps to the selected snap when a drag is released under prefers-reduced-motion, and lets embla settle otherwise", async () => {
    const original = window.matchMedia;
    const motion = (reduce: boolean) => { window.matchMedia = ((query: string) => ({ matches: reduce && query.includes("prefers-reduced-motion"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false, onchange: null })) as typeof window.matchMedia; };
    try {
      motion(false); await open();
      embla.api!.scrollTo.mockClear(); await embla.emit("pointerUp", 2);
      expect(embla.api!.scrollTo).not.toHaveBeenCalled();
      await mounted!.unmount(); mounted = null;
      motion(true); await open();
      embla.api!.scrollTo.mockClear(); await embla.emit("pointerUp", 2);
      expect(embla.api!.scrollTo).toHaveBeenLastCalledWith(2, true);
    } finally { window.matchMedia = original; }
  });
  it("keeps the photo on screen when the motion preference changes mid-view, and follows embla's own re-init", async () => {
    const original = window.matchMedia; const changes = new Set<EventListener>(); let reduce = false;
    window.matchMedia = ((query: string) => ({ get matches() { return reduce && query.includes("prefers-reduced-motion"); }, media: query, addEventListener: (_: string, listener: EventListener) => { changes.add(listener); }, removeEventListener: (_: string, listener: EventListener) => { changes.delete(listener); }, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false, onchange: null })) as unknown as typeof window.matchMedia;
    try {
      await open();
      await press("ArrowRight", byTestId("delivery-lightbox")!);
      expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 3 of 3");
      reduce = true; await act(async () => { changes.forEach((listener) => listener(new Event("change"))); });
      expect(embla.options).toMatchObject({ startIndex: 2, duration: 0 }); // re-initialises where the person is, not at the opening photo
      await embla.emit("reInit", 1);
      expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 2 of 3");
    } finally { window.matchMedia = original; }
  });
  it("shows a locked photo as its preview with Premium and Request unlock, and the same unlock state as the grid", async () => {
    const onRequestUnlock = vi.fn();
    await show(page([photo(1), locked(2)]), { onRequestUnlock, unlockState: { [handle(2)]: { kind: "requested" } } });
    await click(tab("Premium"));
    await click(byLabel("Open Photo 02")); await flush();
    const box = byTestId("delivery-lightbox")!;
    expect(box.textContent).toContain("Premium");
    expect(box.textContent).toContain("Requested. The studio will be in touch.");
    expect(box.querySelector("img")!.getAttribute("src")).toBe(locked(2).url);
  });
  it("shows the lightbox for only the tab's own photos, so Premium's viewer holds Premium's photos", async () => {
    await show(page([photo(1), locked(2), locked(3)]));
    await click(tab("Premium")); await click(byLabel("Open Photo 03")); await flush();
    expect(byTestId("delivery-lightbox-counter")!.textContent).toBe("Photo 2 of 2");
  });
});

describe("film", () => {
  it("is a native video with controls, no preload and the thumbnail as its poster, and an original download", async () => {
    await show(page([film(1)])); await click(tab("Film"));
    const video = document.querySelector("video")!;
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.getAttribute("preload")).toBe("none");
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.getAttribute("poster")).toBe(film(1).thumbUrl);
    expect(video.getAttribute("src")).toBe(film(1).url);
    expect(document.querySelector<HTMLAnchorElement>('a[aria-label="Download Video 01, original"]')!.getAttribute("href")).toBe(hrefs.download(handle(1)));
  });
  it("pauses when the tab changes and when the page goes away", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      await show(page([photo(1), film(2)])); await click(tab("Film"));
      const video = document.querySelector("video");
      pause.mockClear();
      await click(tab("Photos"));
      expect(pause.mock.contexts).toContain(video);
      await click(tab("Film"));
      const again = document.querySelector("video");
      pause.mockClear();
      await mounted!.unmount(); mounted = null;
      expect(pause.mock.contexts).toContain(again);
    } finally { pause.mockRestore(); }
  });
  it("starting one film pauses another", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      await show(page([film(1), film(2)])); await click(tab("Film"));
      const [first, second] = [...document.querySelectorAll("video")];
      pause.mockClear();
      await act(async () => { second!.dispatchEvent(new Event("play", { bubbles: false })); });
      expect(pause.mock.contexts).toContain(first);
      expect(pause.mock.contexts).not.toContain(second);
    } finally { pause.mockRestore(); }
  });
  it("falls back to a message and the original download when the film will not play", async () => {
    await show(page([film(1)])); await click(tab("Film"));
    await act(async () => { document.querySelector("video")!.dispatchEvent(new Event("error")); });
    expect(document.querySelector("video")).toBeNull();
    expect(byTestId("delivery-film-failed")!.textContent).toContain("This film can't be played here.");
    expect(document.querySelector('a[aria-label="Download Video 01, original"]')).not.toBeNull();
  });
});

describe("documents", () => {
  it("lists a PDF row with View in a new tab (noopener noreferrer) and Download", async () => {
    await show(page([pdf(1, "floorplan"), pdf(2, "copy")])); await click(tab("Floorplan"));
    const view = byLabel("View Floorplan 01") as HTMLAnchorElement;
    expect(view.getAttribute("href")).toBe(pdf(1, "floorplan").url);
    expect(view.getAttribute("target")).toBe("_blank");
    expect(view.getAttribute("rel")).toBe("noopener noreferrer");
    const download = byLabel("Download Floorplan 01") as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe(hrefs.download(handle(1)));
    expect(download.hasAttribute("download")).toBe(true);
    await click(tab("Description"));
    expect(byLabel("View Copy 02")).not.toBeNull();
  });
});

describe("premium", () => {
  it("shows a locked photo as its preview with a Premium badge, and a locked film or PDF as a labelled placeholder with no URL at all", async () => {
    await show(page([locked(1), locked(2, { kind: "video", label: "Video 02", url: null, thumbUrl: null }), locked(3, { kind: "floorplan", label: "Floorplan 03", url: null, thumbUrl: null })]));
    await click(tab("Premium"));
    const panel = byTestId("delivery-panel-premium")!;
    expect(panel.querySelector('[data-testid="delivery-tile"] img')!.getAttribute("src")).toBe(locked(1).thumbUrl);
    expect(panel.querySelector("video")).toBeNull();
    const placeholder = byTestId("delivery-locked", panel)!;
    expect(placeholder.textContent).toContain("Video 02"); expect(placeholder.textContent).toContain("Premium");
    expect([...panel.querySelectorAll("[href], [src]")].map((el) => el.getAttribute("href") ?? el.getAttribute("src"))).toEqual([locked(1).thumbUrl]);
    expect(allByTestId("delivery-premium-badge", panel)).toHaveLength(3);
    expect([...panel.querySelectorAll("button")].filter((b) => b.textContent === "Request unlock")).toHaveLength(3);
  });
  it("sends the handle to onRequestUnlock and nothing else", async () => {
    const onRequestUnlock = vi.fn();
    await show(page([locked(1)]), { onRequestUnlock });
    await click(tab("Premium")); await click(byLabel("Request unlock: Photo 01"));
    expect(onRequestUnlock).toHaveBeenCalledWith(handle(1));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    ["sending", { kind: "sending" } as const, true, ""],
    ["limited", { kind: "limited", until: Date.now() + 30_000 } as const, true, "Too many requests. Try again in"],
    ["failed", { kind: "failed" } as const, false, "Couldn't send. Try again."],
  ])("renders the %s state of a request", async (_name, state, disabled, text) => {
    await show(page([locked(1)]), { unlockState: { [handle(1)]: state } });
    await click(tab("Premium"));
    const button = byLabel("Request unlock: Photo 01") as HTMLButtonElement;
    expect(button.disabled).toBe(disabled);
    expect(byTestId("delivery-unlock-status")!.textContent).toContain(text);
  });
  it("replaces the button with the studio's acknowledgement once requested, and the acknowledgement survives a tab change", async () => {
    await show(page([photo(1), locked(2)]), { unlockState: { [handle(2)]: { kind: "requested" } } });
    await click(tab("Premium"));
    expect(byLabel("Request unlock: Photo 02")).toBeNull();
    expect(byTestId("delivery-unlock-status")!.textContent).toBe("Requested. The studio will be in touch.");
    await click(tab("Photos")); await click(tab("Premium"));
    expect(byTestId("delivery-unlock-status")!.textContent).toBe("Requested. The studio will be in touch.");
  });
  it("counts a rate-limit wait down and enables the button again at zero", async () => {
    vi.useFakeTimers();
    await show(page([locked(1)]), { unlockState: { [handle(1)]: { kind: "limited", until: Date.now() + 3000 } } });
    await click(tab("Premium"));
    const button = () => byLabel("Request unlock: Photo 01") as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    expect(byTestId("delivery-unlock-status")!.textContent).toBe("Too many requests. Try again in 3 seconds.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(byTestId("delivery-unlock-status")!.textContent).toBe("Too many requests. Try again in 1 second.");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(button().disabled).toBe(false);
    expect(byTestId("delivery-unlock-status")!.textContent).toBe("");
  });
});

describe("download all", () => {
  it("renders nothing in this slice and probes no endpoint", async () => {
    await show(page([photo(1), photo(2)]));
    expect(document.body.textContent).not.toMatch(/download all/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(byTestId("delivery-panel-photos")!.querySelector('a[href*="zip"], a[href*="all"]')).toBeNull();
  });
  it("renders whatever slice 7 passes in the slot beside the Photos heading", async () => {
    await show(page([photo(1)]), { downloadAllSlot: <span data-testid="slot">Download all</span> });
    expect(byTestId("slot")!.closest('[data-slot="section-head"]')).not.toBeNull();
  });
});
