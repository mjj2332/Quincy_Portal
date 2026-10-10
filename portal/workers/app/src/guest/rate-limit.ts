/**
 * Guest rate limits (#741 12a, §2): fixed 15-minute windows in `guest_rate_limits`. A reservation is ONE statement: insert the first attempt, or bump the count only while it is
 * under the limit, and RETURN the new count. No row back means limited, so two concurrent attempts at limit-1 admit exactly one. No Worker secret: the address is stored only as
 * the SHA-256 of `ip|window`, so it is never raw and a new window is a new key.
 */
export const GUEST_WINDOW_MS = 15 * 60_000;
export const GUEST_LIMITS = { passcodeLink: 20, passcodeIp: 10, exchangeIp: 60 } as const;

const RESERVE_SQL = `INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?1, ?2, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < ?3 RETURNING count`;

export const windowStart = (now: number): number => Math.floor(now / GUEST_WINDOW_MS) * GUEST_WINDOW_MS;

async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const clientAddress = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "unknown";
export const ipBucket = async (kind: "passcode" | "exchange", ip: string, start: number): Promise<string> => `${kind}:ip:${await sha256Hex(`${ip}|${start}`)}`;

export type Reservation = { bucket: string; limit: number };
/** Reserves one attempt in each bucket in one batch. `limited` is true when any bucket was already full; `retryAfterSeconds` runs to the end of the window. */
export async function reserveAttempts(db: D1Database, reservations: Reservation[], now: number): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const start = windowStart(now);
  const results = await db.batch(reservations.map((entry) => db.prepare(RESERVE_SQL).bind(entry.bucket, start, entry.limit)));
  const limited = results.some((result) => result.results.length === 0);
  return { limited, retryAfterSeconds: Math.max(1, Math.ceil((start + GUEST_WINDOW_MS - now) / 1000)) };
}
