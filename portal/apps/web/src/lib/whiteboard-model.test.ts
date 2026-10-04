// @vitest-environment happy-dom
import { generateKeyBetween } from "fractional-indexing";
import { beforeAll, describe, expect, it } from "vitest";
import { normaliseRows, orderStored, reconcileRows, whiteboardElementSchema, whiteboardIncomingWins, type ElementStore, type StoredElement } from "@quincy/shared";
import { adoptArrivedRevisions, interactingIds, mergeRemote, type MergeFns } from "./whiteboard-merge";
import { createRemoteApplier } from "./whiteboard-remote";
import { createWhiteboardSaver, type SavedElement, type ServerHold, type WhiteboardSaver } from "./whiteboard-saver";
import { createVanishObserver, unfinalized, type VanishObserver } from "./whiteboard-vanish";

/**
 * #499: the gate for stacking-order convergence. A seeded, randomised MODEL of the whole whiteboard: the real stored-row
 * rules (`@quincy/shared` `reconcileRows` / `normaliseRows`, the same code the Durable Object runs, over an in-memory
 * `ElementStore`), two to four clients each with the INSTALLED Excalidraw 0.18.1 `restoreElements` / `reconcileElements`,
 * the real saver, and per-socket FIFO queues whose delivery the schedule interleaves at random. Elements are rectangles
 * that collide on fractional indices on purpose.
 *
 * After EVERY step: stored indices (tombstones included) are unique and valid; each client's scene indices are unique, valid
 * and in array order (so Excalidraw's own index repair, which bumps revisions, can never fire); a merge changes no revision
 * and no pinned element's index (a pinned element is exactly what the server holds: the saver's `isStored`); an incoming
 * element is never re-indexed here; a flush transmits only what a person authored (never a repair).
 * THE AUTHORED-SET ORACLE (re-plan 2): the saver never authors a revision. Every revision a person (or the editor-style vanish deletion, or an
 * import numbered as `replaceContent` numbers it) authors is keyed (id, version, nonce) and deep-frozen at that moment; nothing the saver, the
 * merge or the applier does can rewrite it. After every step: every tuple a client transmits was authored; every live tuple a client holds
 * was authored (so it changes only by an authoring step or by a merge accepting someone's authored revision), with exactly the authored
 * content; a vanish leaves the editor-style deletion on the board right after the change.
 * After every step, too: the world is FORKED (the saver's state is closure-private, so a fork is a deterministic replay of
 * the recorded steps in a fresh world), every pending save and message is drained, and then every client must show exactly
 * a fresh load of what is stored, and no genuine edit may have been lost. (Equality only holds after draining: an unsent
 * create or an undelivered message necessarily differs.)
 *
 * A failure prints its seed and a greedily minimised step trace. `SEEDS=n` overrides the seed count.
 */
type El = SavedElement & { index: string; x: number; isDeleted: boolean };
type Excalidraw = {
  reconcileElements: (l: never, r: never, a: never) => El[];
  restoreElements: (e: never, o: null) => El[];
  newElementWith: (element: never, updates: Record<string, unknown>) => El;
};
let excalidraw: Excalidraw;
let reconcileFn: (l: never, r: never, a: never) => El[];
let restoreFn: (raw: readonly unknown[]) => El[];
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  excalidraw = (await import("@excalidraw/excalidraw")) as unknown as Excalidraw;
  reconcileFn = excalidraw.reconcileElements;
  restoreFn = (raw) => excalidraw.restoreElements(raw as never, null);
});

// ---------------------------------------------------------------------------------------------------------------- steps
type Place = { kind: "end" } | { kind: "fixed"; index: string };
type LegacyIndex = { kind: "dup"; pick: number } | { kind: "fixed"; index: string } | { kind: "missing" } | { kind: "malformed"; value: unknown };
type LegacyRow = { id: string; index: LegacyIndex; nonce: number; x: number };
type Step =
  | { op: "create"; c: number; id: string; place: Place; nonce: number; x: number }
  | { op: "edit"; c: number; id: string; nonce: number; x: number }
  | { op: "reorder"; c: number; id: string; pos: number; nonce: number; to?: string }
  | { op: "delete"; c: number; id: string; nonce: number }
  | { op: "vanish"; c: number; id: string }
  | { op: "shrink"; c: number; id: string; nonce: number }
  | { op: "import"; c: number; id: string; nonce: number; x: number }
  | { op: "flush"; c: number }
  | { op: "process"; c: number }
  | { op: "deliver"; c: number }
  | { op: "interact"; c: number; id: string }
  | { op: "endInteract"; c: number }
  | { op: "reconnect"; c: number }
  | { op: "legacy"; rows: LegacyRow[] };
type Config = { clients: number; ids: string[]; initial: LegacyRow[] };

const mulberry32 = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const validKey = (value: unknown): value is string => { if (typeof value !== "string") return false; try { generateKeyBetween(value, null); return true; } catch { return false; } };
const rect = (id: string, version: number, versionNonce: number, extra: Record<string, unknown>): Record<string, unknown> => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, version, versionNonce, isDeleted: false, seed: 1, ...extra });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const contentOf = (element: { x?: unknown; isDeleted?: unknown }) => `${String(element.x)}|${String(element.isDeleted)}`;
const tick = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve(); };
const sortScene = (scene: El[]) => scene.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));

type ServerMessage = { type: "elements"; elements: StoredElement[] } | { type: "ack"; seq: number };
class Client {
  scene: El[] = [];
  inbound: ServerMessage[] = [];
  outbound: Array<{ seq: number; elements: SavedElement[] }> = [];
  pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  /** Every (id, version, nonce) a person authored on this client. */
  authored = new Set<string>();
  log: Array<{ id: string; version: number; content: string; nonce: number; deleted: boolean; superseded?: boolean; sent?: boolean }> = [];
  seq = 0;
  /** The element being resized right now: Excalidraw keeps the local copy and the applier defers remote winners for it. */
  interacting: string | null = null;
  /** The very object Excalidraw's appState (`resizingElement` / `newElement`) points at: the gesture's next pointer event mutates THIS, never a scene lookup. */
  held: El | null = null;
  saver!: WhiteboardSaver;
  vanish!: VanishObserver;
  applier!: ReturnType<typeof createRemoteApplier>;
}

class World {
  readonly rows = new Map<string, StoredElement>();
  readonly store: ElementStore = {
    get: (id) => { const row = this.rows.get(id); return row ? clone(row) : undefined; },
    put: (element) => { this.rows.set(element.id, clone(element)); },
    indexes: () => [...this.rows.values()].map((row) => ({ id: row.id, index: row.index })),
    all: () => [...this.rows.values()].map((row) => clone(row)),
  };
  readonly clients: Client[] = [];
  readonly violations: string[] = [];
  /** Revisions authored on the server itself (legacy rows): they are genuine content too. */
  readonly serverAuthored: Array<{ id: string; version: number; content: string; nonce: number; deleted: boolean }> = [];
  /** Every revision anyone authored, keyed (id, version, nonce), deep-frozen at the moment of authoring: the immutable oracle. */
  readonly authoredRevisions = new Map<string, Readonly<{ id: string; version: number; versionNonce: number; isDeleted: boolean; x: unknown }>>();
  /** A vanish step's expectation: right after the change the scene holds the editor-style deletion of exactly this revision (or nothing, when the server could not hold the id). */
  expectedDeletion: { c: number; id: string; version: number | null } | null = null;
  /** The id most recently authored by anyone: the generator aims concurrent edits, deletes and reorders at it so nonce tiebreaks actually happen. */
  hot: string | undefined;
  messages = 0;
  /** Batches the server has committed. */
  processed = 0;

  constructor(readonly config: Config) {
    this.legacy(config.initial);
    for (let c = 0; c < config.clients; c += 1) this.connect();
  }

  private connect() {
    const client = new Client();
    const index = this.clients.length;
    this.clients.push(client);
    client.saver = createWhiteboardSaver({
      // The saver is shown frozen copies of the scene: it can send them, never write to them.
      getElements: () => client.scene.map((element) => Object.freeze({ ...element }) as SavedElement),
      send: (batch) => new Promise<void>((resolve, reject) => {
        for (const element of batch) if (!this.authoredRevisions.has(`${element.id}:${element.version}:${element.versionNonce}`)) this.violations.push(`client ${index} transmitted ${element.id} v${element.version} nonce ${element.versionNonce}, which nobody authored (a revision the saver or a repair invented)`);
        for (const element of batch) for (const entry of client.log) if (entry.id === element.id && entry.version === element.version && entry.nonce === element.versionNonce) entry.sent = true;
        client.seq += 1; this.messages += 1;
        client.pending.set(client.seq, { resolve, reject });
        client.outbound.push({ seq: client.seq, elements: clone([...batch]) });
      }),
    });
    // The editor-style deletion of an element the editor dropped, authored at observation time and merged like the component's `applyLocal`.
    client.vanish = createVanishObserver({
      mayHold: client.saver.mayHold,
      deletion: (last, patch) => { const deletion = excalidraw.newElementWith(last as never, { isDeleted: true, ...patch }); this.author(client, deletion); return deletion as SavedElement; },
      install: (deletions) => { this.mergeInto(index, client, clone(deletions) as unknown as StoredElement[], (element) => client.saver.hold(element as SavedElement)); return client.scene as unknown as SavedElement[]; },
    });
    // The component's own remote path (`createRemoteApplier`), with Excalidraw's reconcile told what is being resized.
    client.applier = createRemoteApplier({
      saver: client.saver,
      merge: () => (remote, hold) => this.mergeInto(index, client, remote as StoredElement[], hold) as unknown as SavedElement[],
      setScene: () => undefined,
      getScene: () => client.scene as unknown as SavedElement[],
      interactingIds: () => new Set(client.interacting === null ? [] : [client.interacting]),
      forget: (ids) => client.vanish.forget(ids),
      settle: () => client.vanish.observe(client.scene),
    });
    const init = orderStored(this.store.all());
    client.scene = excalidraw.restoreElements(clone(init) as never, null);
    adoptArrivedRevisions(client.scene, init as never);
    client.saver.seed(clone(init) as unknown as SavedElement[]);
    client.vanish.observe(client.scene);                       // the editor's first change event, at load
  }

  /** A table written before indices were unique, then the Durable Object's wake: normalise, tell every open socket. */
  private legacy(rows: readonly LegacyRow[]) {
    for (const row of rows) {
      if (this.rows.has(row.id)) continue;
      const taken = [...this.rows.values()].map((stored) => stored.index);
      const index = row.index.kind === "dup" ? taken[row.index.pick % Math.max(taken.length, 1)] ?? "a0" : row.index.kind === "fixed" ? row.index.index : row.index.kind === "missing" ? undefined : row.index.value;
      const stored = { ...rect(row.id, 1, row.nonce, { x: row.x }), ...(index === undefined ? {} : { index }) } as StoredElement;
      this.rows.set(row.id, stored);
      this.serverAuthored.push({ id: row.id, version: 1, content: contentOf(stored), nonce: row.nonce, deleted: false });
      this.freezeRevision(stored as unknown as El);
    }
    // The wake normalises, then tells every open socket. A row that was already unique changes nothing, but the clients in this
    // model have never seen a row inserted behind their back, so the rows inserted here reach them as stored too.
    const changed = normaliseRows(this.store);
    const touched = new Set([...rows.map((row) => row.id), ...changed.map((row) => row.id)]);
    const inserted = [...touched].filter((id) => this.rows.has(id)).map((id) => clone(this.rows.get(id)!));
    if (inserted.length > 0) for (const client of this.clients) client.inbound.push({ type: "elements", elements: clone(inserted) });
  }

  /** Records a revision as authored: keyed (id, version, nonce), and a deep-frozen snapshot nothing can rewrite. */
  private freezeRevision(element: El) {
    const key = `${element.id}:${element.version}:${element.versionNonce}`;
    if (!this.authoredRevisions.has(key)) this.authoredRevisions.set(key, Object.freeze({ id: element.id, version: element.version, versionNonce: element.versionNonce, isDeleted: element.isDeleted === true, x: element.x }));
  }

  private author(client: Client, element: El) {
    this.freezeRevision(element);
    client.authored.add(`${element.id}:${element.version}:${element.versionNonce}`);
    client.log.push({ id: element.id, version: element.version, content: contentOf(element), nonce: element.versionNonce, deleted: element.isDeleted === true });
    this.hot = element.id;
  }

  /** The controller's `applyRemote`: merge with Excalidraw's own restore and reconcile, checking what a merge may never do. */
  private mergeInto(c: number, client: Client, remote: StoredElement[], hold: (element: SavedElement) => ServerHold): El[] {
    const fns: MergeFns<El> = {
      restore: restoreFn,
      reconcile: (local, incomingElements) => reconcileFn(local as never, incomingElements as never, { editingTextElement: null, resizingElement: client.interacting ? { id: client.interacting } : null, newElement: null } as never),
    };
    const resizing = interactingIds({ resizingElement: client.interacting ? { id: client.interacting } : null });
    const before = client.scene.map((element) => ({ id: element.id, version: element.version, versionNonce: element.versionNonce, index: element.index, pinned: hold(element as SavedElement).state === "stored" }));
    const incoming = new Map(remote.map((element) => [element.id, element]));
    client.scene = mergeRemote(client.scene, clone(remote) as never, fns, (element) => hold(element as SavedElement), resizing);
    if (client.held && !client.scene.includes(client.held)) this.violations.push(`client ${c}: a merge replaced the object ${client.held.id} that the gesture holds, so its next pointer event never reaches the scene`);
    for (const was of before) {
      const now = client.scene.find((element) => element.id === was.id);
      const inc = incoming.get(was.id);
      // A winner the renderer drops (a zero-size element) takes the local copy it beats off the board, as a fresh load would (unless a gesture holds it).
      if (!now) { if (!(inc !== undefined && inc.width === 0 && inc.height === 0 && inc.isDeleted !== true && !resizing.has(was.id) && whiteboardIncomingWins(was, inc))) this.violations.push(`client ${c}: ${was.id} vanished in a merge`); continue; }
      const replaced = inc !== undefined && !resizing.has(was.id) && whiteboardIncomingWins(was, inc);
      if (replaced) { if (now.version !== inc.version || now.versionNonce !== inc.versionNonce) this.violations.push(`client ${c}: ${was.id} should have taken the incoming v${inc.version}/${inc.versionNonce} but holds v${now.version}/${now.versionNonce}`); continue; }
      if (now.version !== was.version || now.versionNonce !== was.versionNonce) this.violations.push(`client ${c}: a merge changed ${was.id}'s revision v${was.version}/${was.versionNonce} -> v${now.version}/${now.versionNonce}`);
      const deferred = inc !== undefined && resizing.has(was.id) && whiteboardIncomingWins(was, inc);   // its copy shown meanwhile is mid-edit and yields to the server's index
      const corrected = inc !== undefined && inc.version === was.version && inc.versionNonce === was.versionNonce && inc.index === now.index;   // the server's index for this very revision
      if (was.pinned && !deferred && !corrected && now.index !== was.index) this.violations.push(`client ${c}: a merge moved the pinned ${was.id} from ${was.index} to ${now.index}`);
    }
    for (const element of client.scene) {
      const inc = incoming.get(element.id);
      if (inc && element.version === inc.version && element.versionNonce === inc.versionNonce && element.index !== inc.index) this.violations.push(`client ${c}: incoming ${element.id} was re-indexed here (${String(inc.index)} -> ${element.index})`);
    }
    return client.scene;
  }

  private applyRemote(c: number, remote: StoredElement[]) { this.clients[c]!.applier.apply(clone(remote) as Array<Record<string, unknown>>); }

  /** Runs one step. Returns false when it does not apply in this world (a replay that has diverged skips it). */
  async execute(step: Step): Promise<boolean> {
    const before = this.clients.map((client) => new Map(client.scene.map((element) => [element.id, `${element.version}:${element.versionNonce}`])));
    this.expectedDeletion = null;
    const done = await this.run(step);
    for (const client of this.clients) this.changeEvent(client);           // the editor's change event
    await tick();
    const expected = this.expectedDeletion as World["expectedDeletion"];
    if (expected) {
      const scene = this.clients[expected.c]!.scene.find((element) => element.id === expected.id);
      if (expected.version === null) { if (scene) this.violations.push(`client ${expected.c}: ${expected.id} was never on the server, yet the scene holds it after a vanish`); }
      else if (!scene || scene.isDeleted !== true || scene.version !== expected.version) this.violations.push(`client ${expected.c}: after the vanish of ${expected.id} the scene holds ${scene ? `v${scene.version} deleted=${String(scene.isDeleted)}` : "nothing"}, expected the editor-style deletion v${expected.version}`);
    }
    // No live revision changes except by an authoring step or by a merge accepting an authored one: whatever a client holds now, somebody authored.
    this.clients.forEach((client, c) => { for (const element of client.scene) { const key = `${element.version}:${element.versionNonce}`; if (before[c]!.get(element.id) !== key && !this.authoredRevisions.has(`${element.id}:${key}`)) this.violations.push(`client ${c}: ${element.id} moved to v${element.version}/${element.versionNonce}, which nobody authored`); } });
    return done;
  }

  /**
   * The editor's change event, as the canvas and the shell run it: the shell observes the scene and replays what was deferred, and an
   * unfinalized (live, invisibly small) element nothing holds is reported once and then dropped through updateScene, which is
   * another change event (`sweepUnfinalized` in the canvas). The vanish observer then authors its deletion.
   */
  private changeEvent(client: Client) {
    client.vanish.observe(client.scene); client.applier.replay();
    client.vanish.observe(client.scene);          // a replay's merge goes through updateScene, whose own change event the shell observes before the next action
    const stray = new Set(unfinalized(client.scene, new Set(client.interacting === null ? [] : [client.interacting])));
    if (stray.size === 0) return;
    client.scene = client.scene.filter((element) => !stray.has(element.id));
    client.vanish.observe(client.scene); client.applier.replay();
  }

  /** What a person's edit lands on: while a gesture holds an element, the held object itself (as Excalidraw's pointer handlers do), else the scene's copy. */
  private target(client: Client, id: string): El | undefined {
    return client.held && client.held.id === id ? client.held : client.scene.find((candidate) => candidate.id === id);
  }

  private async run(step: Step): Promise<boolean> {
    // A legacy table only exists before the first normalising wake: once a batch has committed the table is unique for good, and
    // a duplicate row appearing later (so that the server re-keys a row the clients already know, a second time) cannot happen.
    if (step.op === "legacy") { if (this.processed > 0) return false; this.legacy(step.rows); return true; }
    const client = this.clients[step.c];
    if (!client) return false;
    switch (step.op) {
      case "create": {
        if (client.scene.some((element) => element.id === step.id)) return false;
        const taken = new Set(client.scene.map((element) => element.index));
        const last = client.scene.at(-1)?.index ?? null;
        const index = step.place.kind === "fixed" && validKey(step.place.index) && !taken.has(step.place.index) ? step.place.index : generateKeyBetween(last, null);
        const element = excalidraw.restoreElements([rect(step.id, 1, step.nonce, { index, x: step.x })] as never, null)[0]!;
        client.scene = sortScene([...client.scene, element]); this.author(client, element); return true;
      }
      case "edit": {
        const element = this.target(client, step.id);
        if (!element || element.isDeleted) return false;
        if (element === client.held) { Object.assign(element, { x: step.x, version: element.version + 1, versionNonce: step.nonce }); this.author(client, element); return true; }   // a pointer event through the held reference
        const next = { ...element, x: step.x, version: element.version + 1, versionNonce: step.nonce };
        client.scene = client.scene.map((candidate) => (candidate === element ? next : candidate)); this.author(client, next); return true;
      }
      case "delete": {
        const element = this.target(client, step.id);
        if (!element || element.isDeleted) return false;
        if (element === client.held) { Object.assign(element, { isDeleted: true, version: element.version + 1, versionNonce: step.nonce }); this.author(client, element); return true; }
        const next = { ...element, isDeleted: true, version: element.version + 1, versionNonce: step.nonce };
        client.scene = client.scene.map((candidate) => (candidate === element ? next : candidate)); this.author(client, next); return true;
      }
      case "reorder": {
        const element = this.target(client, step.id);
        if (!element) return false;
        const others = client.scene.filter((candidate) => candidate !== element);
        const at = step.pos % (others.length + 1);
        const index = step.to !== undefined && validKey(step.to) && !others.some((candidate) => candidate.index === step.to) ? step.to : generateKeyBetween(others[at - 1]?.index ?? null, others[at]?.index ?? null);
        if (index === element.index) return false;
        if (element === client.held) { Object.assign(element, { index, version: element.version + 1, versionNonce: step.nonce }); client.scene = sortScene(client.scene); this.author(client, element); return true; }
        const next = { ...element, index, version: element.version + 1, versionNonce: step.nonce };
        client.scene = sortScene(client.scene.map((candidate) => (candidate === element ? next : candidate))); this.author(client, next); return true;
      }
      case "import": {
        // An older scene file is loaded over the board: whatever the board held under this id (a tombstone included) is replaced by a version 1 copy.
        if (client.held?.id === step.id) return false;
        const rest = client.scene.filter((element) => element.id !== step.id);
        const previous = client.scene.find((element) => element.id === step.id);
        const incoming = excalidraw.restoreElements([rect(step.id, 1, step.nonce, { index: generateKeyBetween(rest.at(-1)?.index ?? null, null), x: step.x })] as never, null)[0]!;
        // replaceContent's numbering: above what the board holds (a deletion included), authored with a fresh nonce.
        const element = previous ? { ...incoming, version: Math.max(incoming.version, previous.version) + 1, versionNonce: step.nonce } : incoming;
        client.scene = sortScene([...rest, element]);
        for (const entry of client.log) if (entry.id === step.id) entry.superseded = true;   // what the board held before is replaced, so what was never sent of it is no longer anyone's
        this.author(client, element); return true;
      }
      case "vanish": {
        const element = client.scene.find((candidate) => candidate.id === step.id);
        if (!element || element.isDeleted || client.held?.id === step.id) return false;
        this.expectedDeletion = { c: step.c, id: step.id, version: client.saver.mayHold(step.id) ? element.version + 1 : null };
        client.scene = client.scene.filter((candidate) => candidate !== element);
        for (const entry of client.log) if (entry.id === step.id) entry.superseded = true;   // the person removed it: what they authored before is no longer theirs to have kept
        return true;
      }
      case "shrink": {
        // A resize to zero size that leaves the element in the scene (no pointer-up finalize): the editor mutates its own object in place.
        const element = client.scene.find((candidate) => candidate.id === step.id);
        if (!element || element.isDeleted || client.held?.id === step.id || client.interacting === step.id) return false;
        Object.assign(element, { width: 0, height: 0, version: element.version + 1, versionNonce: step.nonce });
        this.author(client, element);
        this.expectedDeletion = { c: step.c, id: step.id, version: client.saver.mayHold(step.id) ? element.version + 1 : null };
        for (const entry of client.log) if (entry.id === step.id) entry.superseded = true;   // the 0x0 revision is never anyone's content to keep
        return true;
      }
      case "flush": { client.saver.flush().catch(() => undefined); return true; }
      case "process": {
        const message = client.outbound.shift();
        if (!message) return false;
        this.processed += 1;
        const winners = reconcileRows(this.store, message.elements.map((element) => whiteboardElementSchema.parse(element)) as never);
        // The Durable Object's relay: winners (stored form) to everyone else, losers and rewritten back to the sender before its ack.
        if (winners.winners.length > 0) this.clients.forEach((other) => { if (other !== client) other.inbound.push({ type: "elements", elements: clone(winners.winners) }); });
        const back = [...winners.losers, ...winners.rewritten];
        if (back.length > 0) client.inbound.push({ type: "elements", elements: clone(back) });
        client.inbound.push({ type: "ack", seq: message.seq });
        return true;
      }
      case "deliver": {
        const message = client.inbound.shift();
        if (!message) return false;
        if (message.type === "ack") { client.pending.get(message.seq)?.resolve(); client.pending.delete(message.seq); }
        else this.applyRemote(step.c, message.elements);
        return true;
      }
      case "interact": {
        if (client.interacting !== null || !client.scene.some((element) => element.id === step.id && !element.isDeleted)) return false;
        client.interacting = step.id; client.held = client.scene.find((element) => element.id === step.id)!; return true;
      }
      case "endInteract": { if (client.interacting === null) return false; client.interacting = null; client.held = null; return true; }
      case "reconnect": {
        for (const pending of client.pending.values()) pending.reject(new Error("socket closed"));
        client.pending.clear(); client.outbound.length = 0; client.inbound.length = 0;
        await tick();
        this.applyRemote(step.c, orderStored(this.store.all()));
        client.saver.flush().catch(() => undefined);
        return true;
      }
    }
  }

  /** Delivers every message and flushes every client until nothing moves. */
  async drain() {
    for (let round = 0; round < 400; round += 1) {
      const before = this.messages;
      for (const client of this.clients) { client.interacting = null; client.held = null; this.changeEvent(client); }     // the person lets go
      for (let c = 0; c < this.clients.length; c += 1) { this.clients[c]!.saver.flush().catch(() => undefined); await tick(); }
      let moved = true;
      while (moved) {
        moved = false;
        for (let c = 0; c < this.clients.length; c += 1) {
          if (this.clients[c]!.outbound.length > 0) { await this.run({ op: "process", c }); moved = true; await tick(); }
        }
        for (let c = 0; c < this.clients.length; c += 1) {
          if (this.clients[c]!.inbound.length > 0) { await this.run({ op: "deliver", c }); moved = true; await tick(); }
        }
      }
      if (this.messages === before) return;
    }
    this.violations.push("the world did not quiesce after 400 drain rounds");
  }

  dump(): string {
    const fmt = (e: { id: string; index?: unknown; version: number; versionNonce: number; x?: unknown; isDeleted?: unknown }) => `${e.id}@${String(e.index)} v${e.version}/${e.versionNonce} ${contentOf(e)}`;
    return [`  server: ${orderStored([...this.rows.values()]).map(fmt).join(" | ")}`, ...this.clients.map((client, c) => `  c${c}: ${client.scene.map(fmt).join(" | ")}  out=${client.outbound.map((m) => `#${m.seq}[${m.elements.map(fmt).join(",")}]`).join(" ")} in=${client.inbound.map((m) => (m.type === "ack" ? `ack${m.seq}` : `el[${m.elements.map(fmt).join(",")}]`)).join(" ")}`)].join("\n");
  }

  /** Cheap invariants, true after every step. */
  invariants(): string[] {
    const found = [...this.violations];
    const seen = new Map<string, string>();
    for (const row of this.rows.values()) {
      if (!validKey(row.index)) found.push(`stored ${row.id} has an invalid index ${JSON.stringify(row.index)}`);
      else if (seen.has(row.index)) found.push(`stored ${row.id} and ${seen.get(row.index)} share index ${row.index}`);
      else seen.set(row.index, row.id);
    }
    this.clients.forEach((client, c) => {
      for (const element of client.scene) {
        const authored = this.authoredRevisions.get(`${element.id}:${element.version}:${element.versionNonce}`);
        if (!authored) found.push(`client ${c} holds ${element.id} v${element.version}/${element.versionNonce}, which nobody authored`);
        else if (contentOf(element) !== contentOf(authored)) found.push(`client ${c} holds ${element.id} v${element.version}/${element.versionNonce} with content ${contentOf(element)}, but that revision was authored as ${contentOf(authored)}`);
      }
      const indices = new Set<string>();
      client.scene.forEach((element, position) => {
        if (indices.has(element.index)) found.push(`client ${c} holds two elements at index ${element.index}`);
        indices.add(element.index);
        const previous = client.scene[position - 1];
        if (previous && !(previous.index < element.index)) found.push(`client ${c}'s scene is not in strictly increasing index order at ${element.id}`);
      });
    });
    return found;
  }

  /** After a drain: every client shows a fresh load of the stored rows, and no genuine edit was lost. */
  converged(): string[] {
    const found: string[] = [];
    const rows = orderStored([...this.rows.values()]);
    const fresh = excalidraw.restoreElements(clone(rows) as never, null);
    this.clients.forEach((client, c) => {
      const want = fresh.map((element) => element.id);
      const got = client.scene.map((element) => element.id);
      if (got.join() !== want.join()) found.push(`client ${c} shows ${got.join(",")} but a fresh load shows ${want.join(",")}`);
      for (const row of rows) {
        const held = client.scene.find((element) => element.id === row.id);
        if (!held) continue;
        if (held.index !== row.index || held.version !== row.version || held.versionNonce !== row.versionNonce || contentOf(held) !== contentOf(row)) found.push(`client ${c} holds ${row.id} as ${held.index} v${held.version} ${contentOf(held)}, stored is ${String(row.index)} v${row.version} ${contentOf(row)}`);
      }
    });
    // Content is decided by the AUTHORED revisions alone, as Excalidraw's own reconcile decides it: whatever a server re-key
    // did to an index, the winner of every id (nonce, deleted) is the one reconcile picks from everything any person authored.
    const authored = new Map<string, Array<{ id: string; version: number; versionNonce: number; isDeleted: boolean; index: string }>>();
    for (const entry of [...this.clients.flatMap((client) => client.log.filter((logged) => !logged.superseded || logged.sent)), ...this.serverAuthored]) authored.set(entry.id, [...(authored.get(entry.id) ?? []), { id: entry.id, version: entry.version, versionNonce: entry.nonce, isDeleted: entry.deleted, index: "a0" }]);
    for (const [id, revisions] of authored) {
      const stored = this.rows.get(id);
      if (!stored) continue;
      const pick = revisions.reduce((best, next) => reconcileFn([best] as never, [next] as never, { editingTextElement: null, resizingElement: null, newElement: null } as never)[0] as typeof best);
      if (stored.versionNonce !== pick.versionNonce || stored.isDeleted !== pick.isDeleted) found.push(`stored ${id} is nonce ${stored.versionNonce} deleted=${String(stored.isDeleted)} but Excalidraw's reconcile of the authored revisions picks nonce ${pick.versionNonce} deleted=${String(pick.isDeleted)}`);
    }
    // No genuine pending edit lost: a client's latest authored revision survives unless another person's concurrent-or-later revision with the stored content beat it.
    this.clients.forEach((client, c) => {
      const latest = new Map<string, { id: string; version: number; content: string }>();
      for (const entry of client.log) { if (entry.superseded) continue; const known = latest.get(entry.id); if (!known || entry.version >= known.version) latest.set(entry.id, entry); }
      for (const mine of latest.values()) {
        const stored = this.rows.get(mine.id);
        if (!stored) { found.push(`client ${c}'s ${mine.id} (${mine.content}) is not stored at all`); continue; }
        if (contentOf(stored) === mine.content) continue;
        const others = [...this.clients.flatMap((other, o) => (o === c ? [] : other.log)), ...this.serverAuthored];
        if (!others.some((entry) => entry.id === mine.id && entry.version >= mine.version && entry.content === contentOf(stored))) found.push(`client ${c}'s latest ${mine.id} v${mine.version} (${mine.content}) was lost: stored is v${stored.version} (${contentOf(stored)}) and no other person's revision explains it`);
      }
    });
    return found;
  }
}

// ---------------------------------------------------------------------------------------------------------- generation
const NONCE_LIMIT = 2 ** 31 - 2;
const POOL = ["a", "b", "c", "d", "0"] as const;
const FIXED_INDICES = ["a0", "a1", "a2", "a0V", "Zz"];

function makeConfig(rng: () => number): Config {
  const ids = [...POOL].sort(() => rng() - 0.5).slice(0, 3 + Math.floor(rng() * 3));
  const initial: LegacyRow[] = rng() < 0.45 ? ids.slice(0, 1 + Math.floor(rng() * 3)).map((id) => legacyRow(rng, id)) : [];
  return { clients: 2 + Math.floor(rng() * 2), ids, initial };
}
function legacyRow(rng: () => number, id: string): LegacyRow {
  const roll = rng();
  const index: LegacyIndex = roll < 0.45 ? { kind: "dup", pick: Math.floor(rng() * 10) } : roll < 0.7 ? { kind: "fixed", index: FIXED_INDICES[Math.floor(rng() * FIXED_INDICES.length)]! } : roll < 0.85 ? { kind: "missing" } : { kind: "malformed", value: [("a0 "), "", "a00", "!!", 7, null][Math.floor(rng() * 6)] };
  return { id, index, nonce: 1 + Math.floor(rng() * NONCE_LIMIT), x: Math.floor(rng() * 1e6) };
}
function generate(world: World, rng: () => number): Step {
  const { clients, ids } = world.config;
  const c = Math.floor(rng() * clients);
  const nonce = 1 + Math.floor(rng() * NONCE_LIMIT);
  const x = Math.floor(rng() * 1e6);
  const client = world.clients[c]!;
  const roll = rng();
  const live = client.scene.filter((element) => !element.isDeleted);
  const aimed = world.hot === undefined ? undefined : live.find((element) => element.id === world.hot);
  const pickLive = () => (aimed && rng() < 0.5 ? aimed : live[Math.floor(rng() * live.length)]!);
  if (roll < 0.14) {
    const free = ids.filter((id) => !client.scene.some((element) => element.id === id));
    const id = free[Math.floor(rng() * free.length)];
    if (id) return { op: "create", c, id, nonce, x, place: rng() < 0.6 ? { kind: "fixed", index: FIXED_INDICES[Math.floor(rng() * FIXED_INDICES.length)]! } : { kind: "end" } };
  }
  if (roll < 0.28 && live.length > 0) return { op: "edit", c, id: pickLive().id, nonce, x };
  if (roll < 0.36 && client.scene.length > 1) return { op: "reorder", c, id: client.scene[Math.floor(rng() * client.scene.length)]!.id, pos: Math.floor(rng() * 8), nonce };
  if (roll < 0.39 && live.length > 0) return { op: "delete", c, id: pickLive().id, nonce };
  if (roll < 0.42 && live.length > 0) return { op: "vanish", c, id: pickLive().id };
  if (roll < 0.43 && live.length > 0) return { op: "shrink", c, id: pickLive().id, nonce };
  if (roll < 0.44) return { op: "import", c, id: ids[Math.floor(rng() * ids.length)]!, nonce, x };
  if (roll < 0.53) return { op: "flush", c };
  if (roll < 0.75) { const busy = world.clients.map((other, i) => (other.outbound.length > 0 ? i : -1)).filter((i) => i >= 0); if (busy.length > 0) return { op: "process", c: busy[Math.floor(rng() * busy.length)]! }; }
  if (roll < 0.79) return client.interacting === null && live.length > 0 ? { op: "interact", c, id: pickLive().id } : { op: "endInteract", c };
  if (roll < 0.97) { const busy = world.clients.map((other, i) => (other.inbound.length > 0 ? i : -1)).filter((i) => i >= 0); if (busy.length > 0) return { op: "deliver", c: busy[Math.floor(rng() * busy.length)]! }; }
  if (roll < 0.985) return { op: "reconnect", c };
  if (roll >= 0.985) { const id = ids[Math.floor(rng() * ids.length)]!; if (!world.rows.has(id) && world.processed === 0) return { op: "legacy", rows: [legacyRow(rng, id)] }; }
  return { op: "flush", c };
}

// ---------------------------------------------------------------------------------------------------------------- drive
/** Replays `steps` in a fresh world, then drains it: the fork. Returns what is wrong, or null. */
async function forkCheck(config: Config, steps: readonly Step[]): Promise<string[]> {
  const world = new World(config);
  for (const step of steps) await world.execute(step);
  await world.drain();
  return [...world.invariants(), ...world.converged()];
}
/** What is wrong after running `steps` start to finish (every-step invariants, and one fork at the end). */
async function failureOf(config: Config, steps: readonly Step[]): Promise<string[]> {
  const world = new World(config);
  for (const step of steps) { await world.execute(step); const found = world.invariants(); if (found.length > 0) return found; }
  return forkCheck(config, steps);
}
async function shrink(config: Config, steps: Step[]): Promise<Step[]> {
  let current = steps;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const candidate = current.filter((_, at) => at !== i);
      if ((await failureOf(config, candidate)).length > 0) { current = candidate; changed = true; }
    }
  }
  return current;
}
async function explain(label: string, config: Config, steps: Step[], found: string[]): Promise<never> {
  const minimal = await shrink(config, steps);
  const again = await failureOf(config, minimal);
  throw new Error(`${label} FAILED\n  ${found.slice(0, 4).join("\n  ")}\nminimal trace (${minimal.length} of ${steps.length} steps): ${JSON.stringify({ config, steps: minimal })}\n  which fails with: ${again.slice(0, 3).join(" | ")}`);
}
/** Runs a step source, checking every-step invariants and forking after every step. */
async function drive(label: string, config: Config, next: (world: World, k: number) => Step | null): Promise<World> {
  const world = new World(config);
  const steps: Step[] = [];
  for (let k = 0; ; k += 1) {
    const step = next(world, k);
    if (!step) break;
    steps.push(step);
    await world.execute(step);
    let found = world.invariants();
    if (found.length === 0) found = await forkCheck(config, steps);
    if (found.length > 0) await explain(label, config, steps, found);
  }
  return world;
}

/** `WB_REPLAY='{"config":...,"steps":[...]}' npx vitest run src/lib/whiteboard-model.test.ts -t replay` prints a failure's trace state by state. */
describe.skipIf(!process.env.WB_REPLAY)("model replay", () => {
  it("replay", async () => {
    const { config, steps } = JSON.parse(process.env.WB_REPLAY!) as { config: Config; steps: Step[] };
    const world = new World(config);
    console.log(`start\n${world.dump()}`);
    for (const step of steps) { await world.execute(step); console.log(`${JSON.stringify(step)}\n${world.dump()}\n  violations: ${world.invariants().join("; ")}`); }
    await world.drain();
    console.log(`after drain\n${world.dump()}\n  invariants: ${world.invariants().join("; ")}\n  converged: ${world.converged().join("; ")}`);
  });
});

const STEPS = Number(process.env.STEPS ?? 40);
const SEEDS = Number(process.env.SEEDS ?? 500);
const CHUNK = 20;

describe("model: stored indices are unique and every tab converges with a fresh load (#499)", () => {
  const chunks = Array.from({ length: Math.ceil(SEEDS / CHUNK) }, (_, chunk) => chunk);
  it.each(chunks)("random seeds, chunk %i", async (chunk) => {
    for (let seed = chunk * CHUNK; seed < Math.min(SEEDS, (chunk + 1) * CHUNK); seed += 1) {
      const rng = mulberry32(seed + 1);
      await drive(`seed ${seed}`, makeConfig(rng), (world, k) => (k < STEPS ? generate(world, rng) : null));
    }
  });
});

// ------------------------------------------------------------------------------------------------------- named scripts
const create = (c: number, id: string, index: string, nonce: number, x = nonce): Step => ({ op: "create", c, id, place: { kind: "fixed", index }, nonce, x });
const edit = (c: number, id: string, nonce: number, x = nonce): Step => ({ op: "edit", c, id, nonce, x });
const flush = (c: number): Step => ({ op: "flush", c });
const process_ = (c: number, times = 1): Step[] => Array.from({ length: times }, () => ({ op: "process", c }));
const deliver = (c: number, times = 1): Step[] => Array.from({ length: times }, () => ({ op: "deliver", c }));
const script = (steps: Array<Step | Step[]>): Step[] => steps.flat();
const play = async (label: string, config: Config, steps: Step[]) => {
  let at = 0;
  const world = await drive(label, config, () => steps[at++] ?? null);
  await world.drain();
  expect(world.invariants()).toEqual([]);
  expect(world.converged()).toEqual([]);
  return world;
};
const interact = (c: number, id: string): Step => ({ op: "interact", c, id });
const endInteract = (c: number): Step => ({ op: "endInteract", c });
const reorder = (c: number, id: string, pos: number, nonce: number, to?: string): Step => ({ op: "reorder", c, id, pos, nonce, to });
const idsOf = (world: World, c = 0) => world.clients[c]!.scene.map((element) => element.id);
const row = (id: string, index: LegacyIndex, nonce: number): LegacyRow => ({ id, index, nonce, x: nonce });

describe("model: named scenarios from the Sol and Codex reviews (#499)", () => {
  it("Sol round 4 #2: shapes b, c, d at one index arriving one at a time end a,b,c,d like a fresh tab", async () => {
    const world = await play("sol4-2", { clients: 4, ids: ["a", "b", "c", "d"], initial: [row("a", { kind: "fixed", index: "a0" }, 5)] }, script([
      create(1, "b", "a1", 7), create(2, "c", "a1", 8), create(3, "d", "a1", 9), flush(1), flush(2), flush(3),
      process_(2), process_(1), process_(3), deliver(0, 3), deliver(1, 2), deliver(2, 2), deliver(3, 2),
    ]));
    expect(new Set(world.clients.map((client) => client.scene.map((element) => element.id).join()))).toHaveProperty("size", 1);
  });

  it("Sol round 5: a tab that saved its own b at a0 then receives a and c at a0 shows what a fresh load shows", async () => {
    const world = await play("sol5", { clients: 3, ids: ["a", "b", "c"], initial: [] }, script([
      create(0, "b", "a0", 6), flush(0), process_(0),
      create(1, "a", "a0", 5), create(2, "c", "a0", 7), flush(1), flush(2), process_(1), process_(2),
      deliver(0, 4), deliver(1, 4), deliver(2, 4),
    ]));
    expect(new Set(world.clients.map((client) => client.scene.map((element) => element.id).join()))).toHaveProperty("size", 1);
  });

  it("Sol round 6: stored a, b, c sharing a0, then b edited and saved, leaves the sender and its peers in one order", async () => {
    const world = await play("sol6", { clients: 2, ids: ["a", "b", "c"], initial: [row("a", { kind: "fixed", index: "a0" }, 5), row("b", { kind: "fixed", index: "a0" }, 6), row("c", { kind: "fixed", index: "a0" }, 7)] }, script([
      edit(0, "b", 40, 400), flush(0), process_(0), deliver(0, 2), deliver(1, 2),
    ]));
    expect(new Set(world.clients.map((client) => client.scene.map((element) => element.id).join()))).toHaveProperty("size", 1);
  });

  it("Codex failure 1: the server holds a at a0, the sender has an unsent 0 at a0 and then receives a", async () => {
    const world = await play("codex-1", { clients: 3, ids: ["a", "0"], initial: [] }, script([
      create(2, "a", "a0", 5), flush(2), process_(2),
      create(1, "0", "a0", 6),
      deliver(1), flush(1), process_(1), deliver(1, 3), deliver(0, 4), deliver(2, 3),
    ]));
    expect(idsOf(world, 1)).toEqual(idsOf(world, 0));
  });

  it("Codex failure 2: a correction carrying the transmitted v1's old geometry never overwrites the sender's genuine v2", async () => {
    const world = await play("codex-2", { clients: 3, ids: ["a", "0"], initial: [] }, script([
      create(2, "a", "a0", 5), flush(2), process_(2), deliver(1),
      create(1, "0", "a0", 600, 1), flush(1), edit(1, "0", 20, 2),
      process_(1), deliver(1, 2), flush(1), process_(1), deliver(1, 3), deliver(0, 4), deliver(2, 3),
    ]));
    expect(world.rows.get("0")).toMatchObject({ x: 2, isDeleted: false });
  });

  it("Sol round 13: an element resized to zero (editor-style deletion at observation time), re-imported at an older version (numbered above it), edited, then a reconnect keeps the edit", async () => {
    const world = await play("sol13", { clients: 2, ids: ["e"], initial: [row("e", { kind: "fixed", index: "a0" }, 5)] }, script([
      edit(0, "e", 40, 400), flush(0), process_(0), deliver(0), deliver(1),
      { op: "vanish", c: 0, id: "e" }, flush(0), process_(0), deliver(0), deliver(1),     // the deletion (v3) is on the board at once and is stored
      { op: "import", c: 0, id: "e", nonce: 11, x: 1 }, flush(0), process_(0), deliver(0), deliver(1),       // an older scene is imported: authored v4, above the deletion
      edit(0, "e", 60, 600), { op: "reconnect", c: 0 }, deliver(0),
    ]));
    expect(world.rows.get("e")).toMatchObject({ isDeleted: false, x: 600 });
    expect(world.clients[0]!.scene.find((element) => element.id === "e")).toMatchObject({ x: 600, version: 5 });
  });

  it("re-plan 2: a local copy that beat the server's remote revision and is then removed is deleted above it (the server holds the id although the saver never sent it)", async () => {
    const world = await play("beat-then-vanish", { clients: 2, ids: ["d", "a", "c"], initial: [] }, script([
      { op: "import", c: 1, id: "a", nonce: 434715436, x: 569810 },
      { op: "legacy", rows: [{ id: "a", index: { kind: "malformed", value: null }, nonce: 1778559496, x: 993303 }] },
      deliver(1),
      { op: "vanish", c: 1, id: "a" },
    ]));
    expect(world.rows.get("a")).toMatchObject({ isDeleted: true, version: 2 });
    for (const client of world.clients) expect(client.scene.find((element) => element.id === "a")).toMatchObject({ isDeleted: true, version: 2 });
  });

  it("Sol round 9: A reorders e into x's index (v2/nonce 50, re-keyed by the server) while B deletes e (v2/nonce 40): the deletion wins in storage and on every tab", async () => {
    const world = await play("sol9", { clients: 3, ids: ["e", "y", "x"], initial: [row("e", { kind: "fixed", index: "a0" }, 5), row("y", { kind: "fixed", index: "a1" }, 6)] }, script([
      create(2, "x", "a2", 12), flush(2), process_(2),                       // C's x reaches the server before A or B hear of it
      reorder(0, "e", 0, 50, "a2"), { op: "delete", c: 1, id: "e", nonce: 40 },
      flush(0), flush(1), process_(0), process_(1),
      deliver(0, 4), deliver(1, 4), deliver(2, 4),
    ]));
    expect(world.rows.get("e")).toMatchObject({ isDeleted: true, version: 2, versionNonce: 40 });
    for (const client of world.clients) expect(client.scene.find((element) => element.id === "e")).toMatchObject({ isDeleted: true, versionNonce: 40 });
  });

  it("Sol round 7: while a is being resized, newer a and b arrive (b takes a's old index); the deferred a is replayed and a later 0 still lands where a fresh load puts it", async () => {
    const world = await play("sol7", { clients: 3, ids: ["a", "b", "c", "0"], initial: [row("a", { kind: "fixed", index: "a0" }, 5), row("b", { kind: "fixed", index: "a1" }, 6), row("c", { kind: "fixed", index: "a1V" }, 7)] }, script([
      interact(0, "a"),
      reorder(1, "a", 2, 21, "a2"), reorder(1, "b", 0, 22, "a0"), flush(1), process_(1),
      deliver(0), deliver(2),
      endInteract(0),
      create(2, "0", "a1", 8), flush(2), process_(2),
      deliver(0), deliver(1),
    ]));
    expect(idsOf(world, 0)).toEqual(["b", "0", "c", "a"]);
    expect(new Set(world.clients.map((client) => client.scene.map((element) => element.id).join()))).toHaveProperty("size", 1);
  });

  it("#499 zero size: a rectangle shrunk to a live 0x0 (no pointer-up) is deleted by its own editor, the 0x0 revision is never stored, and every tab shows what a fresh load shows", async () => {
    const world = await play("shrink", { clients: 3, ids: ["a", "b"], initial: [row("a", { kind: "fixed", index: "a0" }, 5), row("b", { kind: "fixed", index: "a1" }, 6)] }, script([
      { op: "shrink", c: 0, id: "a", nonce: 77 }, flush(0), process_(0), deliver(0, 2), deliver(1, 2), deliver(2, 2),
    ]));
    expect(world.rows.get("a")).toMatchObject({ isDeleted: true, version: 3 });
    expect(world.rows.get("a")).toMatchObject({ width: 10, height: 10 });
    for (const client of world.clients) expect(client.scene.filter((element) => element.id === "a" && element.isDeleted !== true)).toEqual([]);
  });
});
