// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { expandServerEdits, IndexSpace, WHITEBOARD_NOTE_INK, WHITEBOARD_PAPER, WHITEBOARD_STICKY_COLORS, type StoredElement, type WhiteboardServerEdit } from "@quincy/shared";

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

  const rawRect = (id: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}) =>
    ({ id, type: "rectangle", x, y, width, height, angle: 0, version: 1, versionNonce: 1, isDeleted: false, index: `a${id}`, boundElements: null, ...extra }) as unknown as StoredElement;
  const rawArrow = (extra: Record<string, unknown>) =>
    ({ id: "arr", type: "arrow", angle: 0, version: 1, versionNonce: 1, isDeleted: false, index: "azz", boundElements: null, startArrowhead: null, endArrowhead: "arrow", lastCommittedPoint: null, ...extra }) as unknown as StoredElement;
  const worldPoints = (row: Record<string, unknown>) => (row.points as number[][]).map((p) => ({ x: (row.x as number) + p[0]!, y: (row.y as number) + p[1]! }));
  /** 0 on the outline of a box turned by `angle`, in its own frame (max-norm for a rectangle). */
  const rectNorm = (p: { x: number; y: number }, box: Record<string, unknown>) => {
    const cx = (box.x as number) + (box.width as number) / 2; const cy = (box.y as number) + (box.height as number) / 2;
    const a = -(box.angle as number); const dx = p.x - cx; const dy = p.y - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a); const ly = dx * Math.sin(a) + dy * Math.cos(a);
    return Math.max(Math.abs(lx) / ((box.width as number) / 2), Math.abs(ly) / ((box.height as number) / 2));
  };

  it("re-routes a ROTATED arrow between rotated rectangles in world coordinates and writes it back unrotated", () => {
    const quarter = Math.PI / 2;
    const a = rawRect("A", 0, 0, 100, 50, { angle: quarter }); const b = rawRect("B", 500, 0, 100, 50, { angle: quarter });
    // World: from A's right side (76,25) to B's left side (524,25). Stored turned -90 degrees about the box centre (300,25).
    const arrow = rawArrow({ x: 300, y: 249, width: 0, height: 448, angle: quarter, points: [[0, 0], [0, -448]], startBinding: { elementId: "A", focus: 0, gap: 1 }, endBinding: { elementId: "B", focus: 0, gap: 1 }, elbowed: false });
    const rows = [a, b, arrow];
    const moved = must(expandServerEdits([{ op: "edit", id: "B", y: 200 }], rows, deps()));
    const next = moved.elements.find((row) => row.id === "arr")!;
    expect(next.angle).toBe(0);
    const back = restore(rowsOf(rows, moved.elements));
    const row = back.find((r) => r.id === "arr")!;
    const [start, end] = [worldPoints(row)[0]!, worldPoints(row).at(-1)!];
    expect(rectNorm(start, back.find((r) => r.id === "A")!)).toBeCloseTo(1, 1);
    expect(rectNorm(end, back.find((r) => r.id === "B")!)).toBeCloseTo(1, 1);
    expect(end.y).toBeGreaterThan(150);                                          // followed B down
    expect(row.angle).toBe(0);
  });

  it("clears a pinned segment only when it is adjacent to the moved end and the new end is off its line, then re-routes H-V-H or V-H-V from the fixed points", () => {
    const a = rawRect("A", 0, 0, 100, 100); const b = rawRect("B", 500, 0, 100, 100);
    const arrow = rawArrow({ x: 101, y: 50, width: 398, height: 0, points: [[0, 0], [199, 0], [398, 0]], elbowed: true, fixedSegments: [{ start: [199, 0], end: [199, 0], index: 2 }], startIsSpecial: null, endIsSpecial: null,
      startBinding: { elementId: "A", focus: 0, gap: 1, fixedPoint: [1.01, 0.5] }, endBinding: { elementId: "B", focus: 0, gap: 1, fixedPoint: [-0.01, 0.5] } });
    const rows = [a, b, arrow];
    for (const [y, shape] of [[100, "H-V-H"], [-40, "H-V-H"]] as const) {
      const moved = must(expandServerEdits([{ op: "edit", id: "B", y }], rows, deps()));
      const row = restore(rowsOf(rows, moved.elements)).find((r) => r.id === "arr")!;
      const pts = worldPoints(row);
      expect(pts, shape).toHaveLength(4);
      for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i]!.x - pts[i - 1]!.x) < 1e-6 || Math.abs(pts[i]!.y - pts[i - 1]!.y) < 1e-6, `segment ${i}`).toBe(true);
      expect(row.elbowed).toBe(true);
      expect(row.fixedSegments ?? null).toBeNull();                              // the pin on B's own segment cannot hold: cleared
      expect((moved.elements.find((r) => r.id === "arr")!.endBinding as { fixedPoint: number[] }).fixedPoint[1]).toBeCloseTo(0.5, 9);
      expect((row.endBinding as { fixedPoint: number[] }).fixedPoint[1]).toBeCloseTo(0.5, 2);
      expect(pts.at(-1)!.y).toBeCloseTo(y + 50.01, 9);                         // B's fixed point; 0.5 reads as 0.5001, as in the editor
      expect(pts[0]).toEqual({ x: 101, y: 50 });                                  // A did not move
    }
    // A dominant vertical run chooses V-H-V.
    const tall = must(expandServerEdits([{ op: "edit", id: "B", x: 120, y: 600 }], rows, deps()));
    const pts = worldPoints(restore(rowsOf(rows, tall.elements)).find((r) => r.id === "arr")!);
    for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i]!.x - pts[i - 1]!.x) < 1e-6 || Math.abs(pts[i]!.y - pts[i - 1]!.y) < 1e-6).toBe(true);
    expect(Math.abs(pts[1]!.x - pts[0]!.x)).toBeLessThan(1e-6);                 // first run is vertical
  });

  // Sol's scenario: A's end is at (101,20), not the facing midpoint, and the arrow carries a pinned detour (segment 3, y -100).
  const detour = () => {
    const a = rawRect("A", 0, 0, 100, 100); const b = rawRect("B", 500, 0, 100, 100);
    const arrow = rawArrow({ x: 101, y: 20, width: 398, height: 150, points: [[0, 0], [49, 0], [49, -120], [349, -120], [349, 30], [398, 30]], elbowed: true,
      fixedSegments: [{ start: [49, -120], end: [349, -120], index: 3 }], startIsSpecial: false, endIsSpecial: false,
      startBinding: { elementId: "A", focus: 0, gap: 1, fixedPoint: [1.01, 0.2] }, endBinding: { elementId: "B", focus: 0, gap: 1, fixedPoint: [-0.01, 0.5] } });
    return [a, b, arrow];
  };
  const orthogonal = (pts: Array<{ x: number; y: number }>) => {
    for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i]!.x - pts[i - 1]!.x) < 1e-6 || Math.abs(pts[i]!.y - pts[i - 1]!.y) < 1e-6, `segment ${i}`).toBe(true);
  };
  const pinnedWorld = (row: Record<string, unknown>) => (row.fixedSegments as Array<{ start: number[]; end: number[]; index: number }>).map((s) => ({ index: s.index, start: [(row.x as number) + s.start[0]!, (row.y as number) + s.start[1]!], end: [(row.x as number) + s.end[0]!, (row.y as number) + s.end[1]!] }));

  it("moving only B keeps A's end exactly and the pinned detour, re-routing just B's side orthogonally", () => {
    const rows = detour();
    const moved = must(expandServerEdits([{ op: "edit", id: "B", y: 100 }], rows, deps()));
    const row = restore(rowsOf(rows, moved.elements)).find((r) => r.id === "arr")!;
    const pts = worldPoints(row);
    expect(pts[0]).toEqual({ x: 101, y: 20 });                                    // A did not move: its end is untouched
    expect(pts.slice(0, 4)).toEqual([{ x: 101, y: 20 }, { x: 150, y: 20 }, { x: 150, y: -100 }, { x: 450, y: -100 }]);
    expect(pinnedWorld(row)).toEqual([{ index: 3, start: [150, -100], end: [450, -100] }]);
    // B's own fixed point (-0.01, 0.5) on the lowered B; the editor reads a 0.5 ratio as 0.5001, and so does the server.
    expect(pts.at(-1)!.x).toBeCloseTo(499, 9); expect(pts.at(-1)!.y).toBeCloseTo(150.01, 9);
    expect(pts[4]!.x).toBe(450);                                                  // B's side re-routed: down from the pin's end, across to B
    orthogonal(pts);
    const written = moved.elements.find((r) => r.id === "arr")!;
    expect(written.startBinding).toEqual({ elementId: "A", focus: 0, gap: 1, fixedPoint: [1.01, 0.2] });
    expect(written.endBinding).toEqual({ elementId: "B", focus: 0, gap: 1, fixedPoint: [-0.01, 0.5] });
  });

  it("moving A instead keeps the pinned detour in place on the board, re-expressed from the arrow's new origin", () => {
    const rows = detour();
    const moved = must(expandServerEdits([{ op: "edit", id: "A", y: 50 }], rows, deps()));
    const row = restore(rowsOf(rows, moved.elements)).find((r) => r.id === "arr")!;
    const pts = worldPoints(row);
    expect(pts[0]).toEqual({ x: 101, y: 70 });
    expect(pts.at(-1)).toEqual({ x: 499, y: 50 });                                // B did not move: its end is untouched
    expect(pinnedWorld(row)).toEqual([{ index: 3, start: [150, -100], end: [450, -100] }]);
    orthogonal(pts);
  });

  it("keeps a pin on the moved end's own segment when the new end still lies on its line", () => {
    const a = rawRect("A", 0, 0, 100, 100); const b = rawRect("B", 500, 0, 100, 100);
    const arrow = rawArrow({ x: 101, y: 20, width: 398, height: 20, points: [[0, 0], [199, 0], [199, 20], [398, 20]], elbowed: true,
      fixedSegments: [{ start: [199, 20], end: [398, 20], index: 3 }], startIsSpecial: false, endIsSpecial: false,
      startBinding: { elementId: "A", focus: 0, gap: 1, fixedPoint: [1.01, 0.2] }, endBinding: { elementId: "B", focus: 0, gap: 1, fixedPoint: [-0.01, 0.4] } });
    const rows = [a, b, arrow];
    const moved = must(expandServerEdits([{ op: "edit", id: "B", x: 560 }], rows, deps()));
    const row = restore(rowsOf(rows, moved.elements)).find((r) => r.id === "arr")!;
    expect(worldPoints(row)).toEqual([{ x: 101, y: 20 }, { x: 300, y: 20 }, { x: 300, y: 40 }, { x: 559, y: 40 }]);
    expect(pinnedWorld(row)).toEqual([{ index: 3, start: [300, 40], end: [559, 40] }]);
  });

  it("honours a fixedPoint on a ROTATED target, in the target's own turned frame", () => {
    const a = rawRect("A", 0, 0, 100, 100);
    const b = rawRect("B", 500, 0, 100, 60, { angle: Math.PI / 2 });
    const arrow = rawArrow({ x: 101, y: 50, width: 480, height: 45, points: [[0, 0], [240, 0], [240, -45], [480, -45]], elbowed: true, fixedSegments: null, startIsSpecial: null, endIsSpecial: null,
      startBinding: { elementId: "A", focus: 0, gap: 1, fixedPoint: [1.01, 0.5] }, endBinding: { elementId: "B", focus: 0, gap: 1, fixedPoint: [0.25, -0.02] } });
    const rows = [a, b, arrow];
    const moved = must(expandServerEdits([{ op: "edit", id: "B", y: 200 }], rows, deps()));
    const row = restore(rowsOf(rows, moved.elements)).find((r) => r.id === "arr")!;
    const pts = worldPoints(row);
    // Unturned, (0.25, -0.02) is (525, 198.8); turned a quarter about B's centre (550, 230) that is (581.2, 205).
    expect(pts.at(-1)!.x).toBeCloseTo(581.2, 6);
    expect(pts.at(-1)!.y).toBeCloseTo(205, 6);
    expect(pts[0]).toEqual({ x: 101, y: 50 });
    orthogonal(pts);
    expect((row.endBinding as { fixedPoint: number[] }).fixedPoint).toEqual([0.25, -0.02]);
  });

  it("keeps a plain multi-point arrow's interior points, carried along with its ends", () => {
    const a = rawRect("A", 0, 0, 100, 100); const b = rawRect("B", 500, 0, 100, 100);
    const arrow = rawArrow({ x: 101, y: 50, width: 398, height: 100, points: [[0, 0], [199, 100], [398, 0]], elbowed: false, startBinding: { elementId: "A", focus: 0, gap: 1 }, endBinding: { elementId: "B", focus: 0, gap: 1 } });
    const moved = must(expandServerEdits([{ op: "edit", id: "B", y: 100 }], [a, b, arrow], deps()));
    const pts = worldPoints(moved.elements.find((r) => r.id === "arr")!);
    expect(pts).toHaveLength(3);
    expect(pts[1]!.y).toBeGreaterThan(150);                                       // the bend went down with the far end
  });
});

describe("an AI sticky is the Portal's own Sticky Note (board-scene `note`)", () => {
  const must = (result: ReturnType<typeof expandServerEdits>) => { if (!result.ok) throw new Error(result.message); return result; };

  it("uses the Portal's paper colours, keeping the client-facing names", () => {
    expect(WHITEBOARD_STICKY_COLORS).toMatchObject({ yellow: WHITEBOARD_PAPER.yellow, green: WHITEBOARD_PAPER.green, blue: WHITEBOARD_PAPER.blue, pink: WHITEBOARD_PAPER.red, purple: WHITEBOARD_PAPER.violet });
    expect(Object.keys(WHITEBOARD_STICKY_COLORS).sort()).toEqual(["blue", "green", "orange", "pink", "purple", "yellow"]);
    expect(WHITEBOARD_PAPER).toEqual({ yellow: "#fff085", green: "#b9f8cf", blue: "#bedbff", red: "#ffc9c9", violet: "#ddd6ff" });
  });

  it("is 240 wide and 76 tall, borderless, roughness 0, with 20px #171717 text", () => {
    const made = must(expandServerEdits([{ op: "add_sticky", x: 0, y: 0, text: "Short", color: "purple" }], [], deps()));
    const box = made.elements.find((row) => row.type === "rectangle")!;
    const text = made.elements.find((row) => row.type === "text")!;
    expect(box).toMatchObject({ width: 240, height: 76, strokeColor: "transparent", roughness: 0, backgroundColor: WHITEBOARD_PAPER.violet, fillStyle: "solid", roundness: { type: 3 } });
    expect(text).toMatchObject({ fontSize: 20, strokeColor: WHITEBOARD_NOTE_INK, containerId: box.id });
    expect(WHITEBOARD_NOTE_INK).toBe("#171717");
  });

  it("grows to fit its text, never below 76", () => {
    const made = must(expandServerEdits([{ op: "add_sticky", x: 0, y: 0, text: "A note that is long enough to wrap onto several lines of a sticky", color: "yellow" }], [], deps()));
    const box = made.elements.find((row) => row.type === "rectangle")!;
    const text = made.elements.find((row) => row.type === "text")!;
    expect(box.width).toBe(240);
    expect(box.height as number).toBeGreaterThan(76);
    expect(box.height as number).toBeGreaterThanOrEqual((text.height as number) + 10);
  });

  it("labels a shape at the same 20px", () => {
    const shape = must(expandServerEdits([{ op: "add_shape", shapeKind: "ellipse", x: 0, y: 0, w: 200, h: 100 }], [], deps()));
    const labelled = must(expandServerEdits([{ op: "edit", id: shape.results[0]!.id, text: "Label" }], shape.elements.map((e, i) => ({ ...e, index: `a${i}` }) as StoredElement), deps()));
    expect(labelled.elements.find((row) => row.type === "text")!.fontSize).toBe(20);
  });
});
