// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * #501: the production canvas controller's media methods (`insertMedia`, `addMediaFiles`, `videoAt`, `selectedVideo`, and the scene
 * file's refusal of another board's media) over a fake editor API and the INSTALLED Excalidraw functions, in the way
 * `whiteboard-authorship.test.ts` drives the controller.
 */
let canvas: typeof import("./whiteboard-canvas");
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  canvas = await import("./whiteboard-canvas");
});

const IMG = "11111111-1111-4111-8111-111111111111";
const VID = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
type El = Record<string, any>;
const videoEl = (id: string, extra: El = {}): El => ({ id, type: "image", fileId: VID, customData: { quincyMedia: { kind: "video" } }, x: 100, y: 100, width: 400, height: 200, angle: 0, isDeleted: false, version: 1, versionNonce: 1, ...extra });

function setup({ editable = true, elements = [] as El[], appState = {} as El } = {}) {
  let scene = elements;
  const calls: string[] = [];
  const state: El = { width: 1000, height: 800, zoom: { value: 1 }, scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, selectedElementIds: {}, activeTool: { type: "selection" }, ...appState };
  const files: Record<string, unknown> = {};
  const updates: El[] = [];
  const api = {
    onChange: () => () => undefined, getSceneElementsIncludingDeleted: () => scene,
    getSceneElements: () => scene.filter((element) => element.isDeleted !== true),
    getAppState: () => state,
    getFiles: () => files,
    updateScene: (update: El) => { calls.push("updateScene"); updates.push(update); if (update.elements) scene = update.elements; },
    addFiles: (list: Array<{ id: string }>) => { calls.push("addFiles"); for (const file of list) files[file.id] = file; },
  };
  const armed = vi.fn();
  const controller = canvas.createController(api as never, { root: () => null, arm: armed, panel: () => undefined, library: () => [], editable: () => editable, remoteApplied: () => undefined, knownMedia: (id) => scene.some((element) => element.fileId === id) });
  return { controller, calls, updates, files, state, armed, get scene() { return scene; } };
}
const file = (id: string) => ({ id, mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 });

describe("insertMedia (#501)", () => {
  it("appends ONE saved image element that references the media, then adds the file, without touching selection or scroll", () => {
    const board = setup();
    const placed = board.controller.insertMedia({ fileId: IMG, kind: "image", file: file(IMG), width: 4000, height: 3000, at: { x: 500, y: 400 } });
    expect(placed).toEqual(expect.any(String));
    expect(board.scene).toHaveLength(1);
    expect(board.scene[0]).toMatchObject({ type: "image", fileId: IMG, status: "saved", customData: { quincyMedia: { kind: "image" } }, isDeleted: false });
    expect(board.calls).toEqual(["updateScene", "addFiles"]);                      // the editor scans the scene for uncached images, so the element goes first
    expect(board.updates[0]!.captureUpdate).toBeDefined();
    expect(board.updates[0]!.appState).toBeUndefined();                              // no selection, no scroll: a finished upload must not steal either
    expect(board.files[IMG]).toBeDefined();
    expect(board.armed).toHaveBeenCalled();
  });

  it("sizes it to about 40% of the view's short side, keeps the aspect, never above natural size, and centres it on the point", () => {
    const big = setup();
    big.controller.insertMedia({ fileId: IMG, kind: "image", file: file(IMG), width: 4000, height: 2000, at: { x: 500, y: 400 } });
    const element = big.scene[0]!;
    expect(Math.max(element.width, element.height)).toBeCloseTo(320, -1);          // 0.4 x min(1000, 800)
    expect(element.width / element.height).toBeCloseTo(2, 1);
    expect(element.x + element.width / 2).toBeCloseTo(500, 0); expect(element.y + element.height / 2).toBeCloseTo(400, 0);
    const small = setup();
    small.controller.insertMedia({ fileId: IMG, kind: "image", file: file(IMG), width: 120, height: 60 });
    expect(small.scene[0]).toMatchObject({ width: 120, height: 60 });
  });

  it("a later file of one choice sits a step down and right, and refuses everything in view-only mode", () => {
    const board = setup();
    board.controller.insertMedia({ fileId: IMG, kind: "image", file: file(IMG), width: 100, height: 100, at: { x: 300, y: 300 }, cascade: 0 });
    board.controller.insertMedia({ fileId: VID, kind: "video", file: file(VID), width: 100, height: 100, at: { x: 300, y: 300 }, cascade: 2 });
    expect(board.scene[1]!.x - board.scene[0]!.x).toBeGreaterThan(0);
    expect(board.scene[1]!.y - board.scene[0]!.y).toBeGreaterThan(0);
    const view = setup({ editable: false });
    expect(view.controller.insertMedia({ fileId: IMG, kind: "image", file: file(IMG), width: 100, height: 100 })).toBeNull();
    expect(view.scene).toEqual([]); expect(view.calls).toEqual([]);
  });

  it("addMediaFiles hands the editor only the files it does not already hold", () => {
    const board = setup();
    board.controller.addMediaFiles([file(IMG)]);
    board.controller.addMediaFiles([file(IMG), file(VID)]);
    expect(Object.keys(board.files).sort()).toEqual([IMG, VID].sort());
    expect(board.calls).toEqual(["addFiles", "addFiles"]);
  });
});

describe("videoAt and selectedVideo (#501)", () => {
  it("in view-only mode the whole video element opens it; outside it nothing does", () => {
    const board = setup({ editable: false, elements: [videoEl("v")] });
    expect(board.controller.videoAt(150, 120)).toBe(VID);                            // a corner, far from the badge
    expect(board.controller.videoAt(50, 50)).toBeNull();
  });

  it("while editing, only the play badge opens it, and only with the selection or hand tool", () => {
    const board = setup({ elements: [videoEl("v")] });
    expect(board.controller.videoAt(300, 200)).toBe(VID);                            // the centre: the badge
    expect(board.controller.videoAt(150, 120)).toBeNull();                           // elsewhere on the poster: a click selects or drags
    const drawing = setup({ elements: [videoEl("v")], appState: { activeTool: { type: "rectangle" } } });
    expect(drawing.controller.videoAt(300, 200)).toBeNull();
    const hand = setup({ elements: [videoEl("v")], appState: { activeTool: { type: "hand" } } });
    expect(hand.controller.videoAt(300, 200)).toBe(VID);
  });

  it("keeps a zoom-independent minimum play target while editing (22 CSS px)", () => {
    // videoEl is 400x200 centred on scene (300,200): the scene badge radius is 0.13 * 200 = 26. At zoom 0.25 the floor is 22 / 0.25 = 88 scene units.
    const out = setup({ elements: [videoEl("v")], appState: { zoom: { value: 0.25 } } });
    // Scene (300 + 60, 200) is 60 scene units (15 CSS px) off centre: outside the scene radius, inside the CSS-pixel floor.
    expect(out.controller.videoAt(360 * 0.25, 200 * 0.25)).toBe(VID);
    expect(out.controller.videoAt(300 * 0.25 + 30, 200 * 0.25)).toBeNull();        // 30 CSS px away: beyond the floor
    const full = setup({ elements: [videoEl("v")] });
    expect(full.controller.videoAt(360, 200)).toBeNull();                          // at zoom 1 the scene radius (26) still rules
  });

  it("follows the viewport (scroll and zoom) and the element's rotation, and skips deleted videos and images", () => {
    const moved = setup({ editable: false, elements: [videoEl("v")], appState: { scrollX: -100, scrollY: 0, zoom: { value: 2 } } });
    // Scene (300,200) sits at screen ((300 + scrollX) * zoom) = 400, 400.
    expect(moved.controller.videoAt(400, 400)).toBe(VID);
    expect(moved.controller.videoAt(50, 50)).toBeNull();
    const turned = setup({ editable: false, elements: [videoEl("v", { angle: Math.PI / 2 })] });
    expect(turned.controller.videoAt(300, 340)).toBe(VID);                           // inside the rotated 200-wide, 400-tall footprint
    expect(turned.controller.videoAt(480, 200)).toBeNull();                          // inside the unrotated one only
    const skipped = setup({ editable: false, elements: [videoEl("v", { isDeleted: true }), { ...videoEl("i"), customData: { quincyMedia: { kind: "image" } } }] });
    expect(skipped.controller.videoAt(300, 200)).toBeNull();
  });

  it("the topmost element under the point decides: an opaque image over the badge hides the video, a transparent shape does not, a video above an image wins", () => {
    const image = { id: "i", type: "image", fileId: IMG, customData: { quincyMedia: { kind: "image" } }, x: 250, y: 150, width: 100, height: 100, angle: 0, isDeleted: false };
    const covered = setup({ editable: false, elements: [videoEl("v"), image] });
    expect(covered.controller.videoAt(300, 200)).toBeNull();                         // the image sits over the badge
    expect(covered.controller.videoAt(150, 120)).toBe(VID);                          // away from the image the video is still hit
    const glass = { id: "r", type: "rectangle", backgroundColor: "transparent", x: 250, y: 150, width: 100, height: 100, angle: 0, isDeleted: false };
    expect(setup({ editable: false, elements: [videoEl("v"), glass] }).controller.videoAt(300, 200)).toBe(VID);
    expect(setup({ editable: false, elements: [videoEl("v"), { ...glass, backgroundColor: "#ffffff" }] }).controller.videoAt(300, 200)).toBeNull();
    const frame = { ...glass, type: "frame", backgroundColor: "#ffffff" };
    expect(setup({ editable: false, elements: [videoEl("v"), frame] }).controller.videoAt(300, 200)).toBe(VID);
    const above = setup({ elements: [image, videoEl("v")] });
    expect(above.controller.videoAt(300, 200)).toBe(VID);                            // video over image
  });

  it("selectedVideo is the media id of exactly one selected video, else null", () => {
    const one = setup({ elements: [videoEl("v")], appState: { selectedElementIds: { v: true } } });
    expect(one.controller.selectedVideo()).toBe(VID);
    const two = setup({ elements: [videoEl("v"), videoEl("w")], appState: { selectedElementIds: { v: true, w: true } } });
    expect(two.controller.selectedVideo()).toBeNull();
    const image = setup({ elements: [{ ...videoEl("v"), customData: { quincyMedia: { kind: "image" } } }], appState: { selectedElementIds: { v: true } } });
    expect(image.controller.selectedVideo()).toBeNull();
    const none = setup({ elements: [videoEl("v")] });
    expect(none.controller.selectedVideo()).toBeNull();
  });
});
