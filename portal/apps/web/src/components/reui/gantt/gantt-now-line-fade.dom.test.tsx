/**
 * #219 PR A fix (dr2-219a LOW #5) — the now-line's comet-tail gradient fades below a legible
 * floor.
 *
 * `GanttNowLine` (`gantt-view.tsx`) painted `from-border-strong/80 via-border-strong/45
 * to-border-strong/15` — a bg-linear-to-b comet tail down the full height of the grid body. The
 * design reviewer measured the composited pixel at 72 near the top (the `/80` stop) and 207 near
 * the bottom (the `/15` floor) against a ~250 canvas — roughly 1.4:1, well under any legible
 * threshold. Harmless on the reviewer's own 3-row screenshot; on a grid with more rows the line
 * fades to invisible well before the bottom.
 *
 * Fix, and the value chosen: raise the floor stop from `/15` to `/45` — the SAME alpha the
 * existing `via` (midpoint) stop already uses, so the tail still visibly tapers from `/80` at the
 * cap down to `/45` by the midpoint, then holds there for the rest of its height instead of
 * continuing to fade past legibility. `--border-strong` (`--ink-900`, `#0a0a0a`) composited at 45%
 * over the grid's own canvas token (`--bg-canvas` -> `--paper-050`, `#faf8f2`) computes to a WCAG
 * contrast ratio of ~3.1:1 against that canvas — at or above the 3:1 floor WCAG 1.4.11 sets for a
 * non-text graphical object that conveys information (this is exactly that: a today marker with no
 * text alternative visible on the grid itself). `/15` computed to ~1.4:1, matching the reviewer's
 * measurement. `/45` was chosen over inventing a new arbitrary value because it is already present
 * in this exact class list, in this exact gradient — no new token or magic number, and the
 * three-stop shape (`/80` -> `/45` -> `/45`) still reads as "solid cap, then a held tail" rather
 * than a flat bar the full height.
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
});
