import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { L1, NOW, TEASER, WALK, all, button, buttonIn, checkbox, dialog, linkOf, mount, openList, press, q, selectFilms, state, text, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/** #741 11b second-round design-review fixes: focus return after a create, the bar clearance, legends, the locked-Version hint, the header edge, the button's place. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "44444444-4444-4444-8444-444444444444", role: "editor" } }, isPending: false }) }));
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));
const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
  state.links = [linkOf()]; state.videos = [WALK, TEASER];
  apiGetMock.mockReset(); apiPostMock.mockReset();
  apiGetMock.mockImplementation(async (path) => {
    if (path.endsWith("/review-links")) return { links: state.links };
    if (path.endsWith("/videos")) return { videos: state.videos };
    throw new Error(`unrouted ${path}`);
  });
});
afterEach(async () => { await unmount(); resetVideoUploadStore(); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });

const escape = async () => { await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); await act(async () => { await Promise.resolve(); }); };
const bar = () => q('[data-testid="review-link-selection-bar"]');
const openCreate = async () => { await selectFilms("Main walkthrough"); await press(buttonIn(bar(), "Create Review link")); };
const labelledBy = (el: Element | null) => { const id = el?.getAttribute("aria-labelledby"); return id ? document.getElementById(id) : null; };

describe("focus after a create", () => {
  it("lands on the Review links button, not the sheet, after Create > Done > All links > Escape", async () => {
    apiPostMock.mockResolvedValue({ link: linkOf(), url: `https://quincy.test/d/review?link=${L1}#t=tok123` });
    await mount();
    const opener = q<HTMLButtonElement>('[data-testid="review-links-open"]')!;
    await openCreate();
    await press(buttonIn(dialog(), "Create link"));
    await press(buttonIn(dialog(), "Done"));
    await press(buttonIn(q('[data-testid="review-link-detail"]'), "All links"));
    await escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("the selection bar's clearance", () => {
  it("pads the end of the Video tab (the wrapper holding the Films AND the Video links section) by the measured bar height plus a space-4 while the bar shows", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.dataset["testid"] === "review-link-selection-bar" ? 80 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) };
    });
    await mount();
    const body = q('[data-testid="video-links-section"]')!.parentElement!;
    expect(body.contains(q('[data-testid="video-collection-body"]'))).toBe(true);
    expect(q('[data-testid="video-collection-body"]')!.className).not.toContain("review-bar-clearance");
    const clearance = () => body.style.getPropertyValue("--review-bar-clearance");
    expect(clearance()).toBe("");
    await selectFilms("Main walkthrough");
    expect(clearance()).toContain("80px");
    expect(clearance()).toContain("--space-4");
    await press(buttonIn(bar(), "Clear"));
    expect(clearance()).toBe("");
  });
});

describe("Create's legends and hints", () => {
  it("shows 'What guests can do' and 'Versions' as visible legends that name their groups", async () => {
    await mount(); await openCreate();
    const guests = q('[role="group"][aria-labelledby]', dialog())!;
    expect(labelledBy(guests)?.textContent).toBe("What guests can do");
    const groups = all('[role="group"][aria-labelledby]', dialog()).map((g) => labelledBy(g)?.textContent);
    expect(groups).toContain("Versions");
  });
  it("explains a locked Version per film, and drops the hint once a second Version is ticked", async () => {
    await mount(); await openCreate();
    const film = q('[data-testid="review-link-create-video"]', dialog())!;
    const hint = "A film needs at least one Version. Remove the film to stop sharing it.";
    expect(text(film)).toContain(hint);
    const locked = checkbox("Main walkthrough v2", film)!;
    expect(locked.disabled).toBe(true);
    expect(document.getElementById(locked.getAttribute("aria-describedby")!)?.textContent).toBe(hint);
    await press(checkbox("Main walkthrough v1", film));
    expect(text(film)).not.toContain(hint);
  });
});

describe("the dialog header's edge", () => {
  it("is marked scrolled once the body has scrolled, and not before", async () => {
    await mount(); await openList();
    const header = q('[data-testid="review-links-dialog-header"]', dialog())!;
    const body = q<HTMLElement>('[data-testid="review-links-dialog-body"]', dialog())!;
    expect(header.getAttribute("data-scrolled")).toBe("false");
    await act(async () => { body.scrollTop = 40; body.dispatchEvent(new Event("scroll", { bubbles: true })); });
    expect(header.getAttribute("data-scrolled")).toBe("true");
    await act(async () => { body.scrollTop = 0; body.dispatchEvent(new Event("scroll", { bubbles: true })); });
    expect(header.getAttribute("data-scrolled")).toBe("false");
  });
});

describe("the Review links button", () => {
  it("sits in the Films header", async () => {
    await mount();
    expect(q('[data-testid="video-films-header"]')!.contains(q('[data-testid="review-links-open"]'))).toBe(true);
    expect(button("Review links")).toBeDefined();
  });
});

describe("Create's permission copy", () => {
  it("calls the people on a link Guests on every row, Download included", async () => {
    await mount(); await openCreate();
    const hints = text(dialog());
    expect(hints).toContain("Guests can download a film");
    expect(hints).not.toContain("Clients can");
  });
});
