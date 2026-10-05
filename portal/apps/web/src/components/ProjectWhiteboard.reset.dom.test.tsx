// @vitest-environment happy-dom
/**
 * #500 (client half): a restored board is an AUTHORITATIVE RESET of the editor, not a merge. The transport (socket, peers) stays; the editor
 * remounts on the restored scene and everything the old one held (pending saves, queued batches, undo, selection) is gone.
 * `Whiteboard` is stubbed with a board that behaves as the canvas does on teardown: it asks `discardSave` and otherwise flushes through `onSave`.
 */
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type BoardProps = Record<string, (...args: never[]) => unknown> & { initialData?: { elements: Array<Record<string, unknown>> } };
const h = vi.hoisted(() => ({
  boards: [] as Array<{ props: BoardProps; unmounted: boolean }>,
  handlers: null as null | Record<string, (...args: unknown[]) => void>,
  socket: { send: vi.fn((..._args: unknown[]) => Promise.resolve()), sendPresence: vi.fn(), close: vi.fn() },
  opened: 0,
  panels: [] as Array<{ open: boolean; readOnly: boolean }>,
  toasts: [] as string[],
  controllers: [] as Array<{ adoptRevisions: ReturnType<typeof vi.fn>; setCollaborators: ReturnType<typeof vi.fn> } & Record<string, unknown>>,
}));

vi.mock("../lib/whiteboard-socket", () => ({
  openWhiteboardSocket: (_project: string, handlers: Record<string, (...args: unknown[]) => void>) => { h.opened += 1; h.handlers = handlers; return h.socket; },
}));
vi.mock("../lib/toast-store", () => ({ pushToast: (message: string) => { h.toasts.push(message); } }));
vi.mock("./WhiteboardHistoryPanel", () => ({
  WhiteboardHistoryPanel: (props: { open: boolean; readOnly: boolean; onRestoreStarted: () => void; onRestoreFailed: () => void }) => {
    h.panels.push({ open: props.open, readOnly: props.readOnly });
    return props.open ? <div data-testid="fake-history"><button type="button" data-testid="fake-start" onClick={props.onRestoreStarted} /><button type="button" data-testid="fake-fail" onClick={props.onRestoreFailed} /></div> : null;
  },
}));
vi.mock("./quincy/CopyProjectLinkButton", () => ({ CopyProjectLinkButton: () => null }));
vi.mock("./reui/whiteboard/whiteboard", () => ({
  Whiteboard: (props: BoardProps) => {
    const record = useRef<{ props: BoardProps; unmounted: boolean } | null>(null);
    if (!record.current) { record.current = { props, unmounted: false }; h.boards.push(record.current); }
    record.current.props = props;
    useEffect(() => {
      const controller = { adoptRevisions: vi.fn(), setCollaborators: vi.fn(), applyRemote: vi.fn(() => []), applyLocal: vi.fn(() => []), author: vi.fn(), api: { getAppState: () => ({}) } };
      h.controllers.push(controller);
      (props.onReady as unknown as (c: unknown) => void)(controller);
      const mine = record.current!;
      return () => {
        mine.unmounted = true;
        // What the canvas does at teardown: a discarded board sends nothing, any other flushes.
        if (!(mine.props.discardSave as unknown as (() => boolean) | undefined)?.()) void (mine.props.onSave as unknown as () => unknown)();
      };
    }, []);
    return null;
  },
}));

import { ProjectWhiteboard } from "./ProjectWhiteboard";

const el = (id: string, version: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, index: "a0", version, versionNonce: version, isDeleted: false, seed: 1, ...extra });
const init = (generation: number, elements: unknown[], peers: unknown[] = []) => ({ mode: "edit" as const, generation, elements, sessionId: "me", peers });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.boards.length = 0; h.panels.length = 0; h.handlers = null; h.opened = 0; h.toasts.length = 0; h.controllers.length = 0;
  h.socket.send.mockClear(); h.socket.close.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

async function mount() {
  await act(async () => { root.render(<ProjectWhiteboard projectId="p1" street="1 Writes Street" onClose={() => undefined} onAccessFailure={() => undefined} />); });
  await act(async () => { h.handlers!.onInit!(init(1, [el("a", 1), el("keep", 1)]), false); await Promise.resolve(); });
}
const live = () => h.boards.filter((board) => !board.unmounted);

describe("ProjectWhiteboard: board reset (#500)", () => {
  it("remounts only the editor on the restored scene, keeps the one socket, and says what happened", async () => {
    await mount();
    expect(live()).toHaveLength(1);
    await act(async () => { h.handlers!.onReset!({ generation: 2, elements: [el("keep", 1)] }); });
    expect(h.opened).toBe(1);
    expect(h.socket.close).not.toHaveBeenCalled();
    expect(live()).toHaveLength(1);
    expect(h.boards).toHaveLength(2);
    expect(live()[0]!.props.initialData!.elements.map((element) => element.id)).toEqual(["keep"]);
    expect(h.controllers.at(-1)!.adoptRevisions).toHaveBeenCalledWith([expect.objectContaining({ id: "keep" })]);
    expect(h.toasts).toEqual(["Board restored"]);
  });

  it("a client with an unsaved edit is told it was replaced; with a clean board it just reads \"Board restored\"", async () => {
    await mount();
    await act(async () => { (live()[0]!.props.onSaveStatusChange as unknown as (s: string) => void)("unsaved"); });
    await act(async () => { h.handlers!.onReset!({ generation: 2, elements: [el("keep", 1)] }); });
    expect(h.toasts).toEqual(["Board restored — your unsaved changes were replaced"]);
    // The reset cleared it: the next reset, with nothing pending, is plain.
    await act(async () => { h.handlers!.onReset!({ generation: 3, elements: [el("keep", 1)] }); });
    expect(h.toasts.at(-1)).toBe("Board restored");
  });

  it("discards a pending save: the old editor's teardown flush sends nothing, and the saver seeds from the restored scene", async () => {
    await mount();
    // The person drew "mine" and has not saved it.
    (live()[0]!.props.onElements as unknown as (e: unknown[]) => void)([el("a", 1), el("keep", 1), el("mine", 3)]);
    await act(async () => { h.handlers!.onReset!({ generation: 2, elements: [el("keep", 1)] }); });
    await act(async () => { await Promise.resolve(); });
    expect(h.socket.send).not.toHaveBeenCalled();
    // The new editor reports the restored scene as it loaded it: still nothing to send.
    await act(async () => { await (live()[0]!.props.onSave as unknown as () => Promise<unknown>)(); });
    expect(h.socket.send).not.toHaveBeenCalled();
  });

  it("a stale onSave from the replaced editor, run late, never sends its scene or the shape that was deleted by the restore", async () => {
    await mount();
    const old = live()[0]!;
    (old.props.onElements as unknown as (e: unknown[]) => void)([el("a", 1), el("keep", 1), el("mine", 3)]);
    await act(async () => { h.handlers!.onReset!({ generation: 2, elements: [el("keep", 1)] }); });
    await act(async () => { await (old.props.onSave as unknown as () => Promise<unknown>)(); (old.props.onElements as unknown as (e: unknown[]) => void)([el("a", 9)]); });
    expect(h.socket.send).not.toHaveBeenCalled();
  });

  it("seals every later save for the new generation, so a stale session cannot be stamped with it", async () => {
    await mount();
    await act(async () => { h.handlers!.onReset!({ generation: 2, elements: [el("keep", 1)] }); });
    (live()[0]!.props.onElements as unknown as (e: unknown[]) => void)([el("keep", 1), el("new", 1)]);
    await act(async () => { await (live()[0]!.props.onSave as unknown as () => Promise<unknown>)(); });
    expect(h.socket.send).toHaveBeenCalledTimes(1);
    expect(h.socket.send.mock.calls[0]![1]).toBe(2);
  });

  it("a reconnect whose init is a newer generation is a reset, not a merge", async () => {
    await mount();
    (live()[0]!.props.onElements as unknown as (e: unknown[]) => void)([el("a", 1), el("keep", 1), el("mine", 3)]);
    await act(async () => { h.handlers!.onInit!(init(2, [el("keep", 1)]), true); });
    expect(live()).toHaveLength(1);
    expect(h.boards).toHaveLength(2);
    expect(live()[0]!.props.initialData!.elements.map((element) => element.id)).toEqual(["keep"]);
    expect(h.toasts).toHaveLength(1);
  });

  it("a reconnect on the same generation keeps the editor", async () => {
    await mount();
    await act(async () => { h.handlers!.onInit!(init(1, [el("a", 2)]), true); });
    expect(h.boards).toHaveLength(1);
    expect(h.toasts).toEqual([]);
  });
});

describe("ProjectWhiteboard: History (#500)", () => {
  const historyButton = () => document.body.querySelector<HTMLButtonElement>('[data-testid="project-whiteboard-history"]');
  const click = async (element: Element | null) => { await act(async () => { (element as HTMLElement).click(); }); };

  it("does not load or render the history panel until the History button is used, then opens it", async () => {
    await mount();
    expect(h.panels).toHaveLength(0);
    expect(historyButton()).not.toBeNull();
    await click(historyButton());
    expect(h.panels.at(-1)).toEqual({ open: true, readOnly: false });
    expect(document.body.querySelector('[data-testid="fake-history"]')).not.toBeNull();
  });

  it("a view-only board tells the panel to omit Restore", async () => {
    await mount();
    await act(async () => { h.handlers!.onMode!("view"); });
    await click(historyButton());
    expect(h.panels.at(-1)).toEqual({ open: true, readOnly: true });
  });

  it("the person who restored sees \"Board restored\" when the reset frame beats the response", async () => {
    await mount();
    await click(historyButton());
    await click(document.body.querySelector('[data-testid="fake-start"]'));
    await act(async () => { h.handlers!.onReset!({ generation: 2, elements: [el("keep", 1)] }); });
    expect(h.toasts).toEqual(["Board restored"]);
  });

  it("a failed restore clears the flag, so the next reset (someone else's) reads as replaced changes", async () => {
    await mount();
    await click(historyButton());
    await click(document.body.querySelector('[data-testid="fake-start"]'));
    await click(document.body.querySelector('[data-testid="fake-fail"]'));
    await act(async () => { (live()[0]!.props.onSaveStatusChange as unknown as (s: string) => void)("saving"); });
    await act(async () => { h.handlers!.onReset!({ generation: 2, elements: [el("keep", 1)] }); });
    expect(h.toasts).toEqual(["Board restored — your unsaved changes were replaced"]);
  });
});
