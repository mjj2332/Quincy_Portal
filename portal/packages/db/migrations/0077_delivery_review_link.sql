-- Delivery review link (#847). A system-owned Review link per Project, made and kept in step by Publish. client_links is changed in place and never rebuilt: ADD COLUMN, one 0069-style column swap and one partial unique index.
-- delivery_review marks the Project's Delivery review link. It is 0 for every existing row and only the Publish sync and the Admin backfill ever write a 1.
-- expires_at becomes nullable by the same swap 0069 used for publish_version. NULL means never expires and is stored explicitly, never as a far-future date. Every existing value is copied unchanged. expires_at has no index and no CHECK, so it can be dropped. An older Worker still finds the column, so the code can follow the schema.
-- The partial unique index allows at most one Delivery review link per Project for the life of the Project. It does not exclude revoked or deleted rows on purpose.
-- Cross-column rules (a Delivery review link is a video_review link with no passcode, no expiry, all permissions on and the label Delivery) live in the sync SQL and the route refusals, never in a CHECK, as 0069 decided for client_links.
-- Rollback: a code rollback is safe for ordinary links. A Delivery review link made after this ships fails closed on an older Worker, which reads a NULL expiry as expired, so roll forward. Restoring the schema is a D1 Time Travel restore and loses every write since the bookmark.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE client_links ADD COLUMN delivery_review integer NOT NULL DEFAULT 0 CHECK (delivery_review IN (0, 1));
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN expires_at_next integer CHECK (expires_at_next IS NULL OR typeof(expires_at_next) = 'integer');
--> statement-breakpoint
UPDATE client_links SET expires_at_next = expires_at;
--> statement-breakpoint
ALTER TABLE client_links DROP COLUMN expires_at;
--> statement-breakpoint
ALTER TABLE client_links RENAME COLUMN expires_at_next TO expires_at;
--> statement-breakpoint
CREATE UNIQUE INDEX client_links_delivery_review_unique ON client_links (project_id) WHERE delivery_review = 1;
