import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * #499 (re-plan 2): the saver authors no revision, so EVERY route that puts elements on the board must author its revisions itself, the way
 * the editor does (`newElementWith`) or merge what someone else authored (`mergeRemote`). `replaceContent` is where an import is numbered
 * (max of what is incoming and what the board holds, deleted included, plus one, with a fresh nonce), so a route that loads a scene without it
 * would put an element on the board at a revision the server may already hold. This names every `updateScene({ elements })` in the canvas;
 * a new one fails here until it is listed with the reason its revisions are authored. Detectors are pure functions over injected source, and
 * a synthetic fixture proves each one can fail.
 */
const here = dirname(fileURLToPath(import.meta.url));
const canvasSource = readFileSync(join(here, "whiteboard-canvas.tsx"), "utf8");

/** The text of every `updateScene({ ... })` argument that sets `elements`, with the enclosing statement trimmed to its elements expression. */
export function elementUpdates(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/updateScene\(\{/g)) {
    let depth = 1; let at = (match.index ?? 0) + match[0].length;
    const start = at;
    while (depth > 0 && at < source.length) { const ch = source[at++]; if (ch === "{") depth += 1; else if (ch === "}") depth -= 1; }
    const body = source.slice(start, at - 1);
    const key = body.search(/(^|\n)\s*elements:/);
    if (key < 0) continue;
    found.push(body.slice(key).trim().split("\n").slice(0, 2).join(" ").replace(/\s+/g, " "));
  }
  return found;
}
export function replaceContentCalls(source: string): number { return [...source.matchAll(/\breplaceContent\(/g)].length; }

const ROUTES: Array<{ elements: string; why: string }> = [
  { elements: "elements: [ ...next,", why: "replaceContent: an imported / replaced scene, numbered above what the board holds (deleted included) with newElementWith, the rest tombstoned" },
  { elements: "elements: merged as never,", why: "mergeInto (applyRemote / applyLocal): Excalidraw's reconcile of revisions someone authored; never changes one" },
  { elements: "elements: [...api.getSceneElementsIncludingDeleted(), ...moved],", why: "insert: brand new elements (new ids), authored by newElementWith, appended; replaces nothing" },
  { elements: "elements: tombstones(api.getSceneElementsIncludingDeleted()),", why: "clear: every element deleted with newElementWith, as the editor's own Clear does" },
  { elements: "elements: scene as never,", why: "adoptRevisions: the first load only, puts the server's revisions back in place after the editor's own restore bumped them" },
  { elements: "elements: [...api.getSceneElementsIncludingDeleted(), ...placed],", why: "library insert: new copies (new ids) authored by newElementWith, appended; replaces nothing" },
  { elements: "elements: [...api.getSceneElementsIncludingDeleted(), ...placedMedia],", why: "insertMedia (#501): ONE brand new image element (new id), authored by convertToExcalidrawElements from a skeleton, appended; replaces nothing" },
  { elements: "elements: rewrapped.map((element) =>", why: "font re-measure: the editor's own restore, a re-measured element takes newElementWith(…, {}, true)" },
  { elements: "elements: unfinished as never,", why: "unfinalized-element sweep: drops live zero-size elements and authors nothing; the vanish observer then authors their deletion (the editor-style delete, never the saver)" },
  { elements: "elements: kept as never,", why: "unsupported-element sweep: removes MALFORMED images the server refuses (never a well-formed media element, #501); they were never stored" },
];

describe("every route that puts elements on the whiteboard authors its own revisions (#499)", () => {
  it("lists exactly the known updateScene({ elements }) routes", () => {
    const found = elementUpdates(canvasSource);
    expect(found.map((line) => ROUTES.find((route) => line.startsWith(route.elements))?.elements ?? `UNLISTED: ${line}`).sort()).toEqual(ROUTES.map((route) => route.elements).sort());
  });

  it("reaches a loaded or replaced scene only through replaceContent: the load route and the replace route", () => {
    expect(replaceContentCalls(canvasSource)).toBe(3);                // its definition, controller.load, controller.replace
    expect(canvasSource).not.toMatch(/\bresetScene\(/);               // which would bypass the numbering and the tombstones
  });

  it("detectors can fail: a new elements route and a new replaceContent-bypassing reset are both seen", () => {
    expect(elementUpdates("api.updateScene({\n  elements: mine,\n  captureUpdate: X,\n})")).toEqual(["elements: mine, captureUpdate: X,"]);
    expect(elementUpdates("api.updateScene({ appState: { a: 1 }, captureUpdate: X })")).toEqual([]);
    expect(replaceContentCalls("replaceContent(a); replaceContent(b)")).toBe(2);
  });
});
