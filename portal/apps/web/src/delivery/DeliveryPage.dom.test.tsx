import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPageDto } from "@quincy/shared";
import { allByTestId, byLabel, byTestId, click, embla, fakeEmblaModule, film, flush, handle, locked, page, pdf, photo, press, render, tab, tabNames, until, type Mounted } from "../testing/delivery-fixtures";
import type { DeliveryHrefs, UnlockStates } from "./delivery-model";
import { DeliveryPage } from "./DeliveryPage";
import { SLIDE_MS } from "./DeliveryLightbox";
import { createDeliveryApi } from "./delivery-api";
import { mockViewport } from "../testing/viewport";

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
  it("orders Gallery, Film, Floorplan, Copywriting, hides empty tabs and keeps published order", async () => {
    await show(page([pdf(1, "copy"), photo(2), film(3), pdf(4, "floorplan"), photo(5)]));
    expect(tabNames()).toEqual(["Gallery", "Film", "Floorplan", "Copywriting"]);
    expect(allByTestId("delivery-tile").map((tile) => tile.dataset.handle)).toEqual([handle(2), handle(5)]);
  });
  it("hides every tab that has nothing in it and shows a calm empty state for an empty page", async () => {
    await show(page([photo(1)]));
    expect(tabNames()).toEqual(["Gallery"]);
    await mounted!.unmount();
    await show(page([]));
    expect(tabNames()).toEqual([]);
    expect(byTestId("delivery-empty")).not.toBeNull();
  });
  it("adds Premium only when something is a paid extra, and keeps it, with the item, after an unlock", async () => {
    mounted = await render(<Harness initial={page([photo(1), locked(2)])} after={page([photo(1), photo(2, { premium: true, locked: false })])} />);
    expect(tabNames()).toEqual(["Gallery", "Premium"]);
    await click(tab("Premium"));
    expect(allByTestId("delivery-tile").map((tile) => tile.dataset.handle)).toEqual([handle(2)]);
    expect(byTestId("delivery-premium-badge")).not.toBeNull();
    await click(byTestId("swap"));
    expect(tabNames()).toEqual(["Gallery", "Premium"]);
    expect(byTestId("delivery-panel-premium")).not.toBeNull();
    expect(allByTestId("delivery-tile").map((tile) => tile.dataset.handle)).toEqual([handle(2)]);
    expect(byTestId("delivery-premium-badge")).toBeNull();
    expect(byTestId("delivery-panel-premium")!.querySelectorAll("a[download]")).toHaveLength(1);
  });
  it("keeps the chosen tab in memory while the page re-renders and falls back to the first tab when it disappears", async () => {
    mounted = await render(<Harness initial={page([photo(1), film(2)])} after={page([photo(1)])} />);
    await click(tab("Film"));
    expect(byTestId("delivery-panel-film")).not.toBeNull();
    await click(byTestId("swap"));
    expect(tabNames()).toEqual(["Gallery"]);
    expect(byTestId("delivery-panel-photos")).not.toBeNull();
  });
  it("shows each tab's count beside its label, and a lock on Premium", async () => {
    await show(page([photo(1), photo(2), film(3), pdf(4, "floorplan"), pdf(5, "copy"), pdf(6, "copy"), locked(7)]));
    expect(tabNames()).toEqual(["Gallery", "Film", "Floorplan", "Premium", "Copywriting"]);
    const counts = [...document.querySelectorAll('[role="tab"]')].map((element) => element.querySelector('[data-testid="delivery-tab-count"]')?.textContent);
    expect(counts).toEqual(["2", "1", "1", "1", "2"]);
    expect(tab("Premium")!.querySelector("svg")).not.toBeNull();
    expect(tab("Gallery")!.querySelector("svg")).toBeNull();
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
    const img = byTestId("delivery-hero-photo")!;
    expect(img.getAttribute("src")).toBe(photo(2).url);
    expect(img.getAttribute("srcset")).toBe(`${photo(2).thumbUrl} 640w, ${photo(2).url} 2048w`);
    expect(img.getAttribute("fetchpriority")).toBe("high");
    expect(img.getAttribute("alt")).toBe("Photo 02");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("h1")!.textContent).toBe("12 Example St");
  });
  it("falls back to the first unlocked photo when the cover is locked, and to text only when there is no photo to show", async () => {
    await show(page([locked(1), photo(2), photo(3)], { coverHandle: handle(1) }));
    expect(byTestId("delivery-hero-photo")!.getAttribute("src")).toBe(photo(2).url);
    await mounted!.unmount();
    await show(page([locked(1), film(2)], { coverHandle: handle(1) }));
    expect(byTestId("delivery-hero-photo")).toBeNull();
    expect(document.querySelector("h1")!.textContent).toBe("12 Example St");
  });
  it("prints the eyebrow as suburb, postcode and delivered date (in the studio's time zone), and drops the date for a Preview", async () => {
    await show(page([photo(1)]));
    expect(byTestId("delivery-hero-eyebrow")!.textContent).toBe("Suburbia · 2030 · 11 October 2026");
    await mounted!.unmount();
    await show(page([photo(1)], { publishedAt: null }));
    expect(byTestId("delivery-hero-eyebrow")!.textContent).toBe("Suburbia · 2030");
    expect(byTestId("delivery-hero")!.textContent).not.toContain("Delivered");
  });
  it("prints the meta line as the agency, a dash and the counts: frames are the Gallery's photos, films are every film", async () => {
    await show(page([photo(1), photo(2), locked(3), film(4)]));
    const meta = byTestId("delivery-hero-meta")!;
    expect(meta.textContent).not.toMatch(/\bby\b/);
    expect(meta.textContent).toBe("Harbour Realty—2 frames · 1 film");
  });
  it("leaves the dash out when the agency is unknown, and a zero count out of the counts", async () => {
    await show(page([photo(1)], { property: { street: "12 Example St", suburb: "Suburbia", postcode: "2030", agency: null } }));
    expect(byTestId("delivery-hero-meta")!.textContent).toBe("1 frame");
  });
  it("has no Ask the studio link or button anywhere on the page", async () => {
    await show(page([photo(1), locked(2)]));
    expect([...document.querySelectorAll("a, button")].filter((element) => /^ask the studio$/i.test((element.textContent ?? "").trim()))).toEqual([]);
  });
  it("sets the wordmark credit in the hero's top right as decoration, not a second studio name", async () => {
    await show(page([photo(1)]));
    const credit = byTestId("delivery-hero-credit")!;
    expect(credit.getAttribute("aria-hidden")).toBe("true");
    expect(credit.querySelector("img")!.getAttribute("src")).toBe("/brand/quincy-wordmark-white.png");
    expect(credit.querySelector("img")!.getAttribute("alt")).toBe("");
  });
  it("lays no Q watermark over the hero photo", async () => {
    await show(page([photo(1)]));
    expect(byTestId("delivery-hero")!.querySelector('img[src*="HERO-Q"]')).toBeNull();
  });
  it("falls to the plain ink hero, not a broken image or the original, when the hero derivative is missing", async () => {
    await show(page([photo(1)]));
    await act(async () => { byTestId("delivery-hero-photo")!.dispatchEvent(new Event("error")); });
    expect(byTestId("delivery-hero-photo")).toBeNull();
    expect(byTestId("delivery-hero")!.querySelector('[data-testid="delivery-processing"]')).toBeNull();
    expect(document.querySelector("h1")!.textContent).toBe("12 Example St");
  });
  it("prints the studio footer: the name, the email as a mailto for this street, and the website", async () => {
    await show(page([photo(1)]));
    const footer = byTestId("delivery-footer")!;
    expect(footer.textContent).toContain("Quincy Productions");
    const email = [...footer.querySelectorAll("a")].find((a) => a.textContent === "info@quincyproductions.com.au")!;
    expect(email.getAttribute("href")).toBe("mailto:info@quincyproductions.com.au?subject=12%20Example%20St");
    const site = [...footer.querySelectorAll("a")].find((a) => a.textContent === "quincyproductions.com.au")!;
    expect(site.getAttribute("href")).toBe("https://quincyproductions.com.au");
    expect(site.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("lets the tab list grow past its fixed 32px height, as a single sideways-scrolling row (never wrapping)", async () => {
    await show(page([photo(1), film(2), pdf(3, "floorplan"), pdf(4, "copy"), locked(5)]));
    const list = byTestId("delivery-tabs-list")!;
    expect(list.className).toContain("flex-nowrap");
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).not.toContain("flex-wrap");
    expect(list.className).toContain("group-data-[orientation=horizontal]/tabs:h-auto");
    expect(list.className).not.toContain("group-data-[orientation=horizontal]/tabs:h-8");
    const triggers = [...list.querySelectorAll('[role="tab"]')];
    expect(triggers.length).toBe(5);
    for (const t of triggers) {
      expect(t.className).toContain("h-auto");
      expect(t.className).not.toContain("h-[calc(100%-1px)]");
    }
  });
  it("sticks the tab bar above the content on a tokenised ground, and mutes the counts", async () => {
    await show(page([photo(1), film(2)]));
    const bar = byTestId("delivery-tabs-list")!.parentElement!.parentElement!;
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("top-0");
    expect(bar.className).toMatch(/\bz-/);
    expect(byTestId("delivery-tab-count")!.className).toContain("text-muted-foreground");
  });
  it("hides the hero wordmark credit once the page is 721 px or narrower", async () => {
    await show(page([photo(1)]));
    expect(byTestId("delivery-hero-credit")!.className).toContain("@max-[721px]:hidden");
  });
  it("describes the PDFs as Floorplan and Copywriting, and names the Copywriting section the same", async () => {
    await show(page([pdf(1, "floorplan"), pdf(2, "copy")]));
    await click(tab("Floorplan"));
    expect(byTestId("delivery-doc")!.textContent).toContain("Floorplan · PDF");
    await click(tab("Copywriting"));
    expect(byTestId("delivery-panel-description")!.querySelector('[data-testid="delivery-doc"]')!.textContent).toContain("Copywriting · PDF");
  });
  it("groups the Premium tab by kind under headings with counts, naming the documents Copywriting", async () => {
    await show(page([locked(1), locked(2, { kind: "copy", url: null, thumbUrl: null })]));
    await click(tab("Premium"));
    expect(byLabel("Copywriting", byTestId("delivery-panel-premium")!)).not.toBeNull();
    expect(byLabel("Description")).toBeNull();
    expect(byTestId("delivery-panel-premium")!.textContent).toContain("2items to unlock");
  });
  it("lets a lone film span the whole row", async () => {
    await show(page([film(1)]));
    expect(byTestId("delivery-film")!.className).toContain("has-[>li:only-child]:grid-cols-1");
  });
});

describe("Social preview (#872)", () => {
  it("is not on the Film tab: no Social control, no frame, nothing named Social, whether a film is locked or not", async () => {
    await show(page([film(1), film(2, { locked: true })]));
    await click(tab("Film"));
    expect(byTestId("guest-social-toggle")).toBeNull();
    expect(document.querySelector('[data-testid^="video-social"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/social/i);
  });
});

describe("photo grid", () => {
  it("captions every tile with its label, always visible", async () => {
    await show(page([photo(1), photo(2)]));
    expect(allByTestId("delivery-tile").map((tile) => tile.querySelector('[data-testid="delivery-tile-caption"]')?.textContent)).toEqual(["Photo 01", "Photo 02"]);
  });
  it("is four columns, two at 721 px and under the container, and every tile is a uniform 3:2 box whatever the photo's own ratio", async () => {
    await show(page([photo(1), photo(2, { width: 3000, height: 4000 }), photo(3, { width: null, height: null })]));
    const grid = byTestId("delivery-grid")!;
    expect(grid.className).toContain("grid-cols-4");
    expect(grid.className).toContain("@max-[721px]:grid-cols-2");
    for (const tile of allByTestId("delivery-tile")) {
      const box = tile.firstElementChild as HTMLElement;
      expect(box.className).toContain("aspect-[3/2]");
      expect(box.style.aspectRatio).toBe("");
      expect(tile.querySelector("img")!.className).toContain("object-cover");
    }
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
    // The caption's scrim would cover the "still being prepared" text.
    expect(allByTestId("delivery-tile")[0]!.querySelector('[data-testid="delivery-tile-caption"]')).toBeNull();
  });
  it("keeps the open button outside any overflow-hidden ancestor within its tile, so its focus outline is not clipped", async () => {
    await show(page([photo(1), locked(2)]));
    for (const name of ["Gallery", "Premium"]) {
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
  it("gives each unlocked photo exactly one always-visible Download of the original, named for the photo, outside the open button", async () => {
    await show(page([photo(1), photo(2)]));
    for (const [n, tile] of allByTestId("delivery-tile").entries()) {
      const links = [...tile.querySelectorAll<HTMLAnchorElement>("a")];
      expect(links).toHaveLength(1);
      expect(links[0]!.getAttribute("href")).toBe(hrefs.download(handle(n + 1)));
      expect(links[0]!.hasAttribute("download")).toBe(true);
      expect(links[0]!.getAttribute("aria-label")).toBe(`Download Photo 0${n + 1}`);
      expect(links[0]!.className).toContain("max-[721px]:min-h-11");
      expect(links[0]!.closest("button")).toBeNull();
      expect(links[0]!.className).not.toMatch(/\bhidden\b|opacity-0|group-hover/);
    }
    expect(document.body.textContent).not.toMatch(/Web-size|Full-res/);
  });
  it("does not open the viewer when a tile's Download is activated", async () => {
    await show(page([photo(1)]));
    const link = byLabel("Download Photo 01") as HTMLAnchorElement;
    link.addEventListener("click", (event) => { event.preventDefault(); });
    await click(link); await flush();
    expect(byTestId("delivery-lightbox")).toBeNull();
  });
  it("keeps the lightbox's Web-size and Full-res pair", async () => {
    await show(page([photo(1)]));
    await click(byLabel("Open Photo 01")); await until(() => byTestId("delivery-lightbox"));
    const links = [...byTestId("delivery-lightbox")!.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Web-size", hrefs.media(handle(1))], ["Full-res", hrefs.download(handle(1))]]);
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
    for (const name of ["Gallery", "Film", "Floorplan", "Copywriting"]) { await click(tab(name)); expect(document.querySelectorAll("a[download]"), name).toHaveLength(0); }
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

describe("back from a film's review (#882 follow-up)", () => {
  const vid = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
  const review = (n: number) => ({ url: `/d/review?link=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#t=secret&v=${vid(n)}` });
  const films = () => [photo(1), film(2, { review: review(2) }), film(3, { review: review(3) }), film(4, { review: review(4) })];
  const openOf = (n: number) => document.querySelector<HTMLElement>(`[data-testid="delivery-film-item"][data-handle="${handle(n)}"] [data-testid="delivery-film-open"]`)!;
  let scrolled: { target: Element; options: unknown }[];
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: unknown) { scrolled.push({ target: this, options }); };
  });
  afterEach(() => { delete (Element.prototype as Partial<Element>).scrollIntoView; });

  const itemOf = (n: number) => openOf(n).closest('[data-testid="delivery-film-item"]')!;
  it("opens the Film tab and brings the returning film's whole tile to the centre, without an animated scroll, focusing its open link", async () => {
    await show(page(films()), { returnToVideo: vid(3) });
    expect(tab("Film")!.getAttribute("aria-selected")).toBe("true");
    expect(scrolled).toEqual([{ target: itemOf(3), options: { block: "center" } }]);
    expect(document.activeElement).toBe(openOf(3));
  });
  it("leaves a plain open of the page at the top of its first tab", async () => {
    await show(page(films()));
    expect(tab("Gallery")!.getAttribute("aria-selected")).toBe("true");
    expect(scrolled).toEqual([]);
  });
  it("ignores a film no tile opens", async () => {
    await show(page(films()), { returnToVideo: vid(9) });
    expect(tab("Gallery")!.getAttribute("aria-selected")).toBe("true");
    expect(scrolled).toEqual([]);
  });
  it("does not pull the viewer back to the tile when the page re-renders with fresh data (an unlock refetch)", async () => {
    const { root } = await show(page(films()), { returnToVideo: vid(2) });
    await act(async () => { root.render(<DeliveryPage dto={page([...films(), photo(5)])} returnToVideo={vid(2)} hrefs={hrefs} onRequestUnlock={() => undefined} unlockState={{}} />); });
    expect(scrolled.map((entry) => entry.target)).toEqual([openOf(2).closest('[data-testid="delivery-film-item"]')]);
  });
});

describe("film tiles (#882)", () => {
  const REVIEW = "/d/review?link=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#t=secret&v=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PAGE_SLUG = "12-example-st-23456b";
  const tileOf = (n: number) => document.querySelector<HTMLElement>(`[data-testid="delivery-film-item"][data-handle="${handle(n)}"]`)!;
  const openOf = (n: number) => tileOf(n).querySelector<HTMLElement>('[data-testid="delivery-film-open"]')!;
  const showFilms = async (items: DeliveryPageDto["items"], props: Props = {}) => { await show(page(items), { pageSlug: PAGE_SLUG, ...props }); await click(tab("Film")); };

  it("is the guest poster tile in paper colours: poster, Version, duration, title and the open-note count, no inline player", async () => {
    await showFilms([film(1, { review: { url: REVIEW }, version: 3, openNotes: 2 })]);
    const tile = byTestId("delivery-film-tile")!;
    expect(tile.dataset.tone).toBe("paper"); expect(tile.hasAttribute("data-surface")).toBe(false);
    expect(tile.querySelector("img")!.getAttribute("src")).toBe(film(1).thumbUrl);
    expect(tile.textContent).toContain("v3"); expect(tile.textContent).toContain("1:02");
    expect(openOf(1).textContent).toBe("Video 01");
    expect(byTestId("delivery-film-tile-open-notes")!.textContent).toBe("2");
    expect(document.querySelector("video")).toBeNull();
    const summary = document.getElementById(openOf(1).getAttribute("aria-describedby")!)!;
    expect(summary.textContent).toBe("v3, 1:02, 2 open notes on v3");
  });
  it("names a film by its own title (#882): the tile, the unlock control, the menu and the Download link, and a long title truncates; a page from an older Worker (no title) keeps the label", async () => {
    const long = "A very long film title ".repeat(12).trim();
    await showFilms([film(1, { review: { url: REVIEW }, title: "Harbour View Walkthrough" }), film(2, { review: { url: REVIEW }, title: long }), film(3, { review: { url: REVIEW } })]);
    expect(openOf(1).textContent).toBe("Harbour View Walkthrough");
    expect(openOf(2).textContent).toBe(long); expect(openOf(2).querySelector("span")!.className).toContain("truncate");
    expect(openOf(3).textContent).toBe("Video 03");
    const trigger = tileOf(1).querySelector<HTMLElement>('[data-testid="delivery-film-menu"]')!;
    expect(trigger.getAttribute("aria-label")).toBe("Actions for Harbour View Walkthrough");
    await click(trigger);
    expect(document.querySelector('[data-testid="delivery-film-download"]')!.getAttribute("aria-label")).toBe("Download Harbour View Walkthrough, original");
  });
  it("a locked Premium film shows its title too, and the unlock control is named for it", async () => {
    await show(page([locked(1, { kind: "video", label: "Video 01", title: "Sunset Cut", url: null, thumbUrl: null })]));
    await click(tab("Premium"));
    expect(openOf(1).textContent).toBe("Sunset Cut");
    expect(openOf(1).getAttribute("aria-label")).toBe("Request unlock: Sunset Cut");
  });
  it("the plain player is titled with the film's title", async () => {
    await showFilms([film(1, { title: "Harbour View Walkthrough" })]);
    await click(openOf(1)); await flush();
    const dialog = byTestId("delivery-film-player")!;
    expect(dialog.textContent).toContain("Harbour View Walkthrough"); expect(dialog.textContent).not.toContain("Video 01");
    expect(byTestId("delivery-film-player-download")!.getAttribute("aria-label")).toBe("Download Harbour View Walkthrough, original");
  });
  it("hides the count at 0 and shows no Version or count where there is no review (the page cannot point them anywhere)", async () => {
    await showFilms([film(1, { review: { url: REVIEW }, version: 2, openNotes: 0 }), film(2, { version: null, openNotes: null })]);
    expect(tileOf(1).querySelector('[data-testid="delivery-film-tile-open-notes"]')).toBeNull();
    expect(tileOf(1).textContent).toContain("v2");
    expect(tileOf(2).querySelector('[data-testid="delivery-film-tile-version"]')).toBeNull();
    expect(tileOf(2).querySelector('[data-testid="delivery-film-tile-open-notes"]')).toBeNull();
    expect(tileOf(2).textContent).toContain("1:02");
  });
  it("builds the same-tab address as the review link plus the page to return to (D34)", async () => {
    const { reviewAddress } = await import("./FilmList");
    expect(reviewAddress(REVIEW, PAGE_SLUG)).toBe(`${REVIEW}&p=${PAGE_SLUG}`);
    expect(reviewAddress(REVIEW, null)).toBe(REVIEW);
  });
  it("opens the review through a real same-tab link to the review address and the slug (story 28), so open-in-new-tab works", async () => {
    await showFilms([film(1, { review: { url: REVIEW } })]);
    const open = openOf(1);
    expect(open.tagName).toBe("A");
    expect(open.getAttribute("href")).toBe(`${REVIEW}&p=${PAGE_SLUG}`);
    expect(open.hasAttribute("target")).toBe(false); expect(open.hasAttribute("download")).toBe(false);
    expect(open.textContent).toBe("Video 01");
    expect(document.querySelector('[data-testid="delivery-film-player"]')).toBeNull();
  });
  it("keeps a button only where the tile acts rather than navigates: the plain player (no review) and a locked film", async () => {
    await show(page([film(1), locked(2, { kind: "video", label: "Video 02", url: null, thumbUrl: null })]), { pageSlug: PAGE_SLUG });
    await click(tab("Film"));
    expect(openOf(1).tagName).toBe("BUTTON"); expect(openOf(1).hasAttribute("href")).toBe(false);
    await click(tab("Premium"));
    expect(openOf(2).tagName).toBe("BUTTON");
  });
  it("has no new-tab link and no Review & feedback button any more", async () => {
    await showFilms([film(1, { review: { url: REVIEW } })]);
    expect([...byTestId("delivery-film")!.querySelectorAll("a")].filter((a) => a.textContent === "Review & feedback" || a.getAttribute("target") === "_blank")).toHaveLength(0);
    expect(byTestId("delivery-film")!.textContent).not.toContain("Review & feedback");
  });
  it("⋯ offers Download original (a download link to the original); Preview has no ⋯ at all", async () => {
    await showFilms([film(1, { review: { url: REVIEW } })]);
    await click(byTestId("delivery-film-menu"));
    const link = document.querySelector<HTMLAnchorElement>('[data-testid="delivery-film-download"]')!;
    expect(link.textContent).toContain("Download original"); expect(link.getAttribute("href")).toBe(hrefs.download(handle(1))); expect(link.hasAttribute("download")).toBe(true);
    await mounted!.unmount(); mounted = null;
    await show(page([film(1)]), { hrefs: null }); await click(tab("Film"));
    expect(byTestId("delivery-film-menu")).toBeNull();
    expect(document.querySelector("a[download]")).toBeNull();
  });
  it("with no review a tap plays the film in the plain player: title, Download original, close, no notes, no code", async () => {
    await showFilms([film(1)]);
    await click(openOf(1)); await flush();
    const dialog = byTestId("delivery-film-player")!;
    expect(dialog.getAttribute("data-surface")).toBe("inverse");
    expect(dialog.textContent).toContain("Video 01");
    const video = dialog.querySelector("video")!; expect(video.getAttribute("src")).toBe(film(1).url); expect(video.hasAttribute("controls")).toBe(true);
    expect(byTestId("delivery-film-player-download")!.getAttribute("href")).toBe(hrefs.download(handle(1)));
    expect(dialog.textContent).not.toMatch(/note|code|verify/i);
    expect(window.location.pathname).not.toContain("/d/review");
  });
  it("the plain player in Preview has no Download, and closing it pauses the film and returns focus to the tile", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      await show(page([film(1)]), { hrefs: null }); await click(tab("Film"));
      const opener = openOf(1); opener.focus();
      await click(opener); await flush();
      expect(byTestId("delivery-film-player-download")).toBeNull();
      const video = document.querySelector("video")!; pause.mockClear();
      await click(byTestId("delivery-film-player-close")); await flush();
      expect(byTestId("delivery-film-player")).toBeNull();
      expect(pause.mock.contexts).toContain(video);
      expect(document.activeElement).toBe(opener);
    } finally { pause.mockRestore(); }
  });
  it("the plain player pauses when the page goes away", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      await showFilms([film(1)]); await click(openOf(1)); await flush();
      const video = document.querySelector("video")!; pause.mockClear();
      await mounted!.unmount(); mounted = null;
      expect(pause.mock.contexts).toContain(video);
    } finally { pause.mockRestore(); }
  });
  it("the plain player shows a loading line until the film's metadata is in (iOS fetches no frames before play), then the film alone", async () => {
    await showFilms([film(1)]); await click(openOf(1)); await flush();
    const loading = byTestId("delivery-film-player-loading")!;
    expect(loading.getAttribute("role")).toBe("status"); expect(loading.textContent).toContain("Loading");
    await act(async () => { byTestId("delivery-film-player-video")!.dispatchEvent(new Event("loadedmetadata")); });
    expect(byTestId("delivery-film-player-loading")).toBeNull();
    expect(byTestId("delivery-film-player-error")).toBeNull();
  });
  it("a film that fails to load is an inline error with Try again, which loads it afresh", async () => {
    await showFilms([film(1)]); await click(openOf(1)); await flush();
    const first = byTestId("delivery-film-player-video")!;
    await act(async () => { first.dispatchEvent(new Event("error")); });
    const error = byTestId("delivery-film-player-error")!;
    expect(error.getAttribute("role")).toBe("alert"); expect(error.textContent).toMatch(/Couldn't play this film/);
    expect(byTestId("delivery-film-player-video")).toBeNull(); expect(byTestId("delivery-film-player-loading")).toBeNull();
    // Download original and Close stay: a film that will not stream may still download.
    expect(byTestId("delivery-film-player-download")).not.toBeNull(); expect(byTestId("delivery-film-player-close")).not.toBeNull();
    await click(byTestId("delivery-film-player-retry"));
    const second = byTestId("delivery-film-player-video")!;
    expect(second).not.toBe(first); expect(second.getAttribute("src")).toBe(film(1).url);
    expect(byTestId("delivery-film-player-error")).toBeNull(); expect(byTestId("delivery-film-player-loading")).not.toBeNull();
  });
  it("the plain player closes by itself when the film is relocked", async () => {
    mounted = await render(<Harness initial={page([film(1)])} after={page([locked(1, { kind: "video", label: "Video 01", url: null, thumbUrl: null })])} />);
    await click(tab("Film")); await click(openOf(1)); await flush();
    expect(byTestId("delivery-film-player")).not.toBeNull();
    await click(byTestId("swap")); await flush();
    expect(byTestId("delivery-film-player")).toBeNull();
  });
  it("a locked film is a locked tile: lock, 'Film · locked', Premium in the menu's place, no Version, duration or count", async () => {
    const onRequestUnlock = vi.fn();
    await show(page([locked(1, { kind: "video", label: "Video 01", url: null, thumbUrl: null })]), { onRequestUnlock });
    await click(tab("Premium"));
    const tile = byTestId("delivery-film-tile")!;
    expect(tile.textContent).toContain("Film · locked"); expect(tile.querySelector('[data-testid="delivery-premium-badge"]')!.textContent).toBe("Premium");
    expect(tile.querySelector("img, video, a[href], [src]")).toBeNull();
    expect(tile.textContent).not.toMatch(/\bv\d|\d:\d\d/);
    expect(byTestId("delivery-film-menu")).toBeNull();
    await click(openOf(1)); expect(onRequestUnlock).toHaveBeenCalledWith(handle(1));
  });
  it("names the locked tile's whole-tile control for what it does: it requests the unlock", async () => {
    await show(page([locked(1, { kind: "video", label: "Video 01", url: null, thumbUrl: null })]));
    await click(tab("Premium"));
    expect(openOf(1).getAttribute("aria-label")).toBe("Request unlock: Video 01");
  });
  describe("the locked tile is one control (#882, V1/V3)", () => {
    const lockedFilm = () => locked(1, { kind: "video", label: "Video 01", url: null, thumbUrl: null });
    const controls = () => [...tileOf(1).querySelectorAll("button, a[href], input, [tabindex]")];
    const line = () => tileOf(1).querySelector<HTMLElement>('[data-testid="delivery-unlock"]')!;
    const status = () => tileOf(1).querySelector<HTMLElement>('[data-testid="delivery-unlock-status"]')!;
    const showLocked = async (unlockState: UnlockStates = {}, onRequestUnlock = vi.fn()) => { await show(page([lockedFilm()]), { unlockState, onRequestUnlock }); await click(tab("Premium")); return onRequestUnlock; };

    it("V1: the tile is the one control, and 'Request unlock' is a text line on it, not a second button", async () => {
      const onRequestUnlock = await showLocked();
      expect(controls()).toEqual([openOf(1)]);
      expect(openOf(1).getAttribute("aria-label")).toBe("Request unlock: Video 01"); expect(openOf(1).hasAttribute("aria-disabled")).toBe(false);
      // The visible line is the tile's affordance; the control's name already says it, so the line is not read twice.
      const action = line().querySelector<HTMLElement>('[data-testid="delivery-unlock-action"]')!;
      expect(action.textContent).toBe("Request unlock"); expect(action.className).toContain("underline"); expect(action.getAttribute("aria-hidden")).toBe("true");
      expect(status().getAttribute("aria-live")).toBe("polite"); expect(status().textContent).toBe("");
      await click(openOf(1));
      expect(onRequestUnlock).toHaveBeenCalledTimes(1); expect(onRequestUnlock).toHaveBeenCalledWith(handle(1));
    });
    it("V3: once requested, the line is the studio's acknowledgement and the tile is inert, named for what happened", async () => {
      const onRequestUnlock = await showLocked({ [handle(1)]: { kind: "requested" } });
      expect(controls()).toEqual([openOf(1)]);
      expect(openOf(1).getAttribute("aria-label")).toBe("Unlock requested: Video 01");
      expect(openOf(1).getAttribute("aria-disabled")).toBe("true"); expect((openOf(1) as HTMLButtonElement).disabled).toBe(false);
      expect(status().textContent).toBe("Requested. The studio will be in touch."); expect(status().getAttribute("aria-live")).toBe("polite");
      expect(line().querySelector('[data-testid="delivery-unlock-action"]')).toBeNull();
      expect(tileOf(1).textContent).not.toContain("Request unlock");
      await click(openOf(1));
      expect(onRequestUnlock).not.toHaveBeenCalled();
    });
    it("while sending the tile is inert and the line says Sending", async () => {
      const onRequestUnlock = await showLocked({ [handle(1)]: { kind: "sending" } });
      expect(openOf(1).getAttribute("aria-label")).toBe("Request unlock: Video 01"); expect(openOf(1).getAttribute("aria-disabled")).toBe("true");
      expect(line().querySelector('[data-testid="delivery-unlock-action"]')!.textContent).toBe("Sending");
      await click(openOf(1)); expect(onRequestUnlock).not.toHaveBeenCalled();
    });
    it("a failed request says so and stays retryable from the tile", async () => {
      const onRequestUnlock = await showLocked({ [handle(1)]: { kind: "failed" } });
      expect(status().textContent).toBe("Couldn't send. Try again.");
      expect(openOf(1).getAttribute("aria-label")).toBe("Request unlock: Video 01"); expect(openOf(1).hasAttribute("aria-disabled")).toBe(false);
      expect(line().querySelector('[data-testid="delivery-unlock-action"]')!.textContent).toBe("Request unlock");
      await click(openOf(1)); expect(onRequestUnlock).toHaveBeenCalledWith(handle(1));
    });
    it("a rate-limit wait holds the tile inert and counts down, then the tile requests again", async () => {
      vi.useFakeTimers();
      const onRequestUnlock = await showLocked({ [handle(1)]: { kind: "limited", until: Date.now() + 2000 } });
      expect(openOf(1).getAttribute("aria-disabled")).toBe("true");
      expect(status().textContent).toBe("Too many requests. Try again in 2 seconds.");
      await click(openOf(1)); expect(onRequestUnlock).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(openOf(1).hasAttribute("aria-disabled")).toBe(false); expect(status().textContent).toBe("");
      await click(openOf(1)); expect(onRequestUnlock).toHaveBeenCalledWith(handle(1));
    });
  });
  it("lays the grid out as auto-fill 280 px columns, one column at 721 px and under the page's container (not the window), and a lone film across the row (D32, D33)", async () => {
    await showFilms([film(1), film(2)]);
    const grid = byTestId("delivery-film")!.className;
    expect(grid).toContain("grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))]"); expect(grid).toContain("@max-[721px]:grid-cols-1"); expect(grid).toContain("has-[>li:only-child]:grid-cols-1");
    expect(grid.split(" ")).not.toContain("max-[721px]:grid-cols-1");
  });
});

describe("stepping in the plain player (#937)", () => {
  const REVIEW = "/d/review?link=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#t=secret&v=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const tileOf = (n: number) => document.querySelector<HTMLElement>(`[data-testid="delivery-film-item"][data-handle="${handle(n)}"]`)!;
  const openOf = (n: number) => tileOf(n).querySelector<HTMLElement>('[data-testid="delivery-film-open"]')!;
  const player = () => byTestId("delivery-film-player");
  const title = () => player()!.querySelector("h2")!.textContent;
  const position = () => byTestId("video-step-position")?.textContent ?? null;
  const prev = () => byTestId("video-step-previous") as HTMLButtonElement | null;
  const next = () => byTestId("video-step-next") as HTMLButtonElement | null;
  const lockedFilm = (n: number, over: Partial<DeliveryPageDto["items"][number]> = {}) => locked(n, { kind: "video", label: `Video ${String(n).padStart(2, "0")}`, url: null, thumbUrl: null, ...over });
  /** Film tab: 1 plays, 2 opens its review, 3 plays, 4 has no URL, 5 plays. */
  const mixed = () => [film(1), film(2, { review: { url: REVIEW } }), film(3), film(4, { url: null }), film(5)];
  const openFilm = async (n: number) => { await click(openOf(n)); await flush(); };
  const showFilmTab = async (items: DeliveryPageDto["items"]) => { await show(page(items), { hrefs: null }); await click(tab("Film")); };

  it("counts only the films this player plays (no Review link, a URL, unlocked) and steps over the rest", async () => {
    await showFilmTab(mixed());
    await openFilm(1);
    expect(byTestId("video-step-control", player()!)).not.toBeNull();
    expect(position()).toBe("1 of 3");
    expect(prev()!.getAttribute("aria-label")).toBe("Previous film"); expect(next()!.getAttribute("aria-label")).toBe("Next film");
    expect(prev()!.disabled).toBe(true); expect(next()!.disabled).toBe(false);
    await click(next()!); await flush();
    expect(title()).toBe("Video 03"); expect(position()).toBe("2 of 3");
    expect(byTestId("delivery-film-player-video")!.getAttribute("src")).toBe(film(3).url);
    await click(next()!); await flush();
    expect(title()).toBe("Video 05"); expect(position()).toBe("3 of 3");
    expect(next()!.disabled).toBe(true); expect(prev()!.disabled).toBe(false);
  });
  it("a press that reaches an end hands focus to the other step button, so the keyboard keeps a live control", async () => {
    await showFilmTab([film(1), film(2)]);
    await openFilm(1);
    next()!.focus(); await click(next()!); await flush();
    expect(next()!.disabled).toBe(true);
    expect(document.activeElement).toBe(prev());
  });
  it("[ and ] step from inside the player, and do nothing past either end", async () => {
    await showFilmTab(mixed());
    await openFilm(3);
    expect(position()).toBe("2 of 3");
    await press("]", player()!); await flush();
    expect(title()).toBe("Video 05");
    await press("]", player()!); await flush();
    expect(title()).toBe("Video 05");
    await press("[", player()!); await flush(); await press("[", player()!); await flush();
    expect(title()).toBe("Video 01"); expect(position()).toBe("1 of 3");
    await press("[", player()!); await flush();
    expect(title()).toBe("Video 01");
  });
  it("never steps onto a locked film, and the Premium films step among themselves, not with the Film tab", async () => {
    await show(page([film(1), film(2), film(3, { premium: true }), lockedFilm(4), film(5, { premium: true })]), { hrefs: null });
    await click(tab("Premium"));
    await openFilm(3);
    expect(position()).toBe("1 of 2");
    await click(next()!); await flush();
    expect(title()).toBe("Video 05"); expect(position()).toBe("2 of 2");
  });
  it("shows no step control and ignores [ and ] when only one film plays here", async () => {
    await showFilmTab([film(1), film(2, { review: { url: REVIEW } })]);
    await openFilm(1);
    expect(byTestId("video-step-control")).toBeNull();
    await press("]", player()!); await flush();
    expect(title()).toBe("Video 01");
  });
  it("sits in the title row on a wide screen and in its own row under it on a phone, where the title row is full", async () => {
    const viewport = mockViewport({ width: 1280 });
    try {
      await showFilmTab([film(1), film(2)]);
      await openFilm(1);
      const titleRow = () => player()!.querySelector("h2")!.parentElement!;
      expect(titleRow().contains(byTestId("video-step-control"))).toBe(true);
      await viewport.set({ width: 390 });
      expect(byTestId("video-step-control")).not.toBeNull();
      expect(titleRow().contains(byTestId("video-step-control"))).toBe(false);
      expect(position()).toBe("1 of 2");
    } finally { viewport.restore(); }
  });
  it("closing after steps returns focus to the film now showing", async () => {
    await showFilmTab(mixed());
    openOf(1).focus();
    await openFilm(1);
    await click(next()!); await flush(); await click(next()!); await flush();
    await click(byTestId("delivery-film-player-close")); await flush();
    expect(player()).toBeNull();
    expect(document.activeElement).toBe(openOf(5));
  });
  it("a step loads the next film afresh: the old one pauses, a new element shows the loading line, and a failed film's error does not carry over", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      await showFilmTab([film(1), film(2), film(3)]);
      await openFilm(1);
      const first = byTestId("delivery-film-player-video")!;
      await act(async () => { first.dispatchEvent(new Event("loadedmetadata")); });
      expect(byTestId("delivery-film-player-loading")).toBeNull();
      pause.mockClear();
      await click(next()!); await flush();
      const second = byTestId("delivery-film-player-video")!;
      expect(second).not.toBe(first); expect(pause.mock.contexts).toContain(first);
      expect(byTestId("delivery-film-player-loading")).not.toBeNull();
      await act(async () => { second.dispatchEvent(new Event("error")); });
      expect(byTestId("delivery-film-player-error")).not.toBeNull();
      await click(next()!); await flush();
      expect(byTestId("delivery-film-player-error")).toBeNull();
      expect(byTestId("delivery-film-player-video")!.getAttribute("src")).toBe(film(3).url);
    } finally { pause.mockRestore(); }
  });
  it("a refetch that relocks the film now showing closes the player and puts focus on that film's (now locked) tile", async () => {
    const premium = (n: number) => film(n, { premium: true });
    mounted = await render(<Harness initial={page([premium(1), premium(2), premium(3)])} after={page([premium(1), lockedFilm(2), premium(3)])} />);
    await click(tab("Premium")); await openFilm(1);
    await click(next()!); await flush();
    expect(title()).toBe("Video 02");
    await click(byTestId("swap")); await flush();
    expect(player()).toBeNull();
    expect(document.activeElement).toBe(openOf(2));
    expect(openOf(2).getAttribute("aria-label")).toBe("Request unlock: Video 02");
  });
  it("a film the player closed on (relocked) does not reopen it when it unlocks again", async () => {
    const premium = (n: number) => film(n, { premium: true });
    const { root } = await show(page([premium(1), premium(2)]), { hrefs: null });
    const again = async (items: DeliveryPageDto["items"]) => { await act(async () => { root.render(<DeliveryPage dto={page(items)} hrefs={null} onRequestUnlock={() => undefined} unlockState={{}} />); }); await flush(); };
    await click(tab("Premium")); await openFilm(2);
    await again([premium(1), lockedFilm(2)]);
    expect(player()).toBeNull();
    await again([premium(1), premium(2)]);
    expect(player()).toBeNull();
  });
  it("a refetch that takes the film now showing off the list closes the player and puts focus on the film that took its place", async () => {
    mounted = await render(<Harness initial={page([film(1), film(2), film(3)])} after={page([film(1), film(3)])} />);
    await click(tab("Film")); await openFilm(1);
    await click(next()!); await flush();
    await click(byTestId("swap")); await flush();
    expect(player()).toBeNull();
    expect(document.activeElement).toBe(openOf(3));
  });
  it("a refetch that drops another film keeps the player on its film and recounts", async () => {
    mounted = await render(<Harness initial={page([film(1), film(2), film(3)])} after={page([film(1), film(3)])} />);
    await click(tab("Film")); await openFilm(3);
    expect(position()).toBe("3 of 3");
    await click(byTestId("swap")); await flush();
    expect(title()).toBe("Video 03"); expect(position()).toBe("2 of 2");
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
    await click(tab("Copywriting"));
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
    const placeholder = byTestId("delivery-film-tile", panel)!;
    expect(placeholder.textContent).toContain("Video 02"); expect(placeholder.textContent).toContain("Premium");
    expect([...panel.querySelectorAll("[href], [src]")].map((el) => el.getAttribute("href") ?? el.getAttribute("src"))).toEqual([locked(1).thumbUrl]);
    expect(allByTestId("delivery-premium-badge", panel)).toHaveLength(3);
    const [onPhoto, , inRow] = allByTestId("delivery-premium-badge", panel);
    expect(onPhoto!.className).toContain("bg-warning "); expect(onPhoto!.className).not.toContain("bg-warning/10"); // solid over a photo
    expect(inRow!.className).toContain("bg-warning/10"); // tinted in a document row
    // A photo and a document row each have their Request unlock button; the locked film's is the tile itself (#882, V1).
    expect([...panel.querySelectorAll("button")].filter((b) => b.textContent === "Request unlock")).toHaveLength(2);
    expect(byLabel("Request unlock: Video 02")).toBe(placeholder.querySelector('[data-testid="delivery-film-open"]'));
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
    await click(tab("Gallery")); await click(tab("Premium"));
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
  it("renders whatever slice 7 passes in the slot inside the hero, as its action", async () => {
    await show(page([photo(1)]), { downloadAllSlot: <span data-testid="slot">Download all</span> });
    expect(byTestId("delivery-hero")!.contains(byTestId("slot"))).toBe(true);
  });
  it("keeps the slot in the hero on every tab, including a page with no Gallery tab", async () => {
    await show(page([photo(1, { premium: true }), film(2)]), { downloadAllSlot: <span data-testid="slot">Download all</span> });
    expect(tabNames()).toEqual(["Film", "Premium"]);
    expect(byTestId("delivery-hero")!.contains(byTestId("slot"))).toBe(true);
    await click(tab("Premium"));
    expect(byTestId("delivery-hero")!.contains(byTestId("slot"))).toBe(true);
    expect(allByTestId("slot")).toHaveLength(1);
  });
});

const slideshowButton = () => byTestId("delivery-slideshow");
const counter = () => byTestId("delivery-lightbox-counter")!.textContent;
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const playToggle = () => [...byTestId("delivery-lightbox")!.querySelectorAll<HTMLElement>("button")].find((b) => /slideshow/i.test(b.textContent ?? ""))!;

describe("hero action order", () => {
  it("puts Download all first, then Slideshow, then Share (the prototype's order)", async () => {
    await show(page([photo(1)]), { downloadAllSlot: <span data-testid="slot">Download all</span>, shareUrl: "https://quincy.example/d/x" });
    const order = [byTestId("slot")!, byTestId("delivery-slideshow")!, byTestId("delivery-share")!];
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("slideshow", () => {
  it("is a hero button beside the hero's other actions, and is absent when the tab has no eligible photo", async () => {
    await show(page([photo(1), film(2)]), { downloadAllSlot: <span data-testid="slot">Download all</span> });
    expect(byTestId("delivery-hero")!.contains(slideshowButton())).toBe(true);
    expect(slideshowButton()!.textContent).toBe("Slideshow");
    await click(tab("Film"));
    expect(slideshowButton()).toBeNull();
    await mounted!.unmount();
    await show(page([locked(1), film(2)]));
    expect(slideshowButton()).toBeNull();
    await click(tab("Premium"));
    expect(slideshowButton()).toBeNull();
    await mounted!.unmount();
    await show(page([photo(1, { url: null, thumbUrl: null })]));
    expect(slideshowButton()).toBeNull();
  });
  it("opens playing from the first photo, advances once per hold, pauses and resumes, and stops on the last", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await show(page([photo(1), photo(2), photo(3)]));
    await click(slideshowButton()); await tick(50);
    expect(byTestId("delivery-lightbox")).not.toBeNull();
    expect(counter()).toBe("Photo 1 of 3");
    expect(playToggle().textContent).toBe("Pause slideshow");
    await tick(SLIDE_MS); expect(counter()).toBe("Photo 2 of 3");
    await click(playToggle()); expect(playToggle().textContent).toBe("Start slideshow");
    await tick(SLIDE_MS * 3); expect(counter()).toBe("Photo 2 of 3");
    await click(playToggle());
    await tick(SLIDE_MS); expect(counter()).toBe("Photo 3 of 3");
    await tick(SLIDE_MS); expect(playToggle().textContent).toBe("Start slideshow");
  });
  it("steps with previous, next and the arrow keys, and shows no download or unlock controls", async () => {
    await show(page([photo(1), photo(2), photo(3)]));
    await click(slideshowButton()); await until(() => byTestId("delivery-lightbox"));
    await click(byLabel("Next photo")); expect(counter()).toBe("Photo 2 of 3");
    await press("ArrowRight", byTestId("delivery-lightbox")!); expect(counter()).toBe("Photo 3 of 3");
    await click(byLabel("Previous photo")); expect(counter()).toBe("Photo 2 of 3");
    expect(byTestId("delivery-lightbox")!.querySelectorAll("a")).toHaveLength(0);
  });
  it("exits with Exit and with Escape, returns focus to the hero button and stops its timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await show(page([photo(1), photo(2)]));
    slideshowButton()!.focus();
    await click(slideshowButton()); await tick(50);
    await click(byLabel("Exit slideshow")); await tick(500);
    expect(byTestId("delivery-lightbox")).toBeNull();
    expect(document.activeElement).toBe(slideshowButton());
    expect(vi.getTimerCount()).toBe(0);
    await click(slideshowButton()); await tick(50);
    await press("Escape", byTestId("delivery-lightbox")!); await tick(500);
    expect(byTestId("delivery-lightbox")).toBeNull();
    expect(document.activeElement).toBe(slideshowButton());
  });
  it("covers the active tab only, in order, and leaves locked photos out while keeping unlocked Premium ones", async () => {
    await show(page([photo(1), photo(2, { premium: true }), locked(3), photo(4, { premium: true }), photo(5, { url: null, thumbUrl: null }), photo(6)]));
    await click(slideshowButton()); await until(() => byTestId("delivery-lightbox"));
    expect(counter()).toBe("Photo 1 of 2");
    expect(byTestId("delivery-lightbox")!.querySelectorAll('[aria-roledescription="slide"]')).toHaveLength(2);
    await click(byLabel("Exit slideshow")); await flush(8);
    await click(tab("Premium"));
    await click(slideshowButton()); await until(() => byTestId("delivery-lightbox"));
    expect(counter()).toBe("Photo 1 of 2");
    const names = [...byTestId("delivery-lightbox")!.querySelectorAll<HTMLImageElement>("img")].map((img) => img.alt);
    expect(names).not.toContain("Photo 03");
  });
  it("opens a single eligible photo static, with playback disabled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await show(page([photo(1), locked(2, { premium: true })]));
    await click(slideshowButton()); await tick(50);
    expect(counter()).toBe("Photo 1 of 1");
    expect((playToggle() as HTMLButtonElement).disabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("is entered from the normal viewer's Start action over the eligible photos only, at the photo on screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await show(page([photo(1, { premium: true }), locked(2), photo(3, { premium: true }), photo(4, { premium: true })]));
    await click(tab("Premium")); await click(byLabel("Open Photo 04")); await tick(50);
    expect(counter()).toBe("Photo 4 of 4"); // the normal viewer still holds the locked photo
    await click(playToggle()); await tick(50);
    expect(counter()).toBe("Photo 3 of 3"); // Photo 04 of the three eligible
    expect(byTestId("delivery-lightbox")!.querySelectorAll('[aria-roledescription="slide"]')).toHaveLength(3);
    expect(byLabel("Exit slideshow")).not.toBeNull();
  });
  it("starts from the first eligible photo when the normal viewer is on a locked one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await show(page([photo(1, { premium: true }), locked(2)]));
    await click(tab("Premium")); await click(byLabel("Open Photo 02")); await tick(50);
    await click(playToggle()); await tick(50);
    expect(counter()).toBe("Photo 1 of 1");
  });
  it("re-applies eligibility when the page refetches: a re-locked photo drops out, and an emptied slideshow closes", async () => {
    mounted = await render(<Harness initial={page([photo(1), photo(2)])} after={page([photo(1), locked(2)])} />);
    await click(slideshowButton()); await until(() => byTestId("delivery-lightbox"));
    expect(counter()).toBe("Photo 1 of 2");
    await click(byTestId("swap")); await flush();
    expect(counter()).toBe("Photo 1 of 1");
    await mounted.unmount();
    mounted = await render(<Harness initial={page([photo(1)])} after={page([locked(1)])} />);
    await click(slideshowButton()); await until(() => byTestId("delivery-lightbox"));
    await click(byTestId("swap")); await flush(8);
    expect(byTestId("delivery-lightbox")).toBeNull();
  });
  it("labels every control and shows Slideshow in Preview", async () => {
    await show(page([photo(1), photo(2)]), { hrefs: null });
    expect(slideshowButton()).not.toBeNull();
    await click(slideshowButton()); await until(() => byTestId("delivery-lightbox"));
    for (const control of byTestId("delivery-lightbox")!.querySelectorAll<HTMLElement>("button")) expect((control.getAttribute("aria-label") ?? control.textContent ?? "").trim(), control.outerHTML).not.toBe("");
  });
});

describe("share", () => {
  const URL_ = "https://quincy.example/d/12-example-st-23456b";
  const setNav = (key: "share" | "clipboard", value: unknown) => { Object.defineProperty(navigator, key, { value, configurable: true }); };
  const shareButton = () => byTestId("delivery-share");
  const status = () => byTestId("delivery-share-status")!.textContent;
  afterEach(() => { Reflect.deleteProperty(navigator, "share"); Reflect.deleteProperty(navigator, "clipboard"); });
  it("is a hero button, and Preview (no share address) has none", async () => {
    await show(page([photo(1)]), { shareUrl: URL_ });
    expect(byTestId("delivery-hero")!.contains(shareButton())).toBe(true);
    expect(shareButton()!.textContent).toContain("Share");
    await mounted!.unmount();
    await show(page([photo(1)]));
    expect(shareButton()).toBeNull();
  });
  it("calls the native share sheet with the page address from the click, and copies nothing", async () => {
    const share = vi.fn(async () => undefined); const writeText = vi.fn(async () => undefined);
    setNav("share", share); setNav("clipboard", { writeText });
    await show(page([photo(1)]), { shareUrl: URL_ });
    await click(shareButton());
    expect(share).toHaveBeenCalledWith({ title: "12 Example St", url: URL_ });
    expect(writeText).not.toHaveBeenCalled();
  });
  it("copies the address and says so where there is no native share", async () => {
    const writeText = vi.fn(async () => undefined); setNav("clipboard", { writeText });
    await show(page([photo(1)]), { shareUrl: URL_ });
    await click(shareButton()); await flush();
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(status()).toBe("Link copied.");
    expect(byTestId("delivery-share-status")!.getAttribute("role")).toBe("status");
  });
  it("treats cancelling the share sheet as nothing: no copy and no message", async () => {
    const writeText = vi.fn(async () => undefined);
    setNav("share", vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); })); setNav("clipboard", { writeText });
    await show(page([photo(1)]), { shareUrl: URL_ });
    await click(shareButton()); await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(status()).toBe("");
  });
  it("offers an explicit Copy link when the native share fails, and copies on that press", async () => {
    const writeText = vi.fn(async () => undefined);
    setNav("share", vi.fn(async () => { throw new DOMException("no", "NotAllowedError"); })); setNav("clipboard", { writeText });
    await show(page([photo(1)]), { shareUrl: URL_ });
    await click(shareButton()); await flush();
    expect(writeText).not.toHaveBeenCalled();
    const retry = byTestId("delivery-share-copy")!;
    expect(retry.textContent).toBe("Copy link");
    await click(retry); await flush();
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(status()).toBe("Link copied.");
  });
  it("returns focus to Share when the Copy link button unmounts after a copy", async () => {
    setNav("share", vi.fn(async () => { throw new DOMException("no", "NotAllowedError"); })); setNav("clipboard", { writeText: vi.fn(async () => undefined) });
    await show(page([photo(1)]), { shareUrl: URL_ });
    await click(shareButton()); await flush();
    const retry = byTestId("delivery-share-copy")!; retry.focus();
    await click(retry); await flush();
    expect(byTestId("delivery-share-copy")).toBeNull();
    expect(document.activeElement).toBe(shareButton());
  });
  it("clears the Link copied status after a few seconds, inside a live region", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    setNav("clipboard", { writeText: vi.fn(async () => undefined) });
    await show(page([photo(1)]), { shareUrl: URL_ });
    await click(shareButton()); await tick(10);
    expect(status()).toBe("Link copied.");
    await tick(1500); expect(status()).toBe("Link copied.");
    await tick(3000); expect(status()).toBe("");
    expect(byTestId("delivery-share-status")!.getAttribute("role")).toBe("status");
  });
  it("shows an inline error, never a success, when the clipboard rejects or is absent", async () => {
    setNav("clipboard", { writeText: vi.fn(async () => { throw new Error("denied"); }) });
    await show(page([photo(1)]), { shareUrl: URL_ });
    await click(shareButton()); await flush();
    expect(status()).toMatch(/couldn't copy/i);
    await mounted!.unmount();
    setNav("clipboard", undefined);
    await show(page([photo(1)]), { shareUrl: URL_ });
    await click(shareButton()); await flush();
    expect(status()).toMatch(/couldn't copy/i);
  });
  it("ignores a second press while one is pending, and a completion after unmount", async () => {
    let finish: () => void = () => undefined;
    const share = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })); setNav("share", share);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await show(page([photo(1)]), { shareUrl: URL_ });
    await click(shareButton()); await click(shareButton());
    expect(share).toHaveBeenCalledTimes(1);
    await mounted!.unmount(); mounted = null;
    await act(async () => { finish(); await Promise.resolve(); });
    expect(errors).not.toHaveBeenCalled(); errors.mockRestore();
  });
});
