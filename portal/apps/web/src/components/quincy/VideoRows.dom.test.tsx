import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoRows, videoRowColumnsToFit, videoRowTitleSize, type VideoRowColumn, type VideoRowItem } from "./VideoRows";
import "../../testing/dom-polyfills";

/**
 * #938: the one Video row presentation (`VideoRows`), shared by the staff Video tab (#938, #939), the guest Review link page (#940) and the Delivery page (#941). This suite pins the
 * presentation API every one of them consumes (columns, compact, open by link or action, locked, the select / menu / caption / footer / drop slots, `rowAttrs`, the sort header);
 * the staff screen's behaviour is pinned through the panel in `components/video/VideoCollectionPanel.rows.dom.test.tsx`.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../LazyImage", () => ({ LazyImage: ({ src, alt, className }: { src: string; alt: string; className?: string }) => <img src={src} alt={alt} className={className} /> }));

let root: Root | null = null; let host: HTMLElement | null = null;
async function mount(node: ReactNode) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(node); });
  return host;
}
async function rerender(node: ReactNode) { await act(async () => { root!.render(node); }); }
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); host?.remove(); root = null; host = null; });

const STAFF: readonly VideoRowColumn[] = ["select", "poster", "title", "status", "notes", "duration", "uploaded", "uploader", "menu"];
const GUEST: readonly VideoRowColumn[] = ["poster", "title", "duration", "notes"];
const TEST_IDS = { row: "video-row", open: "video-row-open" };
const film = (over: Partial<VideoRowItem> = {}): VideoRowItem => ({
  id: "v1", title: "Kitchen walkthrough", posterUrl: "/poster/v1.jpg", version: 3, durationMs: 92_000, openNotes: 2,
  status: { tone: "caution", short: "In review", full: "In review" }, uploadedAt: "2026-10-09T01:00:00.000Z", uploader: { name: "Mia Chen" },
  onOpen: () => undefined, ...over,
} as VideoRowItem);
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="video-row"]')];
const opens = () => [...document.querySelectorAll<HTMLElement>('[data-testid="video-row-open"]')];
const headers = () => [...document.querySelectorAll("th")].map((th) => th.textContent?.trim());
const cellsOf = (row: Element) => [...row.querySelectorAll("td")];

describe("VideoRows — the table (#938)", () => {
  it("draws a header and one row per item, each column's facts in its own cell", async () => {
    await mount(<VideoRows items={[film(), film({ id: "v2", title: "Teaser", version: 1, durationMs: 3_725_000, openNotes: 0, status: { tone: "positive", short: "Approved", full: "Approved (internal)" }, uploader: { name: "Sam Lee" } })]} columns={STAFF} label="Films" testIds={TEST_IDS} />);
    expect(document.querySelector('[data-testid="video-rows"]')!.getAttribute("aria-label")).toBe("Films");
    expect(document.querySelector('section[aria-label="Films"] table')).not.toBeNull();
    expect(headers()).toEqual(["Select", "Poster", "Title", "Status", "Notes", "Duration", "Uploaded", "Uploader", "Actions"]);
    expect(rows()).toHaveLength(2);
    const [first, second] = rows().map(cellsOf);
    expect(first![2]!.textContent).toContain("Kitchen walkthrough");
    expect(first![2]!.textContent).toContain("v3");
    expect(first![3]!.textContent).toContain("In review");
    expect(first![4]!.textContent).toContain("2");
    expect(first![5]!.textContent).toBe("1:32");
    expect(first![6]!.textContent).toBe("9 Oct 2026");
    expect(first![7]!.textContent).toContain("Mia Chen");
    expect(first![7]!.querySelector('[data-testid="initials-avatar"]')!.textContent).toBe("MC");
    expect(second![4]!.textContent).toBe("");
    expect(second![5]!.textContent).toBe("1:02:05");
    expect(second![3]!.textContent).toContain("Approved");
    expect(second![3]!.textContent).toContain("Approved (internal)");
  });

  it("draws only the columns asked for: the guest set has no status, uploader, tick or menu", async () => {
    // A guest item carries no status or uploader at all (the guest data has none); the column set is what keeps the table's shape.
    await mount(<VideoRows items={[film({ status: undefined, uploader: undefined, uploadedAt: undefined } as Partial<VideoRowItem>)]} columns={GUEST} label="Films" testIds={TEST_IDS} />);
    expect(headers()).toEqual(["Poster", "Title", "Duration", "Notes"]);
    expect(document.body.textContent).not.toContain("Mia Chen");
    expect(document.body.textContent).not.toContain("In review");
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("opens by its one stretched control: a button calls onOpen with itself, Enter included", async () => {
    const onOpen = vi.fn();
    await mount(<VideoRows items={[film({ onOpen })]} columns={STAFF} label="Films" testIds={TEST_IDS} />);
    const open = opens()[0]!;
    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("type")).toBe("button");
    expect(open.textContent).toBe("Kitchen walkthrough");
    expect(open.className).toContain("after:inset-0");
    expect(rows()[0]!.className).toContain("relative");
    expect(document.getElementById(open.getAttribute("aria-describedby")!)!.textContent).toBe("v3, 1:32, 2 open notes on v3, In review");
    await act(async () => { open.click(); });
    expect(onOpen).toHaveBeenCalledWith(open);
  });

  it("opens by a same-tab link when given an href", async () => {
    await mount(<VideoRows items={[film({ onOpen: undefined, href: "/d/review?link=1" } as Partial<VideoRowItem>)]} columns={GUEST} label="Films" testIds={TEST_IDS} />);
    const open = opens()[0]!;
    expect(open.tagName).toBe("A");
    expect(open.getAttribute("href")).toBe("/d/review?link=1");
    expect(open.getAttribute("target")).toBeNull();
  });

  it("a locked row shows a lock, no Version, duration or count, its caption under the title, and an inert-but-focusable open control when told", async () => {
    const onOpen = vi.fn();
    await mount(<VideoRows items={[film({ locked: true, version: null, durationMs: null, openNotes: null, posterUrl: null, openLabel: "Unlock requested: Kitchen walkthrough", openDisabled: true, onOpen, caption: <span>Unlock requested</span>, menu: <span>Premium</span> })]} columns={GUEST} label="Films" testIds={TEST_IDS} tone="paper" />);
    const row = rows()[0]!;
    expect(row.querySelector('[data-testid="video-row-locked"]')).not.toBeNull();
    expect(row.textContent).not.toContain("v3");
    expect(row.textContent).not.toContain("1:32");
    expect(row.textContent).toContain("Unlock requested");
    const open = opens()[0]!;
    expect(open.getAttribute("aria-label")).toBe("Unlock requested: Kitchen walkthrough");
    expect(open.getAttribute("aria-disabled")).toBe("true");
    await act(async () => { open.click(); });
    expect(onOpen).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="video-rows"]')!.getAttribute("data-tone")).toBe("paper");
  });

  it("the tick, the menu and the footer sit above the stretched control as their own controls", async () => {
    const onToggle = vi.fn();
    await mount(<VideoRows items={[film({ select: { selected: true, onToggle }, menu: <button type="button">Film actions</button>, footer: <p>Uploading v4 · 42%</p>, premium: true, linked: true })]} columns={STAFF} label="Films" testIds={TEST_IDS} />);
    const row = rows()[0]!;
    const tick = row.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Select Kitchen walkthrough"]')!;
    expect(tick.checked).toBe(true);
    expect(tick.closest("label")!.className).toContain("z-[1]");
    await act(async () => { tick.click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect([...row.querySelectorAll("button")].find((b) => b.textContent === "Film actions")!.parentElement!.className).toContain("z-[1]");
    const footer = [...row.querySelectorAll("p")].find((p) => p.textContent === "Uploading v4 · 42%")!;
    expect(footer.parentElement!.className).toContain("z-[1]");
    expect(row.getAttribute("data-selected")).toBe("true");
    expect(row.textContent).toContain("Premium");
    expect(row.textContent).toContain("On a Review link");
  });

  it("draws the caller's Premium mark in place of the neutral one, on a premium or a locked row (story 54)", async () => {
    await mount(<VideoRows items={[
      film({ premium: true, premiumBadge: <span data-testid="caller-premium">Premium</span> }),
      film({ id: "v2", title: "Teaser", locked: true, version: null, durationMs: null, openNotes: null, premiumBadge: <span data-testid="caller-premium">Premium</span> }),
      film({ id: "v3", title: "Plain", premium: true }),
    ]} columns={GUEST} label="Films" testIds={TEST_IDS} />);
    const [premium, locked, plain] = rows();
    for (const row of [premium!, locked!]) {
      expect(row.querySelector('[data-testid="caller-premium"]')).not.toBeNull();
      expect([...row.querySelectorAll("span")].filter((mark) => mark.textContent === "Premium")).toHaveLength(1);
    }
    expect(plain!.querySelector('[data-testid="caller-premium"]')).toBeNull();
    expect(plain!.textContent).toContain("Premium");
  });

  it("puts rowAttrs on the row and the video id on the row and its open control", async () => {
    await mount(<VideoRows items={[film({ dataVideoId: "v1", rowAttrs: { "data-handle": "film-1" } })]} columns={GUEST} label="Films" testIds={{ row: "delivery-film-item", open: "delivery-film-open" }} />);
    const row = document.querySelector<HTMLElement>('[data-testid="delivery-film-item"]')!;
    expect(row.tagName).toBe("TR");
    expect(row.getAttribute("data-handle")).toBe("film-1");
    expect(row.getAttribute("data-video-id")).toBe("v1");
    expect(row.querySelector('[data-testid="delivery-film-open"]')!.getAttribute("data-video-id")).toBe("v1");
  });

  it("takes a dropped file on the whole row as the next Version, showing the drop state while a file is over it", async () => {
    const onFile = vi.fn();
    await mount(<VideoRows items={[film({ drop: { nextVersion: 4, onFile, disabled: false } })]} columns={STAFF} label="Films" testIds={TEST_IDS} />);
    const row = rows()[0]!;
    const file = new File(["x"], "cut.mp4", { type: "video/mp4" });
    const transfer = { types: ["Files"], files: [file] };
    const drag = (type: string) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, "dataTransfer", { value: transfer }); return event; };
    const outer = vi.fn();
    document.body.addEventListener("drop", outer);
    await act(async () => { cellsOf(row)[8]!.dispatchEvent(drag("dragenter")); });
    expect(row.getAttribute("data-dragging")).toBe("true");
    expect(row.textContent).toContain("Drop to upload v4");
    await act(async () => { cellsOf(row)[8]!.dispatchEvent(drag("drop")); });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(row.getAttribute("data-dragging")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener("drop", outer);
  });

  it("a row with no drop leaves a dropped file to whatever is around it", async () => {
    await mount(<VideoRows items={[film()]} columns={STAFF} label="Films" testIds={TEST_IDS} />);
    const outer = vi.fn();
    document.body.addEventListener("drop", outer);
    await act(async () => { rows()[0]!.dispatchEvent(new Event("drop", { bubbles: true })); });
    expect(outer).toHaveBeenCalledTimes(1);
    document.body.removeEventListener("drop", outer);
  });
});

describe("VideoRows — the sort header (#938 for #939)", () => {
  it("marks the sorted column and offers a sort on the sortable headers only, reporting the key a header was pressed for", async () => {
    const onSort = vi.fn();
    const sort = { key: "title" as const, dir: "asc" as const, sortable: ["title", "status", "uploaded"] as const, onSort };
    await mount(<VideoRows items={[film()]} columns={STAFF} label="Films" testIds={TEST_IDS} sort={sort} />);
    const th = (name: string) => [...document.querySelectorAll("th")].find((cell) => cell.textContent?.trim() === name)!;
    expect(th("Title").getAttribute("aria-sort")).toBe("ascending");
    expect(th("Status").getAttribute("aria-sort")).toBe("none");
    expect(th("Duration").getAttribute("aria-sort")).toBeNull();
    expect(th("Duration").querySelector("button")).toBeNull();
    await act(async () => { th("Status").querySelector("button")!.click(); });
    expect(onSort).toHaveBeenLastCalledWith("status");
    await act(async () => { th("Title").querySelector("button")!.click(); });
    expect(onSort).toHaveBeenLastCalledWith("title");
    await rerender(<VideoRows items={[film()]} columns={STAFF} label="Films" testIds={TEST_IDS} sort={{ ...sort, key: "uploaded", dir: "desc" }} />);
    expect(th("Uploaded").getAttribute("aria-sort")).toBe("descending");
    expect(th("Title").getAttribute("aria-sort")).toBe("none");
  });

  it("has no sort control at all without a sort", async () => {
    await mount(<VideoRows items={[film()]} columns={STAFF} label="Films" testIds={TEST_IDS} />);
    expect(document.querySelector("thead button")).toBeNull();
  });
});

describe("VideoRows — compact (phone)", () => {
  it("is a list of two-line rows: poster, title, then Version · duration · status, with the tick and menu; no uploader, date or notes", async () => {
    await mount(<VideoRows compact items={[film({ select: { selected: false, onToggle: () => undefined }, menu: <button type="button">Film actions</button> })]} columns={STAFF} label="Films" testIds={TEST_IDS} />);
    expect(document.querySelector("table")).toBeNull();
    expect(document.querySelector('section[aria-label="Films"] ul')).not.toBeNull();
    const row = rows()[0]!;
    expect(row.tagName).toBe("LI");
    expect(row.className).toContain("relative");
    expect(row.querySelector('[data-testid="video-row-meta"]')!.textContent).toBe("v3 · 1:32 · In review");
    expect(row.textContent).not.toContain("Mia Chen");
    expect(row.textContent).not.toContain("9 Oct 2026");
    expect(row.querySelector('input[aria-label="Select Kitchen walkthrough"]')).not.toBeNull();
    expect(row.querySelector("img")).not.toBeNull();
    expect(opens()[0]!.className).toContain("after:inset-0");
  });

  it("leaves status out of the meta line when the screen has no status column (guest, delivery)", async () => {
    await mount(<VideoRows compact items={[film()]} columns={GUEST} label="Films" testIds={TEST_IDS} />);
    expect(rows()[0]!.querySelector('[data-testid="video-row-meta"]')!.textContent).toBe("v3 · 1:32");
  });
});

describe("videoRowColumnsToFit (S8)", () => {
  const all = STAFF;
  it("drops nothing when the width is unknown (0) or everything fits", () => {
    expect(videoRowColumnsToFit(all, 0)).toEqual(all);
    expect(videoRowColumnsToFit(all, 4000)).toEqual(all);
  });
  // Fitted against the title's 240px floor (plan D5), not its 280px unmeasured size: the staff set needs 1032px; uploader is 180, uploaded 120, notes 80.
  const droppedAt = (width: number) => all.filter((column) => !videoRowColumnsToFit(all, width).includes(column));
  it("drops uploader, then uploaded, then notes, and never the title", () => {
    expect(droppedAt(1032)).toEqual([]);
    expect(droppedAt(1031)).toEqual(["uploader"]);
    expect(droppedAt(852)).toEqual(["uploader"]);
    expect(droppedAt(851)).toEqual(["uploaded", "uploader"]);
    expect(droppedAt(732)).toEqual(["uploaded", "uploader"]);
    expect(droppedAt(731)).toEqual(["notes", "uploaded", "uploader"]);
    expect(droppedAt(320)).toEqual(["notes", "uploaded", "uploader"]);
  });
  // F10: the Project sheet at 768 gives the panel 652px; tick 68 (its 16px edge), poster 80, title 240, status 128, duration 76, ⋯ 60 (its edge) is exactly that.
  it("fits the staff set at the Project sheet's 652px panel with nothing dropped past notes", () => {
    expect(droppedAt(652)).toEqual(["notes", "uploaded", "uploader"]);
    expect(videoRowTitleSize(videoRowColumnsToFit(all, 652), 652)).toBe(240);
  });
  it("skips a column the set does not have, and counts the table edge on whichever column is first or last", () => {
    // Poster opens the guest set (88 with the edge) and notes closes it (88): 88 + 240 + 76 + 88. Without notes, duration takes the edge (84).
    expect(videoRowColumnsToFit(["poster", "title", "duration", "notes"], 492)).toEqual(["poster", "title", "duration", "notes"]);
    expect(videoRowColumnsToFit(["poster", "title", "duration", "notes"], 491)).toEqual(["poster", "title", "duration"]);
    expect(videoRowTitleSize(["poster", "title", "duration"], 412)).toBe(240);
  });
});

describe("videoRowTitleSize", () => {
  const fitted: readonly VideoRowColumn[] = ["select", "poster", "title", "status", "notes", "duration", "uploaded", "menu"]; // 612px besides the title
  it("is the title's 280px while the width is unmeasured", () => {
    expect(videoRowTitleSize(fitted, 0)).toBe(280);
  });
  it("takes every pixel the other columns leave, so the table is exactly as wide as the panel", () => {
    expect(videoRowTitleSize(fitted, 1000)).toBe(388);
    expect(videoRowTitleSize(fitted, 852)).toBe(240);
  });
  it("never goes below its 240px floor: the table is then wider than the panel and scrolls", () => {
    expect(videoRowTitleSize(fitted, 700)).toBe(240);
  });
});

describe("VideoRows — width (S8, #933 fix round 1)", () => {
  const OriginalObserver = globalThis.ResizeObserver;
  let width = 0;
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) { this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => { globalThis.ResizeObserver = OriginalObserver; });
  const th = (name: string) => [...document.querySelectorAll("th")].find((cell) => cell.textContent?.trim() === name)!;
  const widths = () => [...document.querySelectorAll("th")].map((cell) => Number.parseFloat(cell.style.width));
  const staffFilm = () => film({ select: { selected: false, onToggle: () => undefined }, menu: <button type="button">Film actions</button> });

  it("gives the title the width the other columns leave, the table exactly the panel's width", async () => {
    width = 1000;
    await mount(<VideoRows items={[staffFilm()]} columns={STAFF} label="Films" testIds={TEST_IDS} />);
    expect(headers()).not.toContain("Uploader");
    expect(th("Title").style.width).toBe("388px");
    expect(widths().reduce((sum, w) => sum + w, 0)).toBe(1000);
  });

  it("at the Project sheet's 768px (a 652px panel) fills the panel exactly with the title at its floor: nothing to scroll, Actions in view (F10)", async () => {
    width = 652;
    await mount(<VideoRows items={[staffFilm()]} columns={STAFF} label="Films" testIds={TEST_IDS} />);
    expect(headers()).toEqual(["Select", "Poster", "Title", "Status", "Duration", "Actions"]);
    expect(widths()).toEqual([68, 80, 240, 128, 76, 60]);
    expect(widths().reduce((sum, w) => sum + w, 0)).toBe(652);
    // Narrower still, the table keeps its floor inside the data-grid's horizontal scroll area.
    const scroller = document.querySelector('[data-testid="video-rows-scroll"]');
    expect(scroller!.querySelector("table")).not.toBeNull();
  });

  it("gives the poster the table's edge where it opens the set (guest, delivery): 88, the 64px thumb with 16px before it", async () => {
    width = 600;
    await mount(<VideoRows items={[film()]} columns={GUEST} label="Films" testIds={TEST_IDS} />);
    expect(headers()).toEqual(["Poster", "Title", "Duration", "Notes"]);
    expect(widths()).toEqual([88, 348, 76, 88]);
  });
});
