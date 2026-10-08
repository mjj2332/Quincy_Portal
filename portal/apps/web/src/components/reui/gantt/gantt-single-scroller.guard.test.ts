/**
 * #727 (PR2 of #722) - the single-scroller contract, read as text from `gantt-view.tsx`:
 *
 * 1. The only `scrollTop =` write is inside `revealRowNearest`. A second write is the sign of a
 *    mirrored second scroller (the deleted scroll-sync / wheel-driver effect) coming back.
 * 2. The only non-passive wheel listener is the existing zoom one. A non-passive wheel listener
 *    blocks the browser's threaded scrolling (PR3, #728, gates that one on a held modifier).
 *
 * Comments are stripped first so prose cannot satisfy or trip either check.
 */
import { readFileSync } from "node:fs";
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

  it("registers a non-passive wheel listener only for the zoom handler", () => {
    const nonPassive = [...source.matchAll(/addEventListener\(\s*"wheel"[^)]*passive:\s*false/g)];
    expect(nonPassive).toHaveLength(1);
    expect(nonPassive[0]![0]).toContain("onWheel");
    expect(source).toContain("wheelZoomRef.current?.(e)");
  });
});
