import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardMode, WhiteboardPeer } from "@quincy/shared";
import { ApiError } from "../lib/api";
import { ProjectWhiteboard } from "./ProjectWhiteboard";

/**
 * #499: the live half of the Project whiteboard shell. The socket and the Excalidraw block are stood in
 * (DOM tests never open a real socket: lessons #498); what is asserted is what the shell does with what the
 * server sends: merge remote elements without echoing them, buffer until the board is ready, show peers, flip to
 * view-only, and on a reconnect catch up BEFORE retrying local edits.
 */
type Handlers = {
  onInit: (init: { mode: WhiteboardMode; elements: unknown[]; sessionId: string; peers: WhiteboardPeer[] }, reconnect: boolean) => void;
  onConnection: (state: string) => void;
  onDeleted: () => void;
  onAccessFailure: (error: unknown) => void;
  onElements: (elements: Array<Record<string, unknown>>) => void;
  onPresence: (peer: WhiteboardPeer) => void;
  onPeerLeft: (sessionId: string) => void;
  onMode: (mode: WhiteboardMode) => void;
};
type Collaborator = { id: string; name: string; colorKey?: string; pointer?: { x: number; y: number }; selectedIds?: readonly string[]; pressed?: boolean };
const board = vi.hoisted(() => ({
  log: [] as string[],
  handlers: null as unknown,
  scene: [] as Array<Record<string, unknown>>,
  send: null as null | ((batch: readonly unknown[]) => Promise<void>),
  sentBatches: [] as unknown[][],
  sentPresence: [] as unknown[],
  deferReady: false,
  props: null as null | { readOnly?: boolean; onSave?: () => Promise<void | "skipped">; onElements?: (e: unknown[]) => void; onPresence?: (p: unknown) => void; onReady?: (c: unknown) => void },
  collaborators: [] as Collaborator[][],
  applied: [] as unknown[][],
  initMode: "edit" as WhiteboardMode,
  initPeers: [] as unknown[],
  initElements: [] as unknown[],
  adopted: [] as Array<{ arrived: unknown[]; appliedBefore: number }>,
  localApplied: [] as unknown[][],
  editingId: null as string | null,
  dropsZero: false,
}));
vi.mock("../lib/whiteboard-socket", () => ({
  openWhiteboardSocket: (_projectId: string, handlers: unknown) => {
    board.handlers = handlers;
    queueMicrotask(() => { const h = handlers as Handlers; h.onConnection("open"); h.onInit({ mode: board.initMode, elements: board.initElements, sessionId: "me", peers: board.initPeers as WhiteboardPeer[] }, false); });
    return {
      send: (batch: readonly unknown[]) => { board.log.push("send"); board.sentBatches.push([...batch]); return board.send ? board.send(batch) : Promise.resolve(); },
      sendPresence: (state: unknown) => { board.sentPresence.push(state); },
      close: () => { board.log.push("close"); },
    };
  },
}));
const controller = () => ({
  api: { getAppState: () => ({ editingTextElement: board.editingId ? { id: board.editingId } : null, resizingElement: null, newElement: null }) },
  adoptRevisions: (arrived: unknown[]) => { board.adopted.push({ arrived, appliedBefore: board.applied.length }); },
  applyRemote: (remote: Array<Record<string, unknown>>) => {
    board.log.push("applyRemote"); board.applied.push(remote);
    // Like Excalidraw's reconcile: an element being edited here is not replaced by a remote one.
    let taken = remote.filter((entry) => entry.id !== board.editingId);
    // #499: Excalidraw's restoreElements drops a live 0x0 element, and the merge then takes the local copy it beat out of the scene (a fresh load shows neither).
    const zero = (entry: Record<string, unknown>) => board.dropsZero && entry.width === 0 && entry.height === 0 && entry.isDeleted !== true;
    const ids = new Set(taken.map((entry) => entry.id));
    taken = taken.filter((entry) => !zero(entry));
    board.scene = [...board.scene.filter((entry) => !ids.has(entry.id)), ...taken];
    return board.scene;
  },
  // #499: the editor's own deletion, and its merge as the person's own change (never recorded as remote).
  author: (element: Record<string, unknown>, updates: Record<string, unknown>) => ({ ...element, ...updates, version: (element.version as number) + 1, versionNonce: 999 }),
  applyLocal: (local: Array<Record<string, unknown>>) => {
    board.log.push("applyLocal"); board.localApplied.push(local);
    const ids = new Set(local.map((entry) => entry.id));
    board.scene = [...board.scene.filter((entry) => !ids.has(entry.id)), ...local];
    return board.scene;
  },
  setCollaborators: (people: Collaborator[]) => { board.collaborators.push(people); },
});
vi.mock("./reui/whiteboard/whiteboard", () => ({
  Whiteboard: (props: NonNullable<typeof board.props>) => {
    board.props = props;
    props.onElements?.(board.scene);
    if (!board.deferReady) props.onReady?.(controller());
    return <div data-testid="whiteboard-stand-in">board</div>;
  },
}));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const handlers = () => board.handlers as Handlers;
const settle = (ms = 0) => act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
const el = (id: string, version: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", version, versionNonce: version * 11, isDeleted: false, ...extra });
const peer = (overrides: Partial<WhiteboardPeer> = {}): WhiteboardPeer => ({ sessionId: "s2", userId: "u2", name: "Ana", pointer: { x: 3, y: 4 }, button: "up", selectedIds: ["a"], ...overrides });
const onAccessFailure = vi.fn();
const onClose = vi.fn();

async function mount() {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<ProjectWhiteboard projectId="p1" street="12 Example St" onClose={onClose} onAccessFailure={onAccessFailure} />); await Promise.resolve(); });
  for (let i = 0; i < 20 && !document.querySelector('[data-testid="whiteboard-stand-in"]'); i += 1) await settle();
}

beforeEach(() => {
  Object.assign(board, { log: [], handlers: null, scene: [], send: null, sentBatches: [], sentPresence: [], deferReady: false, props: null, collaborators: [], applied: [], initMode: "edit", initPeers: [], initElements: [], adopted: [], localApplied: [], editingId: null, dropsZero: false });
  onAccessFailure.mockReset(); onClose.mockReset();
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; document.body.replaceChildren(); });

describe("an element the editor drops with no tombstone is deleted by the person's own change (#499, re-plan 2)", () => {
  it("authors the editor-style deletion at observation time, puts it on the board as a local change, and sends exactly it", async () => {
    board.initElements = [el("a", 3), el("b", 1)]; board.scene = [el("a", 3), el("b", 1)];
    await mount();
    board.props!.onElements!([el("b", 1)]);                          // a resized to zero: the editor drops it with no tombstone
    expect(board.localApplied).toEqual([[expect.objectContaining({ id: "a", isDeleted: true, version: 4, versionNonce: 999 })]]);
    expect(board.applied).toEqual([]);                                // a local change, not a remote one
    await act(async () => { await board.props!.onSave!(); });
    const sent = (board.sentBatches as unknown[][]).flat() as Array<{ id: string; isDeleted?: boolean; version: number }>;
    expect(sent).toEqual([expect.objectContaining({ id: "a", isDeleted: true, version: 4 })]);
  });

  it("deletes nothing at teardown, and nothing the server never held", async () => {
    board.initElements = [el("a", 3)]; board.scene = [el("a", 3)];
    await mount();
    board.props!.onElements!([el("a", 3), el("fresh", 1)]);          // fresh was drawn here and never saved
    board.props!.onElements!([el("a", 3)]);                           // and removed again before any save
    expect(board.localApplied).toEqual([]);
    const props = board.props!;
    await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null;
    props.onElements!([]);                                            // the unmounting editor reports an empty scene
    expect(board.localApplied).toEqual([]);
  });
});

describe("unmounting sends close on the socket once the final flush settles (#500)", () => {
  const unmountWithUnsavedEdit = async () => {
    await mount();
    board.props!.onElements!([el("fresh", 1)]);                       // an edit not yet saved: the unmount flush has something to send
    vi.useFakeTimers();
    await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null;
  };
  afterEach(() => { vi.useRealTimers(); });

  it("closes only after the in-flight save settles", async () => {
    let finish: () => void = () => undefined;
    board.send = () => new Promise<void>((resolve) => { finish = resolve; });
    await unmountWithUnsavedEdit();
    expect(board.log).toContain("send");
    expect(board.log).not.toContain("close");                         // the flush is still waiting on its ack
    await vi.advanceTimersByTimeAsync(5_000);
    expect(board.log).not.toContain("close");
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(board.log.filter((entry) => entry === "close")).toHaveLength(1);
  });

  it("still closes when the save ack never arrives, bounded by the 10s final-flush timeout", async () => {
    board.send = () => new Promise<void>(() => undefined);            // never acknowledged
    await unmountWithUnsavedEdit();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(board.log).not.toContain("close");
    await vi.advanceTimersByTimeAsync(2);
    expect(board.log.filter((entry) => entry === "close")).toHaveLength(1);
  });
});

describe("a remote winner the renderer drops (a live 0x0 element, #499)", () => {
  it("is merged once however many change events follow, and neither deleted by this tab nor sent", async () => {
    board.dropsZero = true;
    board.initElements = [el("a", 8, { width: 250, height: 167 })]; board.scene = [el("a", 8, { width: 250, height: 167 })];
    await mount();
    await act(async () => { handlers().onElements([el("a", 9, { width: 0, height: 0 })]); });
    for (let change = 0; change < 3; change += 1) board.props!.onElements!(board.scene);          // the editor's change events
    expect(board.applied).toHaveLength(1);
    expect(board.localApplied).toEqual([]);
    await act(async () => { await board.props!.onSave!(); });
    expect(board.sentBatches.flat()).toEqual([]);
  });
});

describe("remote elements (#499)", () => {
  it("merges another person's elements into the board and never sends them back", async () => {
    await mount();
    await act(async () => { handlers().onElements([el("theirs", 3)]); });
    expect(board.applied).toEqual([[el("theirs", 3)]]);
    await act(async () => { await board.props!.onSave!(); });
    expect(board.log).not.toContain("send");
  });

  it("buffers remote elements until the board is ready, then applies them in order", async () => {
    board.deferReady = true;
    await mount();
    await act(async () => { handlers().onElements([el("a", 1)]); handlers().onElements([el("b", 1)]); });
    expect(board.applied).toEqual([]);
    await act(async () => { board.props!.onReady!(controller()); });
    expect(board.applied.flat().map((entry) => (entry as { id: string }).id)).toEqual(["a", "b"]);
  });

  it("keeps buffered batches apart: two versions of one element arriving before the board is ready are applied in order, never merged into one call", async () => {
    board.deferReady = true;
    await mount();
    await act(async () => { handlers().onElements([el("same", 1, { x: 1 })]); handlers().onElements([el("same", 2, { x: 2 })]); });
    await act(async () => { board.props!.onReady!(controller()); });
    expect(board.applied).toEqual([[el("same", 1, { x: 1 })], [el("same", 2, { x: 2 })]]);
    expect(board.scene).toEqual([el("same", 2, { x: 2 })]);
  });

  it("replays a remote winner that was skipped while the person was editing that element, once editing ends", async () => {
    await mount();
    board.scene = [el("text", 1, { text: "mine" })]; board.props!.onElements!(board.scene);
    board.editingId = "text";
    await act(async () => { handlers().onElements([el("text", 3, { text: "theirs" })]); });
    expect(board.scene).toEqual([el("text", 1, { text: "mine" })]);              // skipped: being edited
    board.props!.onElements!(board.scene);                                          // still editing: nothing replays
    expect(board.applied).toHaveLength(1);
    board.editingId = null;                                                         // Alice leaves the text without typing
    await act(async () => { board.props!.onElements!(board.scene); });
    expect(board.applied).toHaveLength(2);
    expect(board.scene).toEqual([el("text", 3, { text: "theirs" })]);
    // and it is recorded as stored: nothing is echoed
    await act(async () => { await board.props!.onSave!(); });
    expect(board.log).not.toContain("send");
  });

  it("drops a deferred winner once a newer local version exists, instead of replaying it", async () => {
    await mount();
    board.scene = [el("text", 1)]; board.props!.onElements!(board.scene);
    board.editingId = "text";
    await act(async () => { handlers().onElements([el("text", 2)]); });
    board.scene = [el("text", 5)]; board.editingId = null;
    await act(async () => { board.props!.onElements!(board.scene); });
    expect(board.applied).toHaveLength(1);
  });

  it("does not drop a local edit the remote batch lost to: it is still sent", async () => {
    await mount();
    board.scene = [el("mine", 5, { x: 1 })];
    board.props!.onElements!(board.scene);
    await act(async () => { handlers().onElements([el("mine", 2, { x: 9 })]); });   // the real merge keeps the local v5 (the stand-in does not)
    board.scene = [el("mine", 5, { x: 1 })]; board.props!.onElements!(board.scene);
    await act(async () => { await board.props!.onSave!(); });
    expect(board.log).toContain("send");
  });
});

describe("revisions the server sent (#499)", () => {
  it("puts the loaded board back at the server's revisions as soon as the editor is ready, before any buffered remote batch", async () => {
    board.initElements = [el("stored", 4)]; board.scene = [el("stored", 4)]; board.deferReady = true;   // the editor holds what it loaded
    await mount();
    await act(async () => { handlers().onElements([el("late", 1)]); });
    await act(async () => { board.props!.onReady!(controller()); });
    expect(board.adopted[0]).toEqual({ arrived: [el("stored", 4)], appliedBefore: 0 });   // nothing remote had been merged yet
    expect(board.applied).toHaveLength(1);
  });

  it("sends a save the server refused as stale again on the next flush, with no new edit in between", async () => {
    await mount();
    board.scene = [el("mine", 2, { x: 5 })]; board.props!.onElements!(board.scene);
    const sent: unknown[][] = [];
    board.send = async (batch) => { sent.push([...batch]); if (sent.length === 1) throw new Error("The board was changing; the change will be sent again."); };
    await act(async () => { await board.props!.onSave!().catch(() => undefined); });
    await act(async () => { await board.props!.onSave!(); });                         // what the autosave's retry timer does
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    await act(async () => { await board.props!.onSave!(); });
    expect(sent).toHaveLength(2);                                                      // acknowledged: nothing more to send
  });
});

describe("presence (#499)", () => {
  it("shows the peers the server listed on connect, and updates them live", async () => {
    board.initPeers = [peer({ sessionId: "s2", userId: "u2", name: "Ana" })];
    await mount();
    await settle(50);
    expect(board.collaborators.at(-1)).toEqual([{ id: "s2", colorKey: "u2", name: "Ana", pointer: { x: 3, y: 4 }, selectedIds: ["a"], pressed: false }]);
    await act(async () => { handlers().onPresence(peer({ sessionId: "s3", userId: "u3", name: "Ben", pointer: null })); });
    await settle(50);
    expect(board.collaborators.at(-1)!.map((person) => person.name)).toEqual(["Ana", "Ben"]);
    expect(board.collaborators.at(-1)![1]!.pointer).toBeUndefined();
    await act(async () => { handlers().onPeerLeft("s2"); });
    await settle(50);
    expect(board.collaborators.at(-1)!.map((person) => person.name)).toEqual(["Ben"]);
  });

  it("holds presence that arrives before the board is ready and shows it once it is", async () => {
    board.deferReady = true;
    await mount();
    await act(async () => { handlers().onPresence(peer()); });
    await settle(50);
    expect(board.collaborators).toEqual([]);
    await act(async () => { board.props!.onReady!(controller()); });
    await settle(50);
    expect(board.collaborators.at(-1)!.map((person) => person.name)).toEqual(["Ana"]);
  });

  it("sends the local pointer and selection over the socket", async () => {
    await mount();
    board.props!.onPresence!({ pointer: { x: 1, y: 2 }, button: "up", selectedIds: ["q"] });
    expect(board.sentPresence).toEqual([{ pointer: { x: 1, y: 2 }, button: "up", selectedIds: ["q"] }]);
  });

  it("hides the local cursor from others while the tab is hidden", async () => {
    await mount();
    board.props!.onPresence!({ pointer: { x: 1, y: 2 }, button: "down", selectedIds: ["q"] });
    board.sentPresence.length = 0;
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    hidden.mockRestore();
    expect(board.sentPresence).toEqual([{ pointer: null, button: "up", selectedIds: ["q"] }]);
  });
});

describe("mode changes (#499)", () => {
  it("flips to view-only when the Project is archived, and stops autosaving", async () => {
    await mount();
    expect(board.props!.readOnly).toBe(false);
    expect(document.querySelector('[data-testid="project-whiteboard-view-only"]')).toBeNull();
    await act(async () => { handlers().onMode("view"); });
    expect(board.props!.readOnly).toBe(true);
    expect(document.querySelector('[data-testid="project-whiteboard-view-only"]')?.textContent).toBe("View only");
    expect(document.querySelector('[data-testid="project-whiteboard-view-only-reason"]')?.textContent).toBe("This project is archived");
    board.scene = [el("late", 2)]; board.props!.onElements!(board.scene);
    await act(async () => { await board.props!.onSave!(); });
    expect(board.log).not.toContain("send");
  });

  it("a save that arrives after the archive frame reports itself skipped, so autosave cannot call it Saved", async () => {
    await mount();
    await act(async () => { handlers().onMode("view"); });
    let outcome: unknown;
    await act(async () => { outcome = await board.props!.onSave!(); });
    expect(board.log).not.toContain("send");
    expect(outcome).toBe("skipped");
  });

  it("still shows other people's edits while view-only, and flips back to editing on restore", async () => {
    await mount();
    await act(async () => { handlers().onMode("view"); });
    await act(async () => { handlers().onElements([el("live", 2)]); });
    expect(board.applied).toHaveLength(1);
    await act(async () => { handlers().onMode("edit"); });
    expect(board.props!.readOnly).toBe(false);
    expect(document.querySelector('[data-testid="project-whiteboard-view-only"]')).toBeNull();
  });

  it("opens view-only when the server's init says so", async () => {
    board.initMode = "view";
    await mount();
    expect(board.props!.readOnly).toBe(true);
    expect(document.querySelector('[data-testid="project-whiteboard-view-only-reason"]')?.textContent).toBe("This project is archived");
  });
});

describe("reconnect (#499)", () => {
  it("catches up on what others did while away BEFORE it resends its own unsaved edits", async () => {
    let attempt = 0;
    board.send = () => (attempt++ === 0 ? Promise.reject(new Error("dropped")) : Promise.resolve());
    await mount();
    board.scene = [el("mine", 2)]; board.props!.onElements!(board.scene);
    await act(async () => { await board.props!.onSave!().catch(() => undefined); });
    board.log.length = 0;
    await act(async () => { handlers().onInit({ mode: "edit", elements: [el("theirs", 7)], sessionId: "me2", peers: [] }, true); });
    await settle(10);
    expect(board.log).toEqual(["applyRemote", "send"]);
    expect(board.scene.map((entry) => entry.id).sort()).toEqual(["mine", "theirs"]);
  });

  it("does not replace the board on a reconnect, and does not send when it only came back view-only", async () => {
    await mount();
    board.send = () => Promise.reject(new Error("should not send"));
    await act(async () => { handlers().onInit({ mode: "view", elements: [el("x", 1)], sessionId: "me2", peers: [] }, true); });
    await settle(10);
    expect(board.log).toEqual(["applyRemote"]);
    expect(board.props!.readOnly).toBe(true);
  });

  it("forgets the peers it had and takes the new connection's list", async () => {
    board.initPeers = [peer({ sessionId: "old", name: "Old" })];
    await mount(); await settle(50);
    await act(async () => { handlers().onInit({ mode: "edit", elements: [], sessionId: "me2", peers: [peer({ sessionId: "new", name: "New" })] }, true); });
    await settle(50);
    expect(board.collaborators.at(-1)!.map((person) => person.name)).toEqual(["New"]);
  });
});

describe("access failure (#499)", () => {
  it("hands a revoked connection's answer to the Workspace", async () => {
    await mount();
    const refusal = new ApiError("Forbidden", 403);
    await act(async () => { handlers().onAccessFailure(refusal); });
    expect(onAccessFailure).toHaveBeenCalledWith(refusal);
  });
});
