// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { expandServerEdits, IndexSpace, type StoredElement, type WhiteboardServerEdit } from "@quincy/shared";

/**
 * #708: the elements the server writes for an MCP client's edits must survive the INSTALLED Excalidraw (`restoreElements` is the
 * first thing a browser runs on a scene it loads), keeping their content, their bindings and their revisions. A server-made
 * element that restore rewrites would read as an edit by whoever loaded it.
 */
type Fns = { restoreElements: (e: never, o: null) => Array<Record<string, unknown>> };
let excalidraw: Fns;
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  excalidraw = (await import("@excalidraw/excalidraw")) as unknown as Fns;
});

let counter = 0;
const deps = (media: Map<string, { kind: "image" | "video"; width: number | null; height: number | null }> = new Map()) => ({ newId: () => `srv-${++counter}`, random31: () => 1 + (counter++ % 1000), now: () => 1_700_000_000_000, media });
/** The server stores the result with an index of its own (`reconcileRows` places it); this stands in for that. */
function stored(elements: StoredElement[]): StoredElement[] {
  const space = new IndexSpace();
  return elements.map((element) => ({ ...element, index: space.place(null, element.id) }));
}

describe("server-made elements through the installed Excalidraw", () => {
  it("restores every kind unchanged: content, bindings, revisions", () => {
    const mediaId = "5b1f6d0a-27f4-4f66-9d0a-2f2a6e5c9a11";
    const first = expandServerEdits([
      { op: "add_text", x: 10, y: 20, text: "Hello\nboard" },
      { op: "add_sticky", x: 100, y: 200, text: "A note that is long enough to wrap onto several lines", color: "pink" },
      { op: "add_shape", shapeKind: "rectangle", x: 0, y: 300, w: 120, h: 80 },
      { op: "add_shape", shapeKind: "diamond", x: 400, y: 300, w: 120, h: 80 },
      { op: "place_media", embeddedMediaId: mediaId, x: 50, y: 500 },
    ] satisfies WhiteboardServerEdit[], [], deps(new Map([[mediaId, { kind: "image", width: 640, height: 480 }]])));
    if (!first.ok) throw new Error(first.message);
    const [, , rect, diamond] = first.results;
    const second = expandServerEdits([{ op: "add_arrow", from: rect!.id, to: diamond!.id }, { op: "add_arrow", from: diamond!.id, to: { x: 900, y: 50 } }], stored(first.elements), deps());
    if (!second.ok) throw new Error(second.message);
    const final = new Map(stored(first.elements).map((element) => [element.id, element]));
    for (const element of second.elements) final.set(element.id, { ...element, index: final.get(element.id)?.index ?? `a${final.size}` } as StoredElement);

    const rows = [...final.values()];
    const restored = excalidraw.restoreElements(structuredClone(rows) as never, null);
    expect(restored).toHaveLength(rows.length);
    for (const row of rows) {
      const back = restored.find((element) => element.id === row.id)!;
      expect(back, `${row.type} ${row.id}`).toBeDefined();
      expect(back.type).toBe(row.type);
      expect(back.isDeleted).toBe(false);
      expect({ version: back.version, versionNonce: back.versionNonce }, `${row.type} revision`).toEqual({ version: row.version, versionNonce: row.versionNonce });
      for (const key of ["x", "y", "width", "height", "text", "originalText", "containerId", "fileId", "backgroundColor"]) if (key in row) expect(back[key], `${row.type}.${key}`).toEqual(row[key]);
      if (row.type === "arrow") { expect(back.startBinding).toEqual(row.startBinding); expect(back.endBinding).toEqual(row.endBinding); expect(back.points).toEqual(row.points); }
      if (row.boundElements) expect(back.boundElements).toEqual(row.boundElements);
    }
  });

  it("restores a tombstone as a tombstone", () => {
    const made = expandServerEdits([{ op: "add_sticky", x: 0, y: 0, text: "bye", color: "green" }], [], deps());
    if (!made.ok) throw new Error(made.message);
    const rows = stored(made.elements);
    const gone = expandServerEdits([{ op: "delete", id: made.results[0]!.id }], rows, deps());
    if (!gone.ok) throw new Error(gone.message);
    const restored = excalidraw.restoreElements(structuredClone(gone.elements.map((element, index) => ({ ...element, index: rows[index]?.index ?? "a1" }))) as never, null);
    expect(restored.every((element) => element.isDeleted === true)).toBe(true);
  });

  const GAP = 1;
  const idx = (rows: StoredElement[]) => stored(rows);
  const rowsOf = (...batches: Array<StoredElement[]>) => {
    const final = new Map<string, StoredElement>();
    for (const batch of batches) for (const element of batch) final.set(element.id, { ...element, index: final.get(element.id)?.index ?? `a${final.size}` } as StoredElement);
    return [...final.values()];
  };
  const restore = (rows: StoredElement[]) => excalidraw.restoreElements(structuredClone(rows) as never, null);
  const must = (result: ReturnType<typeof expandServerEdits>) => { if (!result.ok) throw new Error(result.message); return result; };

  it("starts an arrow on the real outline of a diamond: a 200x200 diamond toward (500,500) leaves at (150,150) plus the gap", () => {
    const made = must(expandServerEdits([{ op: "add_shape", shapeKind: "diamond", x: 0, y: 0, w: 200, h: 200 }], [], deps()));
    const arrow = must(expandServerEdits([{ op: "add_arrow", from: made.results[0]!.id, to: { x: 500, y: 500 } }], idx(made.elements), deps()));
    const row = arrow.elements.find((element) => element.type === "arrow")!;
    expect(row.x as number).toBeCloseTo(150 + GAP * Math.SQRT1_2, 3);
    expect(row.y as number).toBeCloseTo(150 + GAP * Math.SQRT1_2, 3);
  });

  it("respects a rotated target's angle", () => {
    const ellipse = { id: "rot", type: "ellipse", x: 0, y: 0, width: 200, height: 100, angle: Math.PI / 2, version: 1, versionNonce: 1, isDeleted: false, index: "a0", boundElements: null } as unknown as StoredElement;
    // Turned a quarter turn, the 200-wide ellipse is 100 wide on screen: a ray along +x leaves 50 from the centre (100,50).
    const arrow = must(expandServerEdits([{ op: "add_arrow", from: "rot", to: { x: 1100, y: 50 } }], [ellipse], deps()));
    const row = arrow.elements.find((element) => element.type === "arrow")!;
    expect(row.x as number).toBeCloseTo(100 + 50 + GAP, 3);
    expect(row.y as number).toBeCloseTo(50, 3);
  });

  function boundPair() {
    const shapes = must(expandServerEdits([{ op: "add_shape", shapeKind: "rectangle", x: 0, y: 0, w: 100, h: 100 }, { op: "add_shape", shapeKind: "rectangle", x: 500, y: 0, w: 100, h: 100 }], [], deps()));
    const [a, b] = shapes.results.map((entry) => entry.id) as [string, string];
    const arrow = must(expandServerEdits([{ op: "add_arrow", from: a, to: b }], idx(shapes.elements), deps()));
    const arrowId = arrow.results[0]!.id;
    return { a, b, arrowId, rows: rowsOf(shapes.elements, arrow.elements) };
  }

  it("moving a shape re-routes every arrow bound to it and bumps those arrows, checked through restoreElements", () => {
    const { a, b, arrowId, rows } = boundPair();
    const before = rows.find((row) => row.id === arrowId)!;
    const moved = must(expandServerEdits([{ op: "edit", id: b, x: 500, y: 400 }], rows, deps()));
    const arrow = moved.elements.find((row) => row.id === arrowId)!;
    expect(arrow.version).toBe((before.version as number) + 1);
    expect(moved.elements.map((row) => row.id).sort()).toEqual([arrowId, b].sort());
    const after = restore(rowsOf(rows, moved.elements));
    const back = after.find((row) => row.id === arrowId)!;
    const points = back.points as number[][];
    const end = { x: (back.x as number) + points.at(-1)![0]!, y: (back.y as number) + points.at(-1)![1]! };
    expect(end.y).toBeGreaterThan(100);                                        // now lands on the lowered shape's top-left side, not at y 50
    expect(end.x).toBeGreaterThan(400); expect(end.x).toBeLessThan(560);
    expect(back.width).toBeCloseTo(Math.abs(end.x - (back.x as number)), 3);
    expect(back.height).toBeCloseTo(Math.abs(end.y - (back.y as number)), 3);
    expect(back.startBinding).toMatchObject({ elementId: a });
    expect(back.endBinding).toMatchObject({ elementId: b });
  });

  it("deleting a shape clears the bindings that reference it; deleting an arrow leaves its targets' boundElements clean", () => {
    const { a, b, arrowId, rows } = boundPair();
    const cut = must(expandServerEdits([{ op: "delete", id: b }], rows, deps()));
    const arrow = cut.elements.find((row) => row.id === arrowId)!;
    expect(arrow).toMatchObject({ endBinding: null, isDeleted: false });
    expect(arrow.startBinding).toMatchObject({ elementId: a });
    expect(arrow.version).toBe((rows.find((row) => row.id === arrowId)!.version as number) + 1);
    const back = restore(rowsOf(rows, cut.elements)).find((row) => row.id === arrowId)!;
    expect(back.endBinding).toBeNull();

    const gone = must(expandServerEdits([{ op: "delete", id: arrowId }], rows, deps()));
    for (const id of [a, b]) {
      const target = gone.elements.find((row) => row.id === id)!;
      expect(target.boundElements).toEqual([]);
      expect(target.version).toBe((rows.find((row) => row.id === id)!.version as number) + 1);
    }
    const restored = restore(rowsOf(rows, gone.elements));
    expect(restored.find((row) => row.id === arrowId)!.isDeleted).toBe(true);
    expect(((restored.find((row) => row.id === a)!.boundElements ?? []) as unknown[]).length).toBe(0);
  });
});
