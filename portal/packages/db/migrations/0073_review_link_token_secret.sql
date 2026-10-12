-- Review link token secret (#815). Additive only: one nullable column on client_links, no default, no backfill, no rebuild, no PRAGMA, so a Worker older than this change ignores it and a code rollback is safe.
-- token_secret holds the link's plain-text secret so staff can copy the full link again. Owner decision 2026-10-12: stored in plain text beside token_hash. Accepted risk: anyone who can read the database can open every Review link that has one.
-- Verification is unchanged and still uses token_hash only. The secret is never used to authenticate a guest.
-- Existing review links and every delivery link stay NULL. A NULL secret means the link cannot be shown again until it is replaced. Revoking a link sets it back to NULL.
-- The CHECK rejects an empty string so a blank secret can never read as a usable one.
-- Rollback: a code rollback is safe. Dropping the column means a D1 Time Travel restore, which loses every write since the bookmark.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE client_links ADD COLUMN token_secret text CHECK (token_secret IS NULL OR length(token_secret) >= 1);
