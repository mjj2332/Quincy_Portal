import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { MarkupItem } from "@quincy/shared";
import { MarkupBoxContext, StrokeHitTarget, StrokeVisible } from "./freehand-strokes";

/** #741 slice 6s-api: the renderers. Typeless strokes render exactly as 6a shipped them; line, arrow and rectangle are new. */
let root: Root | null = null;
let host: HTMLElement | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function renderSvg(node: ReactNode, box?: { width: number; height: number }) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<svg viewBox="0 0 1 1" preserveAspectRatio="none"><MarkupBoxContext.Provider value={box ?? { width: 0, height: 0 }}>{node}</MarkupBoxContext.Provider></svg>); await Promise.resolve(); });
  return host.querySelector("svg")!;
}
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); host?.remove(); root = null; host = null; });

const line: MarkupItem = { points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], color: "#e64b3c", width: 4 };
const dot: MarkupItem = { points: [{ x: 0.5, y: 0.5 }], color: "#ffffff", width: 6 };
const shape = (type: "arrow" | "line" | "rectangle", a = { x: 0.1, y: 0.2 }, b = { x: 0.7, y: 0.6 }): MarkupItem => ({ type, points: [a, b], color: "#e64b3c", width: 4 });

describe("typeless strokes render exactly as before", () => {
  it("a polyline", async () => {
    const svg = await renderSvg(<><StrokeHitTarget stroke={line} /><StrokeVisible stroke={line} opacity={0.82} /></>);
    expect(svg.innerHTML).toBe(
      '<polyline points="0.1,0.2 0.3,0.4" fill="none" stroke="transparent" stroke-width="16" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: stroke;"></polyline>'
      + '<polyline points="0.1,0.2 0.3,0.4" fill="none" stroke="#e64b3c" stroke-width="4" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" opacity="0.82" class="stroke-vis" data-testid="lightbox-stroke"></polyline>');
  });
  it("a dot", async () => {
    const svg = await renderSvg(<><StrokeHitTarget stroke={dot} /><StrokeVisible stroke={dot} opacity={1} testId="draft" /></>);
    expect(svg.innerHTML).toBe(
      '<circle cx="0.5" cy="0.5" r="0.03" fill="transparent" style="pointer-events: fill;"></circle>'
      + '<circle cx="0.5" cy="0.5" r="0.01" fill="#ffffff" opacity="1" class="stroke-vis" data-testid="draft"></circle>');
  });
  it("is unaffected by a measured box", async () => {
    const svg = await renderSvg(<StrokeVisible stroke={line} opacity={0.82} />, { width: 800, height: 600 });
    expect(svg.querySelectorAll("polyline")).toHaveLength(1);
  });
});

describe("shapes", () => {
  it("a line is one <line> with a non-scaling round stroke", async () => {
    const svg = await renderSvg(<StrokeVisible stroke={shape("line")} opacity={0.82} />);
    const el = svg.querySelector('[data-testid="lightbox-stroke"]')!;
    expect(el.tagName).toBe("line");
    expect([...["x1", "y1", "x2", "y2"].map((a) => el.getAttribute(a))]).toEqual(["0.1", "0.2", "0.7", "0.6"]);
    expect(el.getAttribute("stroke")).toBe("#e64b3c");
    expect(el.getAttribute("stroke-width")).toBe("4");
    expect(el.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(el.getAttribute("stroke-linecap")).toBe("round");
    expect(el.getAttribute("opacity")).toBe("0.82");
  });
  const corners = [
    ["down-right", { x: 0.2, y: 0.3 }, { x: 0.7, y: 0.9 }], ["up-left", { x: 0.7, y: 0.9 }, { x: 0.2, y: 0.3 }],
    ["down-left", { x: 0.7, y: 0.3 }, { x: 0.2, y: 0.9 }], ["up-right", { x: 0.2, y: 0.9 }, { x: 0.7, y: 0.3 }],
  ] as const;
  for (const [label, a, b] of corners) {
    it(`a rectangle dragged ${label} is the same unfilled <rect>`, async () => {
      const svg = await renderSvg(<StrokeVisible stroke={shape("rectangle", a, b)} opacity={1} />);
      const el = svg.querySelector('[data-testid="lightbox-stroke"]')!;
      expect(el.tagName).toBe("rect");
      expect(Number(el.getAttribute("x"))).toBeCloseTo(0.2, 9); expect(Number(el.getAttribute("y"))).toBeCloseTo(0.3, 9);
      expect(Number(el.getAttribute("width"))).toBeCloseTo(0.5, 9); expect(Number(el.getAttribute("height"))).toBeCloseTo(0.6, 9);
      expect(el.getAttribute("fill")).toBe("none");
      expect(el.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    });
  }
  it("an arrow with a measured box is a shaft ending at the head's base plus a filled head, under one test id", async () => {
    const svg = await renderSvg(<StrokeVisible stroke={shape("arrow", { x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 })} opacity={0.82} />, { width: 100, height: 100 });
    const group = svg.querySelector('[data-testid="lightbox-stroke"]')!;
    expect(group.tagName).toBe("g");
    expect(svg.querySelectorAll('[data-testid="lightbox-stroke"]')).toHaveLength(1);
    expect(group.getAttribute("opacity")).toBe("0.82");
    const shaft = group.querySelector("line")!; const head = group.querySelector("polygon")!;
    expect(Number(shaft.getAttribute("x2"))).toBeCloseTo(0.9 - (20 * Math.cos(Math.PI / 6)) / 100, 6);
    expect(shaft.getAttribute("y2")).toBe("0.5");
    expect(head.getAttribute("fill")).toBe("#e64b3c");
    expect(head.getAttribute("points")!.split(" ")).toHaveLength(3);
    expect(head.getAttribute("points")!.startsWith("0.9,0.5 ")).toBe(true);
  });
  it("an arrow with no measured box is a plain line to the end point", async () => {
    const svg = await renderSvg(<StrokeVisible stroke={shape("arrow")} opacity={1} />);
    const group = svg.querySelector('[data-testid="lightbox-stroke"]')!;
    expect(group.querySelector("polygon")).toBeNull();
    expect(group.querySelector("line")!.getAttribute("x2")).toBe("0.7");
  });
  it("a zero-length arrow draws its line and no head", async () => {
    const svg = await renderSvg(<StrokeVisible stroke={shape("arrow", { x: 0.4, y: 0.4 }, { x: 0.4, y: 0.4 })} opacity={1} />, { width: 100, height: 100 });
    expect(svg.querySelector("polygon")).toBeNull();
  });
  it("an unknown type renders nothing", async () => {
    const svg = await renderSvg(<StrokeVisible stroke={{ type: "circle", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: "#fff", width: 2 } as unknown as MarkupItem} opacity={1} />);
    expect(svg.innerHTML).toBe("");
  });
});

describe("hit targets", () => {
  it("a line is a transparent wide stroke", async () => {
    const svg = await renderSvg(<StrokeHitTarget stroke={shape("line")} />);
    const el = svg.querySelector("line")!;
    expect(el.getAttribute("stroke")).toBe("transparent"); expect(el.getAttribute("stroke-width")).toBe("16");
    expect(el.getAttribute("style")).toContain("pointer-events: stroke");
  });
  it("an arrow adds a clickable head when measured", async () => {
    const svg = await renderSvg(<StrokeHitTarget stroke={shape("arrow")} />, { width: 100, height: 100 });
    expect(svg.querySelector("line")).not.toBeNull();
    expect(svg.querySelector("polygon")!.getAttribute("style")).toContain("pointer-events: fill");
  });
  it("a rectangle is a transparent stroke-only <rect>, so what is drawn inside stays clickable", async () => {
    const svg = await renderSvg(<StrokeHitTarget stroke={shape("rectangle")} />);
    const el = svg.querySelector("rect")!;
    expect(el.getAttribute("fill")).toBe("none"); expect(el.getAttribute("stroke")).toBe("transparent");
    expect(el.getAttribute("style")).toContain("pointer-events: stroke");
  });
});
