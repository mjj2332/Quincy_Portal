/**
 * #856: notifications and their delivery records are kept for 30 days.
 *
 * - A Notification goes by its own `created_at`.
 * - An outbox intent (with its ledger rows) goes by the outbox age, unless a Notification linked through its ledger is still young
 *   (a delayed or replayed delivery) or the intent holds a live lease. Deleting it earlier would hide a young Notification from its
 *   External Editor, whose visibility joins notification -> sent in-app ledger -> outbox.
 * - Digest items are never left to the `SET NULL` action: an item whose ledger or digest is nulled is claimable again, which is a
 *   duplicate-email path. They are deleted explicitly, in the same atomic batch as the parent they point at.
 * - The outbox delete is guarded by `NOT EXISTS (ledger)`, so the RESTRICT foreign key cannot fire.
 *
 * Every statement is predicate-based, so a missing row means zero changes, never an error. Each page is one atomic `D1.batch`.
 * Ids travel as one JSON string (`json_each`) because D1 caps a statement at 100 bound parameters.
 */
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CHAIN_PAGE = 100;
const LEAF_PAGE = 500;
const MAX_PAGES = 30;
/** Pages kept back from the chain phase so the leaf tables (legacy Notifications, digests, orphan items) always get a turn. */
const LEAF_RESERVE_PAGES = 5;
const BUDGET_MS = 15_000;

export type NotificationRetentionCounts = {
  outbox: number;
  ledger: number;
  notifications: number;
  digestItems: number;
  digests: number;
  /** False when a bound (page count or time budget) stopped the run before the backlog was empty; the next run continues. */
  drained: boolean;
};

export type NotificationRetentionOptions = {
  /** Wall clock for the time budget. Defaults to `Date.now`; tests that fake `Date` pass their own. */
  clock?: () => number;
};

/** An outbox row may go when it is past the cutoff, holds no live lease, and no Notification reached through its ledger is still young. */
const eligible = (cutoff: string, now: string) =>
  `o.created_at < ${cutoff} AND NOT (o.status = 'processing' AND o.lease_expires_at > ${now}) AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger l JOIN notifications n ON n.id = l.notification_id WHERE l.outbox_id = o.id AND n.created_at >= ${cutoff})`;

// The page query binds ?1 = cutoff, ?2 = now.
const CHAIN_PAGE_SQL = `SELECT o.id FROM notification_outbox o WHERE ${eligible("?1", "?2")} LIMIT ${CHAIN_PAGE}`;
// The batch statements bind ?1 = cutoff, ?2 = JSON array of outbox ids, ?3 = now; the predicate is re-applied so a row the consumer changed since the read drops out.
const DOOMED = `SELECT o.id FROM notification_outbox o WHERE o.id IN (SELECT value FROM json_each(?2)) AND ${eligible("?1", "?3")}`;

// ?1 = cutoff. A Notification still tied to an old outbox belongs to the chain phase.
const NOTIFICATION_LEAF_SQL = `SELECT n.id FROM notifications n WHERE n.created_at < ?1 AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger l JOIN notification_outbox o ON o.id = l.outbox_id WHERE l.notification_id = n.id AND o.created_at < ?1) LIMIT ${LEAF_PAGE}`;
const DIGEST_LEAF_SQL = `SELECT id FROM notification_digests WHERE created_at < ?1 LIMIT ${LEAF_PAGE}`;
// Only a true orphan: an item still attached to a Notification, ledger row or digest goes with that parent, never on its own age.
const ORPHAN_ITEM_SQL = `DELETE FROM notification_digest_items WHERE id IN (SELECT id FROM notification_digest_items WHERE created_at < ?1 AND notification_id IS NULL AND ledger_id IS NULL AND digest_id IS NULL LIMIT ${LEAF_PAGE})`;

type Changed = { meta: { changes?: number } } | undefined;
const changes = (result: Changed) => result?.meta.changes ?? 0;

/** Reads one page of ids, then runs `statements(idsJson)` as one atomic batch. Ids travel as a JSON string (`json_each`), D1 caps a statement at 100 binds. */
async function pageThenBatch(d1: D1Database, readSql: string, readBinds: unknown[], statements: (idsJson: string) => D1PreparedStatement[]) {
  const page = await d1.prepare(readSql).bind(...readBinds).all<{ id: string }>();
  const ids = (page.results ?? []).map((row) => row.id);
  if (!ids.length) return { size: 0, results: [] as D1Result[] };
  return { size: ids.length, results: await d1.batch(statements(JSON.stringify(ids))) };
}

export async function pruneExpiredNotifications(d1: D1Database, now = Date.now(), options: NotificationRetentionOptions = {}): Promise<NotificationRetentionCounts> {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + BUDGET_MS;
  const cutoff = now - NOTIFICATION_RETENTION_MS;
  const counts: NotificationRetentionCounts = { outbox: 0, ledger: 0, notifications: 0, digestItems: 0, digests: 0, drained: false };
  let pages = 0;
  const hasRoom = (limit: number) => pages < limit && clock() < deadline;

  // Phase A: whole delivery chains. Capped below the page budget so Phase B always runs; any eligible subset is correct.
  let chainsDrained = false;
  while (hasRoom(MAX_PAGES - LEAF_RESERVE_PAGES)) {
    pages += 1;
    const bind = (sql: string) => (idsJson: string) => d1.prepare(sql).bind(cutoff, idsJson, now);
    const { size, results } = await pageThenBatch(d1, CHAIN_PAGE_SQL, [cutoff, now], (idsJson) => [
      bind(`DELETE FROM notification_digest_items WHERE ledger_id IN (SELECT id FROM notification_delivery_ledger WHERE outbox_id IN (${DOOMED})) OR notification_id IN (SELECT notification_id FROM notification_delivery_ledger WHERE outbox_id IN (${DOOMED}) AND notification_id IS NOT NULL)`)(idsJson),
      bind(`DELETE FROM notifications WHERE created_at < ?1 AND id IN (SELECT notification_id FROM notification_delivery_ledger WHERE outbox_id IN (${DOOMED}) AND notification_id IS NOT NULL)`)(idsJson),
      bind(`DELETE FROM notification_delivery_ledger WHERE outbox_id IN (${DOOMED})`)(idsJson),
      bind(`DELETE FROM notification_outbox WHERE id IN (${DOOMED}) AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger l WHERE l.outbox_id = notification_outbox.id)`)(idsJson),
    ]);
    if (size === 0) { chainsDrained = true; break; }
    const [items, notifications, ledger, outbox] = results;
    counts.digestItems += changes(items);
    counts.notifications += changes(notifications);
    counts.ledger += changes(ledger);
    counts.outbox += changes(outbox);
    // The outbox delete only ever counts outbox rows (its children are already gone), so zero means nothing was removed: the rows were
    // taken between the read and the batch. Stop rather than spin. A short page means the eligible set was fully read.
    if (changes(outbox) === 0 || size < CHAIN_PAGE) { chainsDrained = size < CHAIN_PAGE; break; }
  }

  // Phase B: rows that keep their own clock. Each returns true when its table has nothing more to take.
  // `meta.changes` includes foreign-key actions, so a parent delete's count can be a little high; only "zero" is relied on, and zero is exact.
  const phases: Array<() => Promise<boolean>> = [
    async () => {
      const { size, results } = await pageThenBatch(d1, NOTIFICATION_LEAF_SQL, [cutoff], (idsJson) => [
        d1.prepare("DELETE FROM notification_digest_items WHERE notification_id IN (SELECT value FROM json_each(?1))").bind(idsJson),
        d1.prepare("DELETE FROM notifications WHERE id IN (SELECT value FROM json_each(?1)) AND created_at < ?2").bind(idsJson, cutoff),
      ]);
      const [items, notifications] = results;
      counts.digestItems += changes(items);
      counts.notifications += changes(notifications);
      return size < LEAF_PAGE || changes(notifications) === 0;
    },
    async () => {
      const removed = changes(await d1.prepare(ORPHAN_ITEM_SQL).bind(cutoff).run());
      counts.digestItems += removed;
      return removed < LEAF_PAGE;
    },
    async () => {
      const { size, results } = await pageThenBatch(d1, DIGEST_LEAF_SQL, [cutoff], (idsJson) => [
        d1.prepare("DELETE FROM notification_digest_items WHERE digest_id IN (SELECT value FROM json_each(?1))").bind(idsJson),
        d1.prepare("DELETE FROM notification_digests WHERE id IN (SELECT value FROM json_each(?1)) AND created_at < ?2").bind(idsJson, cutoff),
      ]);
      const [items, digests] = results;
      counts.digestItems += changes(items);
      counts.digests += changes(digests);
      return size < LEAF_PAGE || changes(digests) === 0;
    },
  ];
  let leavesDrained = true;
  for (const phase of phases) {
    let done = false;
    while (!done && hasRoom(MAX_PAGES)) {
      pages += 1;
      done = await phase();
    }
    if (!done) leavesDrained = false;
  }
  counts.drained = chainsDrained && leavesDrained;
  return counts;
}
