import { normaliseRows, orderStored, reconcileRows, type ElementStore, type Reconciliation, type StoredElement, type WhiteboardElement } from "@quincy/shared";

/**
 * The Project whiteboard's scene, one row per Excalidraw element (ADR 0017): every row is far
 * below the 2 MB row limit, and reconciliation is per element, so two people saving over each
 * other can never replace the whole board -- only elements whose version is newer.
 *
 * The Durable Object owns the socket and the broadcast; this module owns the table, as an
 * `ElementStore` over SQLite. What gets stored (revision winners, unique fractional indices) is decided by
 * `@quincy/shared`'s `whiteboard-index.ts`, which the model test runs against an in-memory store. #500's
 * version snapshots live in `snapshot.ts`, beside this module rather than in the object.
 */

type ElementRow = { json: string };
export type { Reconciliation, StoredElement };

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

function sqlStore(storage: DurableObjectStorage): ElementStore {
  const sql = storage.sql;
  const now = Date.now();
  return {
    get: (id) => { const row = sql.exec<ElementRow>("SELECT json FROM elements WHERE id = ?", id).toArray()[0]; return row ? (JSON.parse(row.json) as StoredElement) : undefined; },
    put: (element) => {
      sql.exec(
        `INSERT INTO elements (id, version, version_nonce, is_deleted, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, version_nonce = excluded.version_nonce, is_deleted = excluded.is_deleted, json = excluded.json, updated_at = excluded.updated_at`,
        element.id, element.version, element.versionNonce, element.isDeleted ? 1 : 0, JSON.stringify(element), now,
      );
    },
    indexes: () => sql.exec<{ id: string; idx: string | number | null }>("SELECT id, json_extract(json, '$.index') AS idx FROM elements").toArray().map((row) => ({ id: row.id, index: row.idx })),
    all: () => sql.exec<ElementRow>("SELECT json FROM elements").toArray().map((row) => JSON.parse(row.json) as StoredElement),
  };
}

/** Back-to-front in Excalidraw's fractional `index` order, ties by id. */
export function readElements(storage: DurableObjectStorage): StoredElement[] {
  ensureSchema(storage);
  return orderStored(sqlStore(storage).all());
}

/**
 * Reconciles one batch, all in one transaction (see `reconcileRows`). `afterWrite` runs INSIDE that transaction once the
 * rows are stored (#500: it marks the board dirty, so a change and its dirty mark commit or roll back together).
 */
export function reconcile(storage: DurableObjectStorage, elements: ReadonlyArray<WhiteboardElement>, afterWrite?: (result: Reconciliation) => void): Reconciliation {
  let result!: Reconciliation;
  storage.transactionSync(() => { result = reconcileRows(sqlStore(storage), elements); afterWrite?.(result); });
  return result;
}

/** Brings a table written before indices were unique to the invariant, in one transaction. Returns the rows it changed. */
export function normaliseIndices(storage: DurableObjectStorage, afterWrite?: (changed: StoredElement[]) => void): StoredElement[] {
  ensureSchema(storage);
  let changed: StoredElement[] = [];
  storage.transactionSync(() => { changed = normaliseRows(sqlStore(storage)); if (changed.length > 0) afterWrite?.(changed); });
  return changed;
}

export function clearElements(storage: DurableObjectStorage): void {
  ensureSchema(storage);
  storage.sql.exec("DELETE FROM elements");
}
