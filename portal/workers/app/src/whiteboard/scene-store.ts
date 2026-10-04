import { whiteboardIncomingWins, type WhiteboardElement } from "@quincy/shared";

/**
 * The Project whiteboard's scene, one row per Excalidraw element (ADR 0017): every row is far
 * below the 2 MB row limit, and reconciliation is per element, so two people saving over each
 * other can never replace the whole board -- only elements whose version is newer.
 *
 * The Durable Object owns the socket and the broadcast; this module owns the table. #500 adds its
 * version snapshots in a module beside this one rather than in the object.
 */

type ElementRow = { json: string };
export type StoredElement = Record<string, unknown>;

/** What one batch did: the elements that beat their stored rows (to relay to everyone else), and
 * the stored rows that beat the sender's elements (to send back to the sender, so an ack alone is
 * never what tells a client it lost). */
export type Reconciliation = { winners: WhiteboardElement[]; losers: StoredElement[] };

export function ensureSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS elements (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    version_nonce INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

/** Back-to-front in Excalidraw's fractional `index` order (plain code-unit comparison, as its own
 * ordering uses), ties by id; a missing or non-string index sorts last. */
export function readElements(storage: DurableObjectStorage): StoredElement[] {
  ensureSchema(storage);
  const elements = storage.sql.exec<ElementRow>("SELECT json FROM elements").toArray().map((row) => JSON.parse(row.json) as StoredElement);
  const key = (element: StoredElement) => (typeof element.index === "string" && element.index !== "" ? element.index : null);
  return elements.sort((left, right) => {
    const a = key(left); const b = key(right);
    if (a !== b) { if (a === null) return 1; if (b === null) return -1; return a < b ? -1 : 1; }
    return String(left.id) < String(right.id) ? -1 : 1;
  });
}

/** Writes each incoming element that beats its stored row, all in one transaction. A retried batch
 * (the same version and nonce) neither wins nor counts as a loss: it changes nothing. */
export function reconcile(storage: DurableObjectStorage, elements: ReadonlyArray<WhiteboardElement>, serialised: readonly string[]): Reconciliation {
  const sql = storage.sql;
  const now = Date.now();
  const result: Reconciliation = { winners: [], losers: [] };
  storage.transactionSync(() => {
    elements.forEach((element, index) => {
      const stored = sql.exec<{ version: number; version_nonce: number; json: string }>("SELECT version, version_nonce, json FROM elements WHERE id = ?", element.id).toArray()[0];
      if (!whiteboardIncomingWins(stored ? { version: stored.version, versionNonce: stored.version_nonce } : undefined, element)) {
        if (stored && !(stored.version === element.version && stored.version_nonce === element.versionNonce)) result.losers.push(JSON.parse(stored.json) as StoredElement);
        return;
      }
      sql.exec(
        `INSERT INTO elements (id, version, version_nonce, is_deleted, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, version_nonce = excluded.version_nonce, is_deleted = excluded.is_deleted, json = excluded.json, updated_at = excluded.updated_at`,
        element.id, element.version, element.versionNonce, element.isDeleted ? 1 : 0, serialised[index]!, now,
      );
      result.winners.push(element);
    });
  });
  return result;
}

export function clearElements(storage: DurableObjectStorage): void {
  ensureSchema(storage);
  storage.sql.exec("DELETE FROM elements");
}
