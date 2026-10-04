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
  sentPresence: [] as unknown[],
  deferReady: false,
  props: null as null | { readOnly?: boolean; onSave?: () => Promise<void>; onElements?: (e: unknown[]) => void; onPresence?: (p: unknown) => void; onReady?: (c: unknown) => void },
  collaborators: [] as Collaborator[][],
  applied: [] as unknown[][],
  initMode: "edit" as WhiteboardMode,
  initPeers: [] as unknown[],
  editingId: null as string | null,
}));
vi.mock("../lib/whiteboard-socket", () => ({
  openWhiteboardSocket: (_projectId: string, handlers: unknown) => {
    board.handlers = handlers;
    queueMicrotask(() => { const h = handlers as Handlers; h.onConnection("open"); h.onInit({ mode: board.initMode, elements: [], sessionId: "me", peers: board.initPeers as WhiteboardPeer[] }, false); });
    return {
      send: (batch: readonly unknown[]) => { board.log.push("send"); return board.send ? board.send(batch) : Promise.resolve(); },
      sendPresence: (state: unknown) => { board.sentPresence.push(state); },
      close: () => { board.log.push("close"); },
    };
  },
}));
const controller = () => ({
  api: { getAppState: () => ({ editingTextElement: board.editingId ? { id: board.editingId } : null, resizingElement: null, newElement: null }) },
  applyRemote: (remote: Array<Record<string, unknown>>) => {
    board.log.push("applyRemote"); board.applied.push(remote);
    // Like Excalidraw's reconcile: an element being edited here is not replaced by a remote one.
    const taken = remote.filter((entry) => entry.id !== board.editingId);
    const ids = new Set(taken.map((entry) => entry.id));
    board.scene = [...board.scene.filter((entry) => !ids.has(entry.id)), ...taken];
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
  Object.assign(board, { log: [], handlers: null, scene: [], send: null, sentPresence: [], deferReady: false, props: null, collaborators: [], applied: [], initMode: "edit", initPeers: [], editingId: null });
  onAccessFailure.mockReset(); onClose.mockReset();
});
afterEach(async () => { if (root) await act(async () => { root!.unmount(); await Promise.resolve(); }); root = null; document.body.replaceChildren(); });

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
    board.scene = [el("late", 2)]; board.props!.onElements!(board.scene);
    await act(async () => { await board.props!.onSave!(); });
    expect(board.log).not.toContain("send");
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
