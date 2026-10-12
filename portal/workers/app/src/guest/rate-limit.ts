/**
 * Guest rate limits (#741 12a, §2): fixed 15-minute windows in `guest_rate_limits`. A reservation is ONE statement: insert the first attempt, or bump the count only while it is
 * under the limit, and RETURN the new count. No row back means limited, so two concurrent attempts at limit-1 admit exactly one. No Worker secret: the address is stored only as
 * the SHA-256 of `ip|window`, so it is never raw and a new window is a new key.
 */
export const GUEST_WINDOW_MS = 15 * 60_000;
export const GUEST_DAY_MS = 86_400_000;
export const GUEST_LIMITS = {
  passcodeLink: 20, passcodeIp: 10, exchangeIp: 60,
  // Email codes (#741 13a). A session may ask once a minute, an address 5 times in 15 minutes and 20 in a day, a link 30 and an IP 10 in 15 minutes; verifying is 100 a link and 30 an IP.
  codeSendSession: 1, codeSendEmail: 5, codeSendEmailDay: 20, codeSendLink: 30, codeSendIp: 10, codeVerifyLink: 100, codeVerifyIp: 30,
  // Note writes (#741 13b): create, reply, edit and delete each cost one; a guest may write 60 in 15 minutes and a link 300.
  noteGuest: 60, noteLink: 300,
  // Client decisions (#741 14a): a guest may decide 20 times in 15 minutes and a link 100.
  decisionGuest: 20, decisionLink: 100,
  // Download all (#741 14b): a zip start costs the most, so a guest may start 10 in 15 minutes and a link 30. Single and Range downloads have no limit.
  zipGuest: 10, zipLink: 30,
  // Preparing Download all (#802): a prepare queues background work but streams nothing, and a page asks once per click, so a guest may ask 20 times in 15 minutes and a link 60. It never touches the zip quota above.
  zipPrepareGuest: 20, zipPrepareLink: 60,
  // Digest subscription (#741 15b): the unsubscribe link is 30 per address in 15 minutes (it carries no gate and no session), and a verified guest may flip the switch 30 times.
  unsubscribeIp: 30, subscriptionGuest: 30,
  // Paste previews (#741 13d): a preview writes nothing, so it has its own buckets and never spends the note quota a commit needs; a guest may preview 60 times in 15 minutes and a link 300.
  pastePreviewGuest: 60, pastePreviewLink: 300,
  // Delivery unlock request (#787 slice 8): an address may ask 5 times in 15 minutes and a page 30 in a day (a request costs one in each, valid or not); one item is asked about once a day.
  unlockIp: 5, unlockPage: 30, unlockItem: 1,
  // Delivery photo zips (#787 slice 7), per 15 minutes. A zip start costs the most (an address 10, a page 60); preparing queues work but streams nothing (20, 120); a check is a manifest read or a zip GET that
  // HEADs every object, spent before the first HEAD (60, 300). Preparing and refusals never spend a start.
  deliveryZipIp: 10, deliveryZipPage: 60, deliveryPrepareIp: 20, deliveryPreparePage: 120, deliveryCheckIp: 60, deliveryCheckPage: 300,
} as const;
export const GUEST_CODE_RESEND_MS = 60_000;

// `?4` is the amount. The first attempt of a window is an INSERT ... SELECT with its own WHERE (which SQLite also needs to tell the upsert from a join), so an amount larger than the
// limit inserts nothing; an existing row is bumped only while the new count still fits. No row back means limited.
const RESERVE_SQL = `INSERT INTO guest_rate_limits (bucket, window_start, count) SELECT ?1, ?2, ?4 WHERE ?4 <= ?3
  ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + ?4 WHERE count + ?4 <= ?3 RETURNING count`;

export const windowStart = (now: number, windowMs: number = GUEST_WINDOW_MS): number => Math.floor(now / windowMs) * windowMs;

async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const clientAddress = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "unknown";
export const ipBucket = async (kind: "passcode" | "exchange" | "codesend" | "codeverify" | "unsubscribe" | "unlock" | "dlzip" | "dlprep" | "dlcheck", ip: string, start: number): Promise<string> => `${kind}:ip:${await sha256Hex(`${ip}|${start}`)}`;
/** An email bucket is keyed by the SHA-256 of `email|window`, never the address itself (the table holds no address, raw or plain). `codesend24h` is the daily one. */
export const emailBucket = async (kind: "codesend" | "codesend24h", email: string, start: number): Promise<string> => `${kind}:email:${await sha256Hex(`${email}|${start}`)}`;

/** `windowMs` defaults to the 15-minute window; the 60-second resend counter and the daily address cap name theirs. `amount` (default 1) is how many attempts one reservation spends, for a batch such as a paste. */
export type Reservation = { bucket: string; limit: number; windowMs?: number; amount?: number };
/**
 * Reserves `amount` attempts (default one) in each bucket in one batch. `limited` is true when any bucket was already full; `retryAfterSeconds` is the longest remaining time of the buckets that were
 * full, so a daily cap never hides behind a one-minute one (and the other way round).
 */
export async function reserveAttempts(db: D1Database, reservations: Reservation[], now: number): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const windows = reservations.map((entry) => entry.windowMs ?? GUEST_WINDOW_MS);
  const results = await db.batch(reservations.map((entry, index) => db.prepare(RESERVE_SQL).bind(entry.bucket, windowStart(now, windows[index]), entry.limit, entry.amount ?? 1)));
  let retry = 0; let limited = false;
  results.forEach((result, index) => {
    if (result.results.length > 0) return;
    limited = true; retry = Math.max(retry, windowStart(now, windows[index]) + windows[index]! - now);
  });
  return { limited, retryAfterSeconds: Math.max(1, Math.ceil(retry / 1000)) };
}

/** Gives back one attempt in a bucket (a request that reserved its slot and then found nothing to write must not spend the slot for the rest of the window). The table requires `count >= 1`, so the last one deletes the row. */
export async function refundAttempt(db: D1Database, bucket: string, now: number, windowMs: number = GUEST_WINDOW_MS): Promise<void> {
  const start = windowStart(now, windowMs);
  await db.batch([
    db.prepare("UPDATE guest_rate_limits SET count = count - 1 WHERE bucket = ?1 AND window_start = ?2 AND count > 1").bind(bucket, start),
    db.prepare("DELETE FROM guest_rate_limits WHERE bucket = ?1 AND window_start = ?2 AND count <= 1").bind(bucket, start),
  ]);
}

/**
 * Like `reserveAttempts`, but both or neither: when any bucket is full, the buckets that did take the attempt are given it back, so a request refused by one limit never drains another (a client over its
 * address limit cannot fill the page's bucket). The give-back is a second batch, so a crash between the two can only over-charge, never under-charge.
 */
export async function reserveAllOrNone(db: D1Database, reservations: Reservation[], now: number): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const windows = reservations.map((entry) => entry.windowMs ?? GUEST_WINDOW_MS);
  const results = await db.batch(reservations.map((entry, index) => db.prepare(RESERVE_SQL).bind(entry.bucket, windowStart(now, windows[index]), entry.limit, entry.amount ?? 1)));
  const took = results.map((result) => result.results.length > 0);
  if (took.every(Boolean)) return { limited: false, retryAfterSeconds: 1 };
  let retry = 0;
  results.forEach((result, index) => { if (!took[index]) retry = Math.max(retry, windowStart(now, windows[index]) + windows[index]! - now); });
  for (const [index, entry] of reservations.entries()) if (took[index]) await refundAttempt(db, entry.bucket, now, windows[index]);
  return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil(retry / 1000)) };
}
