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
});
