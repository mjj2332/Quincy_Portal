/**
 * #727 (PR2 of #722) - the single-scroller contract, read as text from `gantt-view.tsx`:
 *
 * 1. The only `scrollTop =` write is inside `revealRowNearest`. A second write is the sign of a
 *    mirrored second scroller (the deleted scroll-sync / wheel-driver effect) coming back.
 * 2. #728: the only non-passive wheel listener lives in `bindGatedWheelZoom` (`gantt-wheel-zoom.ts`),
 *    which attaches it only while a modifier is held (or on engines without GestureEvent). A
 *    non-passive wheel listener blocks the browser's threaded scrolling, so `gantt-view.tsx` and every
 *    other Gantt file must have none.
 *
 * Comments are stripped first so prose cannot satisfy or trip either check.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const raw = readFileSync(fileURLToPath(new URL("./gantt-view.tsx", import.meta.url)), "utf8");

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const source = stripComments(raw);

/** The source of `function <name>(...) { ... }`, by brace matching from its opening line. */
function functionBody(text: string, name: string): { start: number; end: number } {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  const open = text.indexOf("{", text.indexOf(")", start) + 1);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return { start, end: i };
  }
  throw new Error(`unbalanced ${name}`);
}

/**
 * Start offsets of every `addEventListener("wheel", ...)` call whose full (balanced-paren) argument
 * text contains `passive: false`, so inline callbacks with their own parens are still caught.
 */
function nonPassiveWheelCalls(text: string): number[] {
  const hits: number[] = [];
  for (const m of text.matchAll(/addEventListener\(\s*["']wheel["']/g)) {
    const open = m.index! + "addEventListener".length;
    let depth = 0;
    let end = text.length;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (/passive\s*:\s*false/.test(text.slice(open, end))) hits.push(m.index!);
  }
  return hits;
}

describe("stripComments", () => {
  it("self-test: removes line and block comments, keeps code and urls in strings", () => {
    const out = stripComments('a // scrollTop = 1\n/* scrollTop = 2 */ b = "http://x"');
    expect(out).not.toContain("scrollTop");
    expect(out).toContain('"http://x"');
  });
});

describe("gantt-view.tsx single-scroller guard", () => {
  it("writes scrollTop only inside revealRowNearest", () => {
    const writes = [...source.matchAll(/\bscrollTop\s*(?:\+|-)?=(?!=)/g)].map((m) => m.index!);
    expect(writes.length).toBeGreaterThan(0);
    const reveal = functionBody(source, "revealRowNearest");
    expect(writes.filter((i) => i < reveal.start || i > reveal.end)).toEqual([]);
  });

  it("has no scroll-sync between scrollers (no tree viewport lookup)", () => {
    expect(source).not.toMatch(/getPaneViewport|treeViewport/);
  });

  it("registers no non-passive wheel listener outside the gated zoom helper", () => {
    const dir = fileURLToPath(new URL("./", import.meta.url));
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== "gantt-wheel-zoom.ts");
    const offenders = files.filter((f) => nonPassiveWheelCalls(stripComments(readFileSync(dir + f, "utf8"))).length > 0);
    expect(offenders).toEqual([]);
    expect(source).toContain("bindGatedWheelZoom(");
  });

  it("the guard scan rejects inline-callback, identifier-callback and options-first shapes", () => {
    expect(nonPassiveWheelCalls('el.addEventListener("wheel", (e) => onWheel(e), { passive: false })')).toHaveLength(1);
    expect(nonPassiveWheelCalls("el.addEventListener('wheel', function (e) { f(g(e)) }, { passive: false, capture: true })")).toHaveLength(1);
    expect(nonPassiveWheelCalls('el.addEventListener("wheel", wheel, { passive: false })')).toHaveLength(1);
    expect(nonPassiveWheelCalls('el.addEventListener("wheel", wheel, { passive: true })')).toHaveLength(0);
    expect(nonPassiveWheelCalls('el.addEventListener("wheel", (e) => f(e))')).toHaveLength(0);
    expect(nonPassiveWheelCalls('el.addEventListener("keydown", (e) => f(e), { passive: false })')).toHaveLength(0);
  });

  it("the gated helper has exactly one non-passive wheel listener, inside bindGatedWheelZoom", () => {
    const helper = stripComments(readFileSync(fileURLToPath(new URL("./gantt-wheel-zoom.ts", import.meta.url)), "utf8"));
    const matches = nonPassiveWheelCalls(helper);
    expect(matches).toHaveLength(1);
    const body = functionBody(helper, "bindGatedWheelZoom");
    expect(matches[0]!).toBeGreaterThan(body.start);
    expect(matches[0]!).toBeLessThan(body.end);
  });
});
