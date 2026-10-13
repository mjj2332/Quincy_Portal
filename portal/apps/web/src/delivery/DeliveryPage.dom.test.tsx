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
  it("offers Review & feedback as a new-tab link only on an unlocked film that carries a review entry (#847)", async () => {
    const url = "/d/review?link=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#t=secret&v=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await show(page([film(1, { review: { url } }), film(2), locked(3, { kind: "video", review: null })])); await click(tab("Film"));
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a")].filter((a) => a.textContent === "Review & feedback");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe(url);
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0]!.getAttribute("aria-label")).toBe("Review & feedback for Video 01, opens in a new tab");
    expect(links[0]!.hasAttribute("download")).toBe(false);
    expect(links[0]!.closest("li")!.querySelector("video")).not.toBeNull();
    for (const tile of document.querySelectorAll('[data-testid="delivery-locked"]')) expect(tile.querySelector("a")).toBeNull();
  });
  it("pauses when the tab changes and when the page goes away", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      await show(page([photo(1), film(2)])); await click(tab("Film"));
      const video = document.querySelector("video");
      pause.mockClear();
      await click(tab("Gallery"));
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

describe("film frame (#848)", () => {
  const ratio = (el: Element | null | undefined) => (el as HTMLElement).style.getPropertyValue("--film-ratio");
  it("gives the video its own shape as a CSS variable, never an inline aspect-ratio that would beat the container rule", async () => {
    await show(page([film(1, { width: 1080, height: 1920 }), film(2, { width: null, height: null })])); await click(tab("Film"));
    const [vertical, unknown] = [...document.querySelectorAll("video")];
    expect(ratio(vertical)).toBe("1080 / 1920");
    expect(vertical!.style.getPropertyValue("aspect-ratio")).toBe("");
    expect(ratio(unknown)).toBe("");
    expect(unknown!.style.getPropertyValue("aspect-ratio")).toBe("");
  });
  it("keeps the same frame after a playback error and on a locked film", async () => {
    await show(page([film(1, { width: 1080, height: 1920 }), locked(2, { kind: "video", label: "Video 02", width: 1080, height: 1920, url: null, thumbUrl: null })]));
    await click(tab("Film"));
    await act(async () => { document.querySelector("video")!.dispatchEvent(new Event("error")); });
    const failed = byTestId("delivery-film-failed")!;
    expect(ratio(failed)).toBe("1080 / 1920");
    expect(failed.style.getPropertyValue("aspect-ratio")).toBe("");
    await click(tab("Premium"));
    const frame = byTestId("delivery-locked")!.firstElementChild;
    expect(ratio(frame)).toBe("1080 / 1920");
    expect((frame as HTMLElement).style.getPropertyValue("aspect-ratio")).toBe("");
  });
  it("still renders every tile's content on a mixed page", async () => {
    await show(page([film(1), film(2, { width: 1080, height: 1920 }), film(3, { url: null }), locked(4, { kind: "video", label: "Video 04", url: null, thumbUrl: null })]));
    await click(tab("Film"));
    expect(document.querySelectorAll("video")).toHaveLength(2);
    expect(allByTestId("delivery-film-failed")).toHaveLength(1);
    for (const label of ["Video 01", "Video 02", "Video 03"]) expect(document.querySelector(`a[aria-label="Download ${label}, original"]`), label).not.toBeNull();
    expect(document.body.textContent).toContain("1:02");
    await click(tab("Premium"));
    const panel = byTestId("delivery-panel-premium")!;
    expect(panel.textContent).toContain("Video 04"); expect(panel.textContent).toContain("Premium");
    expect([...panel.querySelectorAll("button")].some((b) => b.textContent === "Request unlock")).toBe(true);
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
    const placeholder = byTestId("delivery-locked", panel)!;
    expect(placeholder.textContent).toContain("Video 02"); expect(placeholder.textContent).toContain("Premium");
    expect([...panel.querySelectorAll("[href], [src]")].map((el) => el.getAttribute("href") ?? el.getAttribute("src"))).toEqual([locked(1).thumbUrl]);
    expect(allByTestId("delivery-premium-badge", panel)).toHaveLength(3);
    const [onPhoto, , inRow] = allByTestId("delivery-premium-badge", panel);
    expect(onPhoto!.className).toContain("bg-warning "); expect(onPhoto!.className).not.toContain("bg-warning/10"); // solid over a photo
    expect(inRow!.className).toContain("bg-warning/10"); // tinted in a document row
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
