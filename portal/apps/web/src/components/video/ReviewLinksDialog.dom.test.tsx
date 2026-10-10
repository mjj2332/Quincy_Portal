import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVideoUploadStore } from "../../lib/video-upload-store";
import { L1, NOW, PROJECT, TEASER, WALK, all, button, buttonIn, checkbox, dialog, linkOf, mount, openDetailOf, openList, press, q, selectFilms, state, text, unmount } from "@/testing/review-links-harness";
import "@/testing/dom-polyfills";

/**
 * #741 11b design-review fixes: the dialog's chrome (Escape, focus return, the close control, the scrolling body), the passcode hint's
 * wiring, the locked passcode line and the film/films copy. The API is mocked at `lib/api`.
 */
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
afterEach(async () => { await unmount(); resetVideoUploadStore(); document.body.replaceChildren(); vi.useRealTimers(); });

const escape = async () => { await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }); await act(async () => { await Promise.resolve(); }); };
const bar = () => q('[data-testid="review-link-selection-bar"]');
const openCreate = async () => { await selectFilms("Main walkthrough"); await press(buttonIn(bar(), "Create Review link")); };

describe("Escape", () => {
  it("closes the list", async () => {
    await mount(); await openList();
    expect(dialog()).not.toBeNull();
    await escape();
    expect(dialog()).toBeNull();
  });
  it("closes the create view and keeps the draft", async () => {
    await mount(); await openCreate();
    expect(text(dialog())).toContain("Create Review link");
    await escape();
    expect(dialog()).toBeNull();
    expect(checkbox("Select Main walkthrough")!.checked).toBe(true);
  });
  it("closes a link's detail", async () => {
    await mount(); await openDetailOf("Smith family");
    expect(q('[data-testid="review-link-detail"]')).not.toBeNull();
    await escape();
    expect(dialog()).toBeNull();
  });
  it("closes the one-time reveal (the store holds the URL until it is dismissed; closing is the same as Done)", async () => {
    apiPostMock.mockResolvedValue({ link: linkOf(), url: `https://quincy.test/d/review?link=${L1}#t=tok123` });
    await mount(); await openCreate();
    await press(buttonIn(dialog(), "Create link"));
    expect(q('[data-testid="review-link-reveal"]')).not.toBeNull();
    await escape();
    expect(dialog()).toBeNull();
    expect(q('[data-testid="review-link-reveal"]')).toBeNull();
  });
});

describe("focus returns to what opened the dialog", () => {
  it("the header Review links button", async () => {
    await mount();
    const opener = q<HTMLButtonElement>('[data-testid="review-links-open"]')!;
    await openList();
    await escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("the selection bar's Create Review link", async () => {
    await mount(); await selectFilms("Main walkthrough");
    const opener = buttonIn(bar(), "Create Review link")!;
    await press(opener);
    await escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("a card chip", async () => {
    await mount();
    const chip = buttonIn(q('[data-testid="video-card-link-chips"]', all('[data-testid="video-card"]')[0]!), /Smith family/)!;
    await press(chip);
    expect(q('[data-testid="review-link-detail"]')).not.toBeNull();
    await escape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});

describe("the dialog's chrome", () => {
  it("scrolls in an inner body; the close control and the footer sit outside it", async () => {
    await mount(); await openCreate();
    const d = dialog()!;
    const body = q('[data-testid="review-links-dialog-body"]', d)!;
    expect(body).not.toBeNull();
    expect(body.className).toContain("overflow-y-auto");
    expect(d.className).toContain("flex-col");
    expect(d.className).not.toContain("overflow-y-auto");
    expect(body.contains(q('[data-testid="review-links-dialog-close"]', d))).toBe(false);
    expect(body.contains(buttonIn(d, "Create link")!)).toBe(false);
  });
  it("has one close control, 44px at phone width, that closes the dialog", async () => {
    await mount(); await openList();
    const closes = all<HTMLButtonElement>("button", dialog()).filter((b) => b.getAttribute("aria-label") === "Close" || b.textContent === "Close");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.className).toContain("max-[721px]:size-11");
    await press(closes[0]);
    expect(dialog()).toBeNull();
  });
  it("is not as wide as the 1320px xl container", async () => {
    await mount(); await openList();
    expect(dialog()!.className).not.toContain("max-w-xl");
    expect(dialog()!.className).toMatch(/max-w-\[(560|820)px\]/);
  });
  it("titles its steps in the display font", async () => {
    await mount(); await openList();
    expect(q('[data-slot="dialog-title"]', dialog())!.className).toContain("font-[family-name:var(--font-display)]");
  });
});

describe("the passcode hint", () => {
  it("is described by the hint, in the create view", async () => {
    await mount(); await openCreate();
    const input = q<HTMLInputElement>("#review-link-passcode", dialog())!;
    const hint = document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[0]!);
    expect(hint?.textContent).toContain("Guests are asked for it");
  });
  it("is described by the hint, in the detail, with and without a passcode set", async () => {
    await mount(); await openDetailOf("Smith family");
    let input = q<HTMLInputElement>("#review-link-detail-passcode", dialog())!;
    expect(document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[0]!)?.textContent).toContain("No passcode");
    await unmount();
    state.links = [linkOf({ hasPasscode: true })];
    await mount(); await openDetailOf("Smith family");
    input = q<HTMLInputElement>("#review-link-detail-passcode", dialog())!;
    expect(document.getElementById(input.getAttribute("aria-describedby")!.split(" ")[0]!)?.textContent).toContain("A passcode is set");
  });
});

describe("a locked passcode", () => {
  it("on a revoked link says only that one is set, with no invitation to type", async () => {
    state.links = [linkOf({ hasPasscode: true, status: "revoked", revokedAt: "2026-10-09T05:00:00.000Z" })];
    await mount(); await openDetailOf("Smith family");
    const detail = q('[data-testid="review-link-detail"]')!;
    expect(q<HTMLInputElement>("#review-link-detail-passcode", detail)!.disabled).toBe(true);
    expect(text(detail)).toContain("A passcode is set.");
    expect(text(detail)).not.toContain("Type a new one");
  });
});

describe("copy says film, not Video", () => {
  it("counts films in the list and names a film in the detail", async () => {
    await mount(); await openList();
    expect(text(q('[data-testid="review-link-row"]'))).toContain("1 film");
    expect(text(q('[data-testid="review-link-row"]'))).not.toContain("Video");
    await press(button("Manage Smith family"));
    const detail = q('[data-testid="review-link-detail"]')!;
    expect(text(detail)).toContain("Remove the film to stop sharing it.");
    expect(button("Add a film")).toBeDefined();
    await press(buttonIn(detail, "Remove Main walkthrough from link"));
    expect(text(q('[data-testid="review-link-confirm"]'))).toContain("Remove film");
    expect(text(q('[data-testid="review-link-confirm"]'))).not.toContain("Remove Video");
  });
});

describe("one reveal title", () => {
  it("is 'Review link ready' for create and for replace, and replace says so in the description", async () => {
    apiPostMock.mockResolvedValue({ link: linkOf(), url: `https://quincy.test/d/review?link=${L1}#t=tok123` });
    await mount(); await openCreate();
    await press(buttonIn(dialog(), "Create link"));
    expect(text(q('[data-slot="dialog-title"]', dialog()))).toBe("Review link ready");
    expect(text(q('[data-testid="review-link-reveal"]'))).not.toContain("This replaces the old link.");
    await press(buttonIn(dialog(), "Done"));
    await press(buttonIn(q('[data-testid="review-link-detail"]'), "Replace link"));
    await press(buttonIn(q('[data-testid="review-link-confirm"]'), "Replace"));
    expect(text(q('[data-slot="dialog-title"]', dialog()))).toBe("Review link ready");
    expect(text(q('[data-testid="review-link-reveal"]'))).toContain("This replaces the old link.");
  });
});
