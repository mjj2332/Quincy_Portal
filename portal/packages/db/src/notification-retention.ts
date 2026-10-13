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
export const RETENTION_CHAIN_PAGE = 100;
export const RETENTION_LEAF_PAGE = 500;
export const RETENTION_MAX_PAGES = 30;
export const RETENTION_BUDGET_MS = 15_000;

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
  maxPages?: number;
  budgetMs?: number;
};

// ?1 = cutoff, ?2 = JSON array of outbox ids, ?3 = now.
const YOUNG_NOTIFICATION = `EXISTS (SELECT 1 FROM notification_delivery_ledger l JOIN notifications n ON n.id = l.notification_id WHERE l.outbox_id = o.id AND n.created_at >= ?1)`;
const ELIGIBLE = `o.created_at < ?1 AND NOT (o.status = 'processing' AND o.lease_expires_at > ?3) AND NOT ${YOUNG_NOTIFICATION}`;
const DOOMED = `SELECT o.id FROM notification_outbox o WHERE o.id IN (SELECT value FROM json_each(?2)) AND ${ELIGIBLE}`;
const CHAIN_PAGE_SQL = `SELECT o.id FROM notification_outbox o WHERE ${ELIGIBLE} LIMIT ${RETENTION_CHAIN_PAGE}`;

const NOTIFICATION_LEAF_SQL = `SELECT n.id FROM notifications n WHERE n.created_at < ?1 AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger l JOIN notification_outbox o ON o.id = l.outbox_id WHERE l.notification_id = n.id AND o.created_at < ?1) LIMIT ${RETENTION_LEAF_PAGE}`;
const DIGEST_LEAF_SQL = `SELECT id FROM notification_digests WHERE created_at < ?1 LIMIT ${RETENTION_LEAF_PAGE}`;

const changes = (result: { meta: { changes?: number } }) => result.meta.changes ?? 0;

export async function pruneExpiredNotifications(d1: D1Database, now = Date.now(), options: NotificationRetentionOptions = {}): Promise<NotificationRetentionCounts> {
  const clock = options.clock ?? Date.now;
  const maxPages = options.maxPages ?? RETENTION_MAX_PAGES;
  const deadline = clock() + (options.budgetMs ?? RETENTION_BUDGET_MS);
  const cutoff = now - NOTIFICATION_RETENTION_MS;
  const counts: NotificationRetentionCounts = { outbox: 0, ledger: 0, notifications: 0, digestItems: 0, digests: 0, drained: false };
  let pages = 0;
  const hasRoom = () => pages < maxPages && clock() < deadline;

  // Phase A: whole delivery chains, oldest-eligible first by no particular order (any eligible subset is correct).
  let chainsDrained = false;
  while (hasRoom()) {
    pages += 1;
    const page = await d1.prepare(CHAIN_PAGE_SQL).bind(cutoff, null, now).all<{ id: string }>();
    // ?2 (the id list) is unused by the page query but numbered placeholders need every slot bound.
    const ids = (page.results ?? []).map((row) => row.id);
    if (!ids.length) { chainsDrained = true; break; }
    const idsJson = JSON.stringify(ids);
    const bind = (sql: string) => d1.prepare(sql).bind(cutoff, idsJson, now);
    const [items, notifications, ledger, outbox] = await d1.batch([
      bind(`DELETE FROM notification_digest_items WHERE ledger_id IN (SELECT id FROM notification_delivery_ledger WHERE outbox_id IN (${DOOMED})) OR notification_id IN (SELECT notification_id FROM notification_delivery_ledger WHERE outbox_id IN (${DOOMED}) AND notification_id IS NOT NULL)`),
      bind(`DELETE FROM notifications WHERE created_at < ?1 AND id IN (SELECT notification_id FROM notification_delivery_ledger WHERE outbox_id IN (${DOOMED}) AND notification_id IS NOT NULL)`),
      bind(`DELETE FROM notification_delivery_ledger WHERE outbox_id IN (${DOOMED})`),
      bind(`DELETE FROM notification_outbox WHERE id IN (${DOOMED}) AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger l WHERE l.outbox_id = notification_outbox.id)`),
    ]);
    counts.digestItems += changes(items!);
    counts.notifications += changes(notifications!);
    counts.ledger += changes(ledger!);
    counts.outbox += changes(outbox!);
    // A page that removed nothing means the rows were taken between the read and the batch; stop rather than spin.
    if (changes(outbox!) === 0) { chainsDrained = ids.length < RETENTION_CHAIN_PAGE; break; }
    if (ids.length < RETENTION_CHAIN_PAGE) { chainsDrained = true; break; }
  }
  if (!chainsDrained) return counts;

  // Phase B: rows that keep their own clock (legacy direct Notifications, reuse-linked ones, orphan items, digests).
  let leavesDrained = true;
  const phases: Array<() => Promise<boolean>> = [
    async () => {
      const page = await d1.prepare(NOTIFICATION_LEAF_SQL).bind(cutoff).all<{ id: string }>();
      const ids = (page.results ?? []).map((row) => row.id);
      if (!ids.length) return true;
      const idsJson = JSON.stringify(ids);
      const [items, notifications] = await d1.batch([
        d1.prepare("DELETE FROM notification_digest_items WHERE notification_id IN (SELECT value FROM json_each(?1))").bind(idsJson),
        d1.prepare("DELETE FROM notifications WHERE id IN (SELECT value FROM json_each(?1)) AND created_at < ?2").bind(idsJson, cutoff),
      ]);
      counts.digestItems += changes(items!);
      counts.notifications += changes(notifications!);
      return ids.length < RETENTION_LEAF_PAGE || changes(notifications!) === 0;
    },
    async () => {
      const result = await d1.prepare(`DELETE FROM notification_digest_items WHERE id IN (SELECT id FROM notification_digest_items WHERE created_at < ?1 LIMIT ${RETENTION_LEAF_PAGE})`).bind(cutoff).run();
      counts.digestItems += changes(result);
      return changes(result) < RETENTION_LEAF_PAGE;
    },
    async () => {
      const page = await d1.prepare(DIGEST_LEAF_SQL).bind(cutoff).all<{ id: string }>();
      const ids = (page.results ?? []).map((row) => row.id);
      if (!ids.length) return true;
      const idsJson = JSON.stringify(ids);
      const [items, digests] = await d1.batch([
        d1.prepare("DELETE FROM notification_digest_items WHERE digest_id IN (SELECT value FROM json_each(?1))").bind(idsJson),
        d1.prepare("DELETE FROM notification_digests WHERE id IN (SELECT value FROM json_each(?1)) AND created_at < ?2").bind(idsJson, cutoff),
      ]);
      counts.digestItems += changes(items!);
      counts.digests += changes(digests!);
      return ids.length < RETENTION_LEAF_PAGE || changes(digests!) === 0;
    },
  ];
  for (const phase of phases) {
    let done = false;
    while (!done && hasRoom()) {
      pages += 1;
      done = await phase();
    }
    if (!done) leavesDrained = false;
  }
  counts.drained = leavesDrained;
  return counts;
}
