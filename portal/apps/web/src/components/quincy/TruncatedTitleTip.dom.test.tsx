import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockViewport, type MockViewport } from "../../testing/viewport";
import { TooltipProvider } from "../reui/tooltip";
import { TruncatedTitleTip } from "./TruncatedTitleTip";

/**
 * #934: a cut-off title shows itself in full in a tooltip, on hover and on keyboard focus; a title that fits shows none, and a coarse pointer gets none at all.
 * The DOM here has no layout, so each case stubs the measured element's `scrollWidth`/`clientWidth`. The provider's zero delay only spares the tests Base UI's 600ms hover intent.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null; let host: HTMLElement | null = null; let viewport: MockViewport | null = null;
async function mount(node: ReactNode) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<TooltipProvider delay={0}>{node}</TooltipProvider>); await Promise.resolve(); });
  return host;
}
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); host?.remove(); root = null; host = null; viewport?.restore(); viewport = null; });

const TITLE = "Kitchen walkthrough with the long garden approach and the pool at dusk";
const tip = () => document.querySelector<HTMLElement>('[data-testid="truncated-title-tip"]');

/** What layout would report: `scrollWidth` is the text's full width, `clientWidth` the box it has. */
function measure(element: Element, { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => clientWidth });
}
async function hover(element: Element) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    await Promise.resolve();
  });
}
async function leave(element: Element) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    await Promise.resolve();
  });
}
/** Real-timer poll: Base UI's open state lands a tick or two after the event. */
async function waitFor(assertion: () => void, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}
/** Lets any opening that was going to happen happen, then checks none did. */
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); }); }

describe("TruncatedTitleTip (#934)", () => {
  it("shows the full title on hover when the title is cut off", async () => {
    viewport = mockViewport({ width: 1440 });
    const el = await mount(<TruncatedTitleTip text={TITLE}><button type="button" data-title-text="">{TITLE}</button></TruncatedTitleTip>);
    const trigger = el.querySelector("button")!;
    measure(trigger, { scrollWidth: 420, clientWidth: 180 });
    await hover(trigger);
    await waitFor(() => expect(tip()?.textContent).toBe(TITLE));
  });

  it("shows the full title on keyboard focus when the title is cut off", async () => {
    viewport = mockViewport({ width: 1440 });
    const el = await mount(<TruncatedTitleTip text={TITLE}><button type="button" data-title-text="">{TITLE}</button></TruncatedTitleTip>);
    const trigger = el.querySelector("button")!;
    measure(trigger, { scrollWidth: 420, clientWidth: 180 });
    await act(async () => { trigger.focus(); await Promise.resolve(); });
    await waitFor(() => expect(tip()?.textContent).toBe(TITLE));
  });

  it("shows nothing on hover or focus when the title fits", async () => {
    viewport = mockViewport({ width: 1440 });
    const el = await mount(<TruncatedTitleTip text="Kitchen"><button type="button" data-title-text="">Kitchen</button></TruncatedTitleTip>);
    const trigger = el.querySelector("button")!;
    measure(trigger, { scrollWidth: 60, clientWidth: 180 });
    await hover(trigger); await settle();
    expect(tip()).toBeNull();
    await act(async () => { trigger.focus(); await Promise.resolve(); }); await settle();
    expect(tip()).toBeNull();
  });

  it("treats an element with no width (not laid out) as fitting", async () => {
    viewport = mockViewport({ width: 1440 });
    const el = await mount(<TruncatedTitleTip text={TITLE}><button type="button" data-title-text="">{TITLE}</button></TruncatedTitleTip>);
    const trigger = el.querySelector("button")!;
    measure(trigger, { scrollWidth: 0, clientWidth: 0 });
    await hover(trigger); await settle();
    expect(tip()).toBeNull();
  });

  it("measures the title node inside a link, not the link's own box", async () => {
    viewport = mockViewport({ width: 1440 });
    const el = await mount(<TruncatedTitleTip text={TITLE}><a href="/d/review"><span data-title-text="">{TITLE}</span></a></TruncatedTitleTip>);
    const link = el.querySelector("a")!;
    // The link is a wide flex box that never overflows itself; only its inner span is cut off.
    measure(link, { scrollWidth: 240, clientWidth: 240 });
    measure(link.querySelector("span")!, { scrollWidth: 420, clientWidth: 180 });
    await hover(link);
    await waitFor(() => expect(tip()?.textContent).toBe(TITLE));
  });

  it("measures each time it is asked to open, so a resize that cuts the title off is seen", async () => {
    viewport = mockViewport({ width: 1440 });
    const el = await mount(<TruncatedTitleTip text={TITLE}><button type="button" data-title-text="">{TITLE}</button></TruncatedTitleTip>);
    const trigger = el.querySelector("button")!;
    measure(trigger, { scrollWidth: 420, clientWidth: 480 });
    await hover(trigger); await settle();
    expect(tip()).toBeNull();
    await leave(trigger); await settle();
    // The window narrows: the same title is now cut off.
    measure(trigger, { scrollWidth: 420, clientWidth: 180 });
    await hover(trigger);
    await waitFor(() => expect(tip()?.textContent).toBe(TITLE));
  });

  it("on a coarse pointer adds no tooltip and leaves the child as it was: a tap still just acts", async () => {
    viewport = mockViewport({ width: 390, coarse: true });
    const onClick = vi.fn();
    const el = await mount(<TruncatedTitleTip text={TITLE}><button type="button" data-title-text="" onClick={onClick}>{TITLE}</button></TruncatedTitleTip>);
    const trigger = el.querySelector("button")!;
    measure(trigger, { scrollWidth: 420, clientWidth: 180 });
    expect([...trigger.attributes].map((attribute) => attribute.name).sort()).toEqual(["data-title-text", "type"]);
    await hover(trigger);
    await act(async () => { trigger.focus(); await Promise.resolve(); }); await settle();
    expect(tip()).toBeNull();
    await act(async () => { trigger.click(); });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("adds no description to the control: its accessible name and description stay its own", async () => {
    viewport = mockViewport({ width: 1440 });
    const el = await mount(<><span id="summary">v3, 1:32</span><TruncatedTitleTip text={TITLE}><button type="button" data-title-text="" aria-describedby="summary">{TITLE}</button></TruncatedTitleTip></>);
    const trigger = el.querySelector("button")!;
    measure(trigger, { scrollWidth: 420, clientWidth: 180 });
    await hover(trigger);
    await waitFor(() => expect(tip()).not.toBeNull());
    expect(trigger.getAttribute("aria-describedby")).toBe("summary");
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    expect(trigger.textContent).toBe(TITLE);
  });
});
