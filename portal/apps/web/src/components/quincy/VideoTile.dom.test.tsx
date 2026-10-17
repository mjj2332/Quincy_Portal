import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoTile } from "./VideoTile";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null; let host: HTMLElement | null = null;
async function mount(node: React.ReactNode) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(node); });
  return host;
}
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); host?.remove(); root = null; host = null; });

const base = { title: "Kitchen walkthrough", posterUrl: null, version: 3, durationMs: 92_000, openNotes: 2 as number | null, onOpen: () => undefined };

describe("VideoTile", () => {
  it("keeps the status pill in the corner and moves it past the tick only while the tick shows (selected, hover, focus, coarse, narrow)", async () => {
    const el = await mount(<VideoTile {...base} status={{ tone: "caution", short: "In review", full: "In review" }} select={{ selected: false, onToggle: () => undefined }} />);
    const gap = el.querySelector<HTMLElement>('[data-testid="video-tile-pill-offset"]')!;
    const classes = gap.className.split(" ");
    expect(classes).toContain("hidden");
    expect(classes).toContain("w-11");
    expect(gap.parentElement!.className).toContain("items-start");
    expect(el.querySelector('[data-testid="video-tile-status"]')!.parentElement!.className).toContain("items-start");
    for (const shown of ["group-hover/tile:block", "group-focus-within/tile:block", "group-data-[selected=true]/tile:block", "pointer-coarse:block", "max-[721px]:block"]) expect(classes).toContain(shown);
  });

  it("draws the drop state over a strong scrim with a dashed outline and an upload icon", async () => {
    const el = await mount(<VideoTile {...base} drop={{ nextVersion: 4, onFile: () => undefined, disabled: false }} />);
    const overlay = [...el.querySelectorAll("div")].find((node) => node.textContent === "Drop to upload v4")!;
    expect(overlay.className).toContain("bg-[var(--scrim-badge)]");
    expect(overlay.className).toContain("outline-dashed");
    expect(overlay.querySelector("svg")).not.toBeNull();
  });

  it("shows Version, duration, title and the open-note count, and says them in words for a screen reader", async () => {
    const el = await mount(<VideoTile {...base} status={{ tone: "caution", short: "In review", full: "In review" }} />);
    expect(el.textContent).toContain("v3");
    expect(el.textContent).toContain("1:32");
    expect(el.querySelector('[data-testid="video-tile-open"]')!.textContent).toBe("Kitchen walkthrough");
    const open = el.querySelector('[data-testid="video-tile-open"]')!;
    const summary = el.ownerDocument.getElementById(open.getAttribute("aria-describedby")!)!;
    expect(summary.textContent).toBe("v3, 1:32, 2 open notes on v3, In review");
  });

  it("hides the count at zero and when unknown, and says 'note' for one", async () => {
    let el = await mount(<VideoTile {...base} openNotes={0} />);
    expect(el.querySelector('[data-testid="video-tile-open-notes"]')).toBeNull();
    await act(async () => { root!.unmount(); }); host!.remove();
    el = await mount(<VideoTile {...base} openNotes={null} />);
    expect(el.querySelector('[data-testid="video-tile-open-notes"]')).toBeNull();
    await act(async () => { root!.unmount(); }); host!.remove();
    el = await mount(<VideoTile {...base} openNotes={1} />);
    expect(el.querySelector('[data-testid="video-tile-open-notes"]')!.textContent).toContain("1");
    const open = el.querySelector('[data-testid="video-tile-open"]')!;
    expect(el.ownerDocument.getElementById(open.getAttribute("aria-describedby")!)!.textContent).toBe("v3, 1:32, 1 open note on v3");
  });

  it("opens from a click on the tile's open control, handing over the control", async () => {
    const onOpen = vi.fn();
    const el = await mount(<VideoTile {...base} onOpen={onOpen} />);
    const open = el.querySelector<HTMLElement>('[data-testid="video-tile-open"]')!;
    await act(async () => { open.click(); });
    expect(onOpen).toHaveBeenCalledWith(open);
  });

  it("with an href the open control is a same-tab link that stretches over the tile, keeping the summary and the touch size (#882, story 28)", async () => {
    const { onOpen: _unused, ...linkBase } = base;
    const el = await mount(<VideoTile {...linkBase} href="/d/review?link=x#t=y" />);
    const open = el.querySelector<HTMLElement>('[data-testid="video-tile-open"]')!;
    expect(open.tagName).toBe("A");
    expect(open.getAttribute("href")).toBe("/d/review?link=x#t=y");
    expect(open.hasAttribute("target")).toBe(false);
    expect(open.textContent).toBe("Kitchen walkthrough");
    expect(el.ownerDocument.getElementById(open.getAttribute("aria-describedby")!)!.textContent).toBe("v3, 1:32, 2 open notes on v3");
    for (const kept of ["min-h-11", "after:absolute", "after:inset-0", "items-center"]) expect(open.className).toContain(kept);
    expect(open.querySelector("span")!.className).toContain("truncate");
    expect(el.querySelector("button")).toBeNull();
  });

  it("an openLabel names the open control for what it does, keeping the title in the name", async () => {
    const el = await mount(<VideoTile {...base} openLabel="Request unlock: Kitchen walkthrough" />);
    const open = el.querySelector<HTMLElement>('[data-testid="video-tile-open"]')!;
    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("aria-label")).toBe("Request unlock: Kitchen walkthrough");
  });

  it("a caption is part of the tile's one control: it sits under the stretched open control, not raised above it like a footer (#882, V1)", async () => {
    const el = await mount(<VideoTile {...base} locked caption={<p data-testid="cap">Request unlock</p>} footer={<p data-testid="foot">footer</p>} />);
    const caption = el.querySelector('[data-testid="cap"]')!.parentElement!;
    const footer = el.querySelector('[data-testid="foot"]')!.parentElement!;
    expect(footer.className.split(" ")).toEqual(expect.arrayContaining(["relative", "z-10"]));
    // A tap anywhere on the caption lands on the open control's ::after: no stacking context of its own, and no control inside.
    expect(caption.className.split(" ")).not.toContain("z-10"); expect(caption.className.split(" ")).not.toContain("relative");
    expect(caption.className).toContain("px-[var(--space-3)]"); expect(caption.className).toContain("pb-[var(--space-3)]");
  });

  it("openDisabled leaves the open control focusable but inert: aria-disabled, no open on click, no pointer cursor", async () => {
    const onOpen = vi.fn();
    const el = await mount(<VideoTile {...base} onOpen={onOpen} openLabel="Unlock requested: Kitchen walkthrough" openDisabled />);
    const open = el.querySelector<HTMLButtonElement>('[data-testid="video-tile-open"]')!;
    expect(open.getAttribute("aria-disabled")).toBe("true"); expect(open.disabled).toBe(false);
    open.focus(); expect(document.activeElement).toBe(open);
    await act(async () => { open.click(); });
    expect(onOpen).not.toHaveBeenCalled();
    expect(open.className).toContain("aria-disabled:cursor-default");
  });

  it("without openDisabled the open control carries no aria-disabled", async () => {
    const el = await mount(<VideoTile {...base} />);
    expect(el.querySelector('[data-testid="video-tile-open"]')!.hasAttribute("aria-disabled")).toBe(false);
  });

  it("ticks without opening, and the tick, a menu and a footer are separate controls", async () => {
    const onOpen = vi.fn(); const onToggle = vi.fn();
    const el = await mount(<VideoTile {...base} onOpen={onOpen} select={{ selected: false, onToggle }} menu={<button type="button">Menu</button>} footer={<p>footer</p>} />);
    await act(async () => { el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(el.textContent).toContain("footer");
    expect(el.querySelector('input[type="checkbox"]')!.getAttribute("aria-label")).toBe("Select Kitchen walkthrough");
  });

  it("shows no tick, status or menu unless given them (the guest tile)", async () => {
    const el = await mount(<VideoTile {...base} />);
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
    expect(el.querySelector('[data-testid="video-tile-status"]')).toBeNull();
  });

  it("always letterboxes the poster (object-contain): a 9:16 film is a strip, never cropped", async () => {
    const el = await mount(<VideoTile {...base} posterUrl="/p.jpg" />);
    const poster = el.querySelector('[data-testid="video-tile-poster"]')!;
    expect(poster.getAttribute("data-fit")).toBe("contain");
  });

  it("a drop on the poster passes the file with the 'Drop to upload' label, and is a no-op while disabled", async () => {
    const onFile = vi.fn();
    const el = await mount(<VideoTile {...base} drop={{ nextVersion: 4, onFile, disabled: false }} />);
    expect(el.textContent).toContain("Drop to upload v4");
    const zone = el.querySelector('[data-testid="video-tile-poster"]')!;
    const file = new File(["a"], "a.mp4");
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
    await act(async () => { zone.dispatchEvent(event); });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("flags Premium and an active Review link in words", async () => {
    const el = await mount(<VideoTile {...base} premium linked />);
    expect(el.textContent).toContain("Premium");
    expect(el.textContent).toContain("On a Review link");
  });

  it("paper tone (#882): a light tile with a hairline border, no inverse surface, and the poster stays black", async () => {
    const el = await mount(<VideoTile {...base} tone="paper" />);
    const tile = el.querySelector<HTMLElement>('[data-testid="video-tile"]')!;
    expect(tile.dataset.tone).toBe("paper"); expect(tile.hasAttribute("data-surface")).toBe(false);
    expect(tile.className).toContain("data-[tone=paper]:border-[var(--border-hairline)]");
    expect(el.querySelector('[data-testid="video-tile-poster"]')!.className).toContain("bg-invert");
  });

  it("with no Version and no duration (a film with no review to open) draws neither chip and says neither", async () => {
    const el = await mount(<VideoTile {...base} tone="paper" version={null} durationMs={null} openNotes={null} />);
    expect(el.querySelector('[data-testid="video-tile-version"]')).toBeNull();
    expect(el.textContent).not.toMatch(/\bv\d|\d:\d\d/);
    const open = el.querySelector('[data-testid="video-tile-open"]')!;
    expect(el.ownerDocument.getElementById(open.getAttribute("aria-describedby")!)!.textContent).toBe("");
  });

  it("locked (D37): a light box with a lock and 'Film · locked', no poster, Version, duration or count, and the menu slot for the Premium badge", async () => {
    const el = await mount(<VideoTile {...base} tone="paper" locked version={null} durationMs={null} openNotes={null} menu={<span data-testid="badge">Premium</span>} />);
    expect(el.querySelector('[data-testid="video-tile-locked"]')!.textContent).toBe("Film · locked");
    expect(el.querySelector('[data-testid="video-tile-poster"]')!.className).toContain("bg-surface-sunken");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector('[data-testid="video-tile-version"]')).toBeNull(); expect(el.querySelector('[data-testid="video-tile-open-notes"]')).toBeNull();
    expect(el.querySelector('[data-testid="badge"]')).not.toBeNull();
    const open = el.querySelector('[data-testid="video-tile-open"]')!;
    expect(el.ownerDocument.getElementById(open.getAttribute("aria-describedby")!)!.textContent).toBe("Film, locked: Premium");
  });
});
