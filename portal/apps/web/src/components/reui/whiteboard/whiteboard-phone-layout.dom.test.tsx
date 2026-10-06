/**
 * #564: the REAL `WhiteboardCanvas` decides `data-phone-layout` on the board root from the size it learns
 * (`isPhoneLayout`), and the root's theme carries the rule that turns that into the 44px control size.
 * The editor is replaced by a stub that reports its size through the same `onChange(elements, appState)`
 * the real one does; everything else (the chrome state, the layout effect, the root attribute) is production code.
 *
 * happy-dom has no layout, so the rendered pixel sizes (about 32px on desktop, 44px on the phone) are NOT
 * asserted here: they are measured in the browser pass at 1280 -> 390 -> 1280.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EditorProps = { onChange: (elements: readonly unknown[], appState: Record<string, unknown>) => void; children?: ReactNode };
const editor: { props: EditorProps | null } = { props: null };

// The real editor needs layout and its own module graph; this board only needs its `onChange` contract, so every
// other export it imports is an inert stand-in (none is exercised by a resize).
vi.mock("@excalidraw/excalidraw", () => {
  const inert = () => ({});
  const Excalidraw = (props: EditorProps) => { editor.props = props; return null; };
  const names = ["CaptureUpdateAction", "convertToExcalidrawElements", "defaultLang", "DefaultSidebar", "exportToBlob",
    "exportToClipboard", "exportToSvg", "getCommonBounds", "getNonDeletedElements", "hashElementsVersion",
    "reconcileElements", "isElementLink", "languages", "loadSceneOrLibraryFromBlob", "MainMenu", "MIME_TYPES",
    "newElementWith", "normalizeLink", "restoreElements", "serializeAsJSON", "serializeLibraryAsJSON",
    "UserIdleState", "viewportCoordsToSceneCoords", "WelcomeScreen"];
  return { Excalidraw, ...Object.fromEntries(names.map((name) => [name, Object.assign(inert, {})])) };
});
vi.mock("@excalidraw/excalidraw/index.css", () => ({}));

import { WhiteboardCanvas } from "./whiteboard-canvas";
import { WHITEBOARD_THEME } from "./whiteboard-theme";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
let board: { current: HTMLDivElement | null };
let size = { width: 1280, height: 800 };

const appState = () => ({
  activeTool: { type: "selection" }, zoom: { value: 1 }, gridModeEnabled: true, objectsSnapModeEnabled: false,
  viewModeEnabled: false, selectedElementIds: {}, penMode: false, penDetected: false,
  scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, openDialog: null, openSidebar: null, toast: null,
  ...size,
});

const resizeTo = async (width: number, height: number) => {
  size = { width, height };
  await act(async () => { editor.props!.onChange([], appState()); await Promise.resolve(); });
};

beforeEach(async () => {
  size = { width: 1280, height: 800 };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ ...size, x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, toJSON: () => ({}) }) as DOMRect,
  );
  board = { current: null };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <div ref={(el) => { board.current = el; }} className={WHITEBOARD_THEME}>
        <WhiteboardCanvas rootRef={board as never} theme="light" initialZoom={1} onLoaded={() => {}} />
      </div>,
    );
    await Promise.resolve();
  });
});
afterEach(async () => { await act(async () => { root!.unmount(); }); host.remove(); root = null; vi.restoreAllMocks(); });

const phone = () => board.current!.hasAttribute("data-phone-layout");

describe("the mounted board's phone layout (#564)", () => {
  it("1280 -> 390 -> 1280: the attribute is set at 390 and removed again at 1280", async () => {
    expect(phone()).toBe(false);
    await resizeTo(390, 800);
    expect(phone()).toBe(true);
    await resizeTo(1280, 800);
    expect(phone()).toBe(false);
  });

  it("follows the board's own size, not the viewport: a narrow board in a wide window is a phone board", async () => {
    window.innerWidth = 1280;
    await resizeTo(600, 800);
    expect(phone()).toBe(true);
    window.innerWidth = 390;
    await resizeTo(900, 800);
    expect(phone()).toBe(false);
  });

  it("the root carries the rule that makes the phone attribute 44px, and no unconditional size", () => {
    expect(board.current!.className).toContain("data-[phone-layout]:[--wb-control-size:44px]");
    expect(board.current!.className).not.toMatch(/(^|\s)\[--wb-control-size:/);
    expect(board.current!.style.getPropertyValue("--wb-control-size")).toBe("");
  });
});
