/**
 * #219 PR A fix (dr2-219a LOW #5, then dr3-219a LOW #2) — the now-line's comet-tail gradient faded
 * below a legible floor; HEAD's actual shipped value is documented in full at the third `it()`
 * below, which is the one this suite's own real assertions are pinned to (Sol round-7 LOW: this
 * header used to stop at the SUPERSEDED `/45` value and never mention the later `/50` fix).
 *
 * `GanttNowLine` (`gantt-view.tsx`) originally painted `from-border-strong/80 via-border-strong/45
 * to-border-strong/15` — a bg-linear-to-b comet tail down the full height of the grid body. The
 * design reviewer measured the composited pixel at 72 near the top (the `/80` stop) and 207 near
 * the bottom (the `/15` floor) against a ~250 canvas — roughly 1.4:1, well under any legible
 * threshold. Harmless on the reviewer's own 3-row screenshot; on a grid with more rows the line
 * fades to invisible well before the bottom.
 *
 * dr2-219a LOW #5 raised the floor stop from `/15` to `/45` — the SAME alpha the existing `via`
 * (midpoint) stop already used — computing to ~3.1:1 against the grid's own canvas token
 * (`--bg-canvas`), at or above the 3:1 floor WCAG 1.4.11 sets for a non-text graphical object that
 * conveys information. That fix was justified against bare CANVAS, though, and the line does not
 * sit on bare canvas for its full height: the current day's own column paints a `bg-primary/5`
 * tint underneath it (`data-today`, a different, painted-first element). dr3-219a LOW #2 measured
 * the `/45` floor at only ~2.90:1 against that shaded column — under the 3:1 floor the superseded
 * comment above claimed — and raised BOTH stops to `/50`, ~3.58:1 against the shaded today column,
 * real margin against the background the line actually sits on. HEAD ships `/50`, justified
 * against the today column, not `/45` against canvas — see the third `it()` below for the full
 * reasoning and the real-screenshot-derived margin behind the hard `>= 50` floor it asserts.
 *
 * This suite runs happy-dom with no CSS pipeline (`vitest.dom.config.ts` loads no stylesheet), so
 * there is no `getComputedStyle` to ask — same approach `gantt-bar-completed-hue.dom.test.tsx`
 * already uses for a resolved-colour assertion: read the real token source as text, resolve the
 * `var()` chain by hand, and alpha-composite the percentage the gradient's own class list names,
 * against the ACTUAL rendered className (not a hand-typed copy of it) — a renamed or reworded class
 * would fail this test, not silently pass it.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttResource } from "@/components/reui/gantt/gantt-types";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  host.remove();
  vi.useRealTimers();
});

const RESOURCES: GanttResource[] = [{ id: "r1", title: "Row 1" }];

// `GanttNowLine` reads `new Date()` directly (`useNow`), not a prop — a fixed system clock plus a
// `date` prop equal to that same instant puts "now" inside the visible week deterministically,
// with no dependence on when this suite actually runs.
const NOW = new Date("2026-03-04T12:00:00.000Z"); // a Wednesday, UTC

function findNowLine(): HTMLElement {
  // `data-testid`, not `data-slot` - `gantt-view.tsx` lives under `components/reui/`, so
  // `test-seam.guard.test.ts` Guard F treats its own `data-slot="gantt-now-indicator"` as
  // vendor-authored and forbids a DOM test from selecting on it; see that element's own
  // `data-testid` comment for why an additive `data-testid` is the correct hook instead.
  const el = host.querySelector<HTMLElement>('[data-testid="gantt-now-indicator"]');
  if (!el) throw new Error("no now-line found - is NOW inside the rendered week?");
  return el;
}

/**
 * Reads the resolved hex for a design token from the real source files (not a hand-typed copy) -
 * the same approach `gantt-bar-completed-hue.dom.test.tsx` already uses, reused verbatim.
 */
function loadTokenSource(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const tokensDir = join(thisDir, "..", "..", "..", "styles", "tokens");
  return (
    readFileSync(join(tokensDir, "colors.css"), "utf8") +
    readFileSync(join(tokensDir, "tailwind.css"), "utf8")
  );
}

function resolveToken(source: string, name: string): string {
  const declaration = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(source);
  if (!declaration) throw new Error(`no declaration for ${name}`);
  const value = declaration[1]!.trim();
  const varRef = /^var\((--[\w-]+)\)$/.exec(value);
  if (varRef) return resolveToken(source, varRef[1]!);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`${name} resolved to a non-hex value: ${value}`);
  }
  return value;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Alpha-composites `fgHex` at `alphaPercent`% over `bgHex` - plain source-over, sRGB channels. */
function compositeOver(fgHex: string, bgHex: string, alphaPercent: number): [number, number, number] {
  const a = alphaPercent / 100;
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  return [0, 1, 2].map((i) => Math.round(fg[i]! * a + bg[i]! * (1 - a))) as [number, number, number];
}

/** WCAG relative luminance / contrast ratio, sRGB input. */
function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Pulls the `to-border-strong/NN` floor stop's alpha percentage out of the ACTUAL className. */
function readFloorAlphaPercent(className: string): number {
  const match = /\bto-border-strong\/(\d{1,3})\b/.exec(className);
  if (!match) throw new Error(`no to-border-strong/NN stop found in "${className}"`);
  return Number(match[1]);
}

describe("the now-line's comet tail stays legible for its full height, not just near the cap (#219 PR A, dr2-219a LOW #5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("the floor (bottom) gradient stop resolves to at least a 3:1 contrast ratio against the grid canvas", async () => {
    await render(
      <Gantt resources={RESOURCES} events={[]} date={NOW} scale="week" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const line = findNowLine();
    const floorAlpha = readFloorAlphaPercent(line.className);

    const tokens = loadTokenSource();
    const borderStrongHex = resolveToken(tokens, "--border-strong");
    const canvasHex = resolveToken(tokens, "--bg-canvas");

    const floorRgb = compositeOver(borderStrongHex, canvasHex, floorAlpha);
    const canvasRgb = hexToRgb(canvasHex);
    const ratio = contrastRatio(floorRgb, canvasRgb);

    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it("the cap (top) stop is still brighter than the floor stop - the tail still tapers, it does not go flat", async () => {
    await render(
      <Gantt resources={RESOURCES} events={[]} date={NOW} scale="week" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const line = findNowLine();
    const capMatch = /\bfrom-border-strong\/(\d{1,3})\b/.exec(line.className);
    if (!capMatch) throw new Error(`no from-border-strong/NN stop found in "${line.className}"`);
    const capAlpha = Number(capMatch[1]);
    const floorAlpha = readFloorAlphaPercent(line.className);

    expect(capAlpha).toBeGreaterThan(floorAlpha);
  });

  /**
   * #219 PR A fix (dr3-219a LOW #2) — the test and comment above (and this file's own header) only
   * ever checked contrast against `--bg-canvas`. The line does not sit on bare canvas, though: it
   * runs the full height of the grid BODY, which for the current day is the `data-today` column's
   * OWN tint (`bg-primary/5`, a different, painted-first element - `gantt-view.tsx:2646`), not
   * canvas underneath it. The design reviewer measured the old `/45` floor at 2.90:1 against that
   * shaded column (dr3-219a-report.md Defect 2) — under the 3:1 floor the removed comment claimed,
   * even though `/45` against bare canvas alone (this file's other test, above) clears it. Composited
   * for real here (`--primary` -> `--accent` -> `--ink-900` at 5% over `--bg-canvas`, the SAME
   * `bg-primary/5` the shaded column itself uses) rather than hand-typed, so a renamed token or a
   * different tint recipe would fail this test, not silently pass it.
   *
   * The floor alpha itself is asserted at a hard `>= 50` floor, not just "clears 3:1 by whatever
   * idealized alpha-compositing math computes": plain source-over math alone puts even the OLD `/45`
   * just barely over the 3:1 line against this background (~3.07:1) - it takes the reviewer's own
   * real rendered screenshot (anti-aliasing on a 1px `w-px` line at a fractional `insetInlineStart`
   * softens its peak alpha) to see it actually fall short at 2.90:1. A same-formula-only assertion
   * here would pass at `/45` too and prove nothing changed, so the fix is pinned to the `/50` value
   * the spec chose for real margin over that measurement, not merely to a ratio a browser-free
   * formula alone is willing to certify.
   */
  it("(dr3-219a LOW #2) the floor stop clears 3:1 against the shaded TODAY column it actually sits on (not bare canvas), with real margin - not just the /45 that idealized alpha-compositing math alone would wave through", async () => {
    await render(
      <Gantt resources={RESOURCES} events={[]} date={NOW} scale="week" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const line = findNowLine();
    const floorAlpha = readFloorAlphaPercent(line.className);

    const tokens = loadTokenSource();
    const borderStrongHex = resolveToken(tokens, "--border-strong");
    const canvasHex = resolveToken(tokens, "--bg-canvas");
    const todayTintHex = resolveToken(tokens, "--primary");

    // the shaded today column itself: `bg-primary/5` composited over canvas.
    const todayColumnRgb = compositeOver(todayTintHex, canvasHex, 5);
    const floorRgb = compositeOver(borderStrongHex, `#${todayColumnRgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`, floorAlpha);
    const ratio = contrastRatio(floorRgb, todayColumnRgb);

    expect(ratio).toBeGreaterThanOrEqual(3);
    expect(floorAlpha).toBeGreaterThanOrEqual(50);
  });
});
