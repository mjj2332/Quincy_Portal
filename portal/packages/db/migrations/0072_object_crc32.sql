-- Object CRC-32 cache (#802, the shared foundation for #787 slice 7). Times are epoch milliseconds.
-- Additive only: two new tables. No column is added to an existing table, no table is rebuilt and no PRAGMA is used, so a Worker older than this change ignores it and a code rollback is safe.
-- object_crc32 holds, per R2 object, the CRC-32 and size a native ZIP writer needs to put them in the local header ahead of the bytes. It is keyed by R2 key so one table serves photos, RAW and video originals alike.
-- crc32 is the unsigned 32-bit checksum. etag is the R2 etag of the object that was read, so a row for an overwritten object is recognised as stale and is recomputed, never trusted.
-- There is no foreign key on purpose: a row outlives the asset that pointed at it and is harmless, because a ZIP entry is only written when the stored etag still matches the object.
-- object_crc32_work is the job state of the background CRC computation. One row per object being worked on, keyed by R2 key: queued (waiting for the next range), running (a range is being read) or failed (retries exhausted, last_error says why).
-- A row carries the running CRC-32 (crc_partial) and the byte offset reached, so an object of any size is read in ranges of at most 512 MiB, one queue message each, and resumed rather than restarted.
-- claim_token is a random token that every claim of the row replaces, and it is NULL while the row is queued. Whoever claims a range holds the token it got, and every later write of that owner (advance, finish, failure) is fenced on it. A token never repeats, even after the row is deleted and made again, so a displaced delivery can never fail, move or finish a run it does not hold.
-- etag and bytes stay NULL until the first range reads the object (a sweep queues keys it has never seen). Rows are short lived: the final range upserts object_crc32 and deletes the row in one batch.
-- Rollback: a code rollback is safe. Dropping the table means a D1 Time Travel restore, which loses every write since the bookmark. A dropped table only costs a recompute.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
CREATE TABLE object_crc32 (
  r2_key text PRIMARY KEY NOT NULL CHECK (length(r2_key) >= 1),
  crc32 integer NOT NULL CHECK (typeof(crc32) = 'integer' AND crc32 >= 0 AND crc32 <= 4294967295),
  bytes integer NOT NULL CHECK (typeof(bytes) = 'integer' AND bytes >= 0),
  etag text NOT NULL CHECK (length(etag) >= 1),
  computed_at integer NOT NULL CHECK (typeof(computed_at) = 'integer')
);
--> statement-breakpoint
CREATE TABLE object_crc32_work (
  r2_key text PRIMARY KEY NOT NULL CHECK (length(r2_key) >= 1),
  etag text CHECK (etag IS NULL OR length(etag) >= 1),
  bytes integer CHECK (bytes IS NULL OR (typeof(bytes) = 'integer' AND bytes >= 0)),
  "offset" integer NOT NULL DEFAULT 0 CHECK (typeof("offset") = 'integer' AND "offset" >= 0 AND (bytes IS NULL OR "offset" <= bytes) AND (etag IS NOT NULL OR "offset" = 0)),
  crc_partial integer NOT NULL DEFAULT 0 CHECK (typeof(crc_partial) = 'integer' AND crc_partial >= 0 AND crc_partial <= 4294967295),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
  requested_at integer NOT NULL CHECK (typeof(requested_at) = 'integer'),
  updated_at integer NOT NULL CHECK (typeof(updated_at) = 'integer'),
  last_error text,
  claim_token text CHECK (claim_token IS NULL OR length(claim_token) >= 1),
  CHECK ((etag IS NULL) = (bytes IS NULL))
);
