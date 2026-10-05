-- HEIC images in Embedded media (#495): the display copy of an image the browsers cannot decode.
-- rendition_status says whether a JPEG display copy is needed and how far it has got. It is separate from state, which already means uploaded but not attached.
-- not_required is every existing row and every JPEG, PNG or WebP upload. pending, ready and failed belong to a HEIC row, whose JPEG is written into the display_key column that nothing used until now.
-- display_content_type, display_bytes, display_width and display_height describe that JPEG.
-- rendition_attempts and rendition_lease_until fence the background Worker that converts it. rendition_requested_at is when the work was queued and is the generation of its queue message: only complete and Retry write it. rendition_resent_at is when the minute cron last re-sent a pending row whose message was lost, kept apart so a resend never invalidates the message already in flight.
-- rendition_error is a short reason a row failed.
-- The feature flag opens HEIC to everyone. It is seeded off, so only an Admin can upload HEIC until the owner flips it. The seed never re-asserts a live value.
-- Additive only. No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE embedded_media ADD COLUMN rendition_status text NOT NULL DEFAULT 'not_required' CHECK (rendition_status IN ('not_required', 'pending', 'ready', 'failed'));
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN display_content_type text;
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN display_bytes integer;
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN display_width integer;
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN display_height integer;
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN rendition_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN rendition_lease_until integer;
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN rendition_requested_at integer;
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN rendition_resent_at integer;
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN rendition_error text;
--> statement-breakpoint
CREATE INDEX embedded_media_rendition_idx ON embedded_media (rendition_status, rendition_requested_at);
--> statement-breakpoint
INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('embedded_heic_uploads', 0, NULL, unixepoch('now') * 1000) ON CONFLICT(key) DO NOTHING;
