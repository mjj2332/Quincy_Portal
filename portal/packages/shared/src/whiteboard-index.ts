import { generateKeyBetween } from "fractional-indexing";
import { whiteboardIncomingWins, type WhiteboardElement } from "./whiteboard-protocol";

/**
 * The Project whiteboard's element table as the reconciliation rules see it (ADR 0017). The Durable Object backs it with
 * SQLite (`workers/app/src/whiteboard/scene-store.ts`); the model test backs it with a Map. Everything that decides what
 * is stored lives here, in one place that both can run.
 *
 * #499, the invariant: the indices of the stored rows (tombstones included) are UNIQUE and VALID. Excalidraw repairs a
 * clash by `mutateElement`, which bumps `version` and draws a new `versionNonce`: a client that held two shapes at one
 * index would "edit" one of them, and the saver would send that. The first design kept the repairs local and tracked a
 * "canonical" index beside the rendered one on every client; it needed ever more bookkeeping, and every case it missed was
 * a tab that ordered overlapping shapes differently from a fresh load. The server therefore assigns the index, once,
 * inside the transaction, and never lets two rows share one. A client that is handed unique indices has nothing to repair.
 */
export type StoredElement = Record<string, unknown> & { id: string; version: number; versionNonce: number; isDeleted: boolean };
export interface ElementStore {
  get(id: string): StoredElement | undefined;
  /** Insert or replace the row for `element.id`. */
  put(element: StoredElement): void;
  /** Every row's id and index, tombstones included (the index is whatever the row holds, valid or not). */
  indexes(): Array<{ id: string; index: unknown }>;
  all(): StoredElement[];
}

/** What one batch did. `winners` are the rows that beat their stored copy, in STORED form (to relay to everyone else);
 * `losers` the stored rows that beat the sender's elements (sent back before the ack); `rewritten` the subset of winners
 * the server stored under a different index than the sender gave them (also sent back to the sender, who must adopt it). */
export type Reconciliation = { winners: StoredElement[]; losers: StoredElement[]; rewritten: StoredElement[] };

/**
 * The nonce of a row the SERVER re-keyed. It is the largest a client can have drawn, so the row loses every version tie
 * (the lower nonce wins, both in `whiteboardIncomingWins` and in Excalidraw's `shouldDiscardRemoteElement`): a genuine
 * edit a person made at the same version beats it on the client, is sent again, and the server keeps its content and
 * re-keys it again at a higher version. A re-key is a layout decision, so it must never cost anyone an edit.
 */
export const WHITEBOARD_SERVER_NONCE = 2 ** 31 - 1;

const BASE62 = /^[0-9A-Za-z]+$/;
/** A fractional index `generateKeyBetween` accepts (it rejects a trailing zero and an invalid integer head, but not a stray
 * character, which would corrupt every key generated next to it). */
export function isValidIndex(value: unknown): value is string {
  if (typeof value !== "string" || !BASE62.test(value)) return false;
  try { generateKeyBetween(value, null); return true; } catch { return false; }
}

const keyOf = (element: StoredElement): string | null => (typeof element.index === "string" && element.index !== "" ? element.index : null);

/** Back-to-front in Excalidraw's fractional `index` order (plain code-unit comparison, as its own ordering uses), ties by
 * id; a missing or non-string index sorts last. */
export function orderStored(elements: readonly StoredElement[]): StoredElement[] {
  return [...elements].sort((left, right) => {
    const a = keyOf(left); const b = keyOf(right);
    if (a !== b) { if (a === null) return 1; if (b === null) return -1; return a < b ? -1 : 1; }
    return left.id < right.id ? -1 : 1;
  });
}

/**
 * A set of fractional indices that are taken, each by one id, and the one way this codebase makes a new one. The server
 * uses it to keep stored indices unique and a client uses it to move an unsent shape out of the way of a stored one:
 * a single key generator, so the two can never disagree about what "next to" means.
 */
export class IndexSpace {
  private readonly sorted: string[] = [];
  private readonly holders = new Map<string, string>();

  holder(index: string): string | undefined { return this.holders.get(index); }

  /** Takes `index` for `id`. False (and nothing changes) when another id holds it or it is not a valid index. */
  claim(index: unknown, id: string): boolean {
    if (!isValidIndex(index)) return false;
    const holder = this.holders.get(index);
    if (holder !== undefined) return holder === id;
    this.holders.set(index, id);
    let low = 0; let high = this.sorted.length;
    while (low < high) { const mid = (low + high) >> 1; if (this.sorted[mid]! < index) low = mid + 1; else high = mid; }
    this.sorted.splice(low, 0, index);
    return true;
  }

  /** The smallest taken index above `index`, or null. */
  above(index: string): string | null {
    let low = 0; let high = this.sorted.length;
    while (low < high) { const mid = (low + high) >> 1; if (this.sorted[mid]! <= index) low = mid + 1; else high = mid; }
    return this.sorted[low] ?? null;
  }

  /** A new valid index for `id`: just above `wanted` when that is a usable key someone else holds, else the end of the board.
   * It is strictly between two neighbours in the set, so it equals no taken index. Takes it. */
  place(wanted: unknown, id: string): string {
    const base = isValidIndex(wanted) ? wanted : (this.sorted.at(-1) ?? null);
    const key = generateKeyBetween(base, base === null ? null : this.above(base));
    this.claim(key, id);
    return key;
  }
}

/** The stored form of an element the server re-keyed: a revision of the server's own that loses every tie. */
function rekeyed(element: StoredElement, index: string): StoredElement {
  return { ...element, index, version: Math.min(element.version + 1, Number.MAX_SAFE_INTEGER), versionNonce: WHITEBOARD_SERVER_NONCE };
}

/**
 * Stores each incoming element that beats its stored row, with a unique valid index. Revision winners are resolved first
 * (a retried batch, the same version and nonce, neither wins nor counts as a loss); then every winner whose index is
 * missing, malformed, or held by another id (a stored row, or an earlier element of the same batch) is re-keyed just above
 * the contested index. An element moving off an index frees it for another in the same batch.
 */
export function reconcileRows(store: ElementStore, elements: ReadonlyArray<WhiteboardElement>): Reconciliation {
  const result: Reconciliation = { winners: [], losers: [], rewritten: [] };
  const winning = new Map<string, StoredElement>();
  for (const element of elements) {
    const inBatch = winning.get(element.id);
    const stored = inBatch ?? store.get(element.id);
    if (!whiteboardIncomingWins(stored, element)) {
      if (!inBatch && stored && !(stored.version === element.version && stored.versionNonce === element.versionNonce)) result.losers.push(stored);
      continue;
    }
    winning.set(element.id, element as StoredElement);
  }
  if (winning.size === 0) return result;

  const space = new IndexSpace();
  for (const { id, index } of store.indexes()) if (!winning.has(id)) space.claim(index, id);
  const contested: StoredElement[] = [];
  for (const element of winning.values()) if (!space.claim(element.index, element.id)) contested.push(element);
  for (const element of contested) {
    const row = rekeyed(element, space.place(element.index, element.id));
    winning.set(element.id, row);
    result.rewritten.push(row);
  }
  for (const row of winning.values()) { store.put(row); result.winners.push(row); }
  return result;
}

/**
 * Brings a table written before indices were unique to the invariant: duplicate, missing and malformed indices are
 * re-keyed, the lowest id keeping a contested index (the order a fresh load already showed). Returns the rows it changed,
 * to tell every open socket. A table that is already unique is scanned and left alone.
 */
export function normaliseRows(store: ElementStore): StoredElement[] {
  const rows = store.all().sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const space = new IndexSpace();
  const contested = rows.filter((row) => !space.claim(row.index, row.id));
  return contested.map((row) => {
    const next = rekeyed(row, space.place(row.index, row.id));
    store.put(next);
    return next;
  });
}
