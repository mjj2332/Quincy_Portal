-- Client Delivery schema (#787 slice 1). Times are epoch milliseconds. Nothing reads or writes the new tables yet.
-- Additive only: one ADD COLUMN on assets, four new tables and their indexes. No table is rebuilt and no PRAGMA is used, so a Worker older than this change ignores all of it and a code rollback is safe. The legacy publishes and premium_unlocks tables are untouched.
-- assets.delivery_premium marks a paid extra on a photo, Floorplan or Copy Asset. The deprecated is_premium column is not revived.
-- delivery_pages holds one row per Project, created at the first Publish. slug is the immutable public address and is unique, so a minting collision surfaces as a UNIQUE error and is retried. latest_set_number points at the set the page serves.
-- delivery_sets is one numbered Published set. set_number is unique per Project so two concurrent Publishes produce one winner. operation_id is the client-chosen id that makes a retried Publish idempotent and is unique per Project. cover_asset_id is the cover chosen for that set and becomes NULL if the Asset is deleted.
-- delivery_set_items is the frozen membership of a set, one row per Asset. A Video Version is an assets row, so one table covers every media kind. handle is the random 16 character public id of the item. Membership cascades with its set and with its Asset.
-- asset_premium_unlocks mirrors video_premium_unlocks. Re-lock deletes the row.
-- Every CHECK is single-column so a later DROP COLUMN stays possible.
-- Rollback: a code rollback is safe. Dropping the objects means a D1 Time Travel restore, which loses every write since the bookmark.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE assets ADD COLUMN delivery_premium integer NOT NULL DEFAULT 0 CHECK (delivery_premium IN (0, 1));
--> statement-breakpoint
CREATE TABLE delivery_pages (
  project_id text PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (length(slug) BETWEEN 8 AND 120),
  enabled integer NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  latest_set_number integer NOT NULL CHECK (latest_set_number >= 1),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at integer NOT NULL CHECK (typeof(updated_at) = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_pages_slug_unique ON delivery_pages (slug);
--> statement-breakpoint
CREATE TABLE delivery_sets (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  set_number integer NOT NULL CHECK (set_number >= 1),
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 64),
  cover_asset_id text REFERENCES assets(id) ON DELETE SET NULL,
  published_by text NOT NULL REFERENCES user(id),
  published_at integer NOT NULL CHECK (typeof(published_at) = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_sets_project_number_unique ON delivery_sets (project_id, set_number);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_sets_project_op_unique ON delivery_sets (project_id, operation_id);
--> statement-breakpoint
CREATE TABLE delivery_set_items (
  set_id text NOT NULL REFERENCES delivery_sets(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  handle text NOT NULL CHECK (length(handle) = 16),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (set_id, asset_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_set_items_handle_unique ON delivery_set_items (set_id, handle);
--> statement-breakpoint
CREATE INDEX delivery_set_items_asset_idx ON delivery_set_items (asset_id);
--> statement-breakpoint
CREATE TABLE asset_premium_unlocks (
  asset_id text PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  unlocked_by text NOT NULL REFERENCES user(id),
  unlocked_at integer NOT NULL CHECK (typeof(unlocked_at) = 'integer'),
  payment_ref text CHECK (payment_ref IS NULL OR length(payment_ref) <= 200)
);
--> statement-breakpoint
CREATE INDEX asset_premium_unlocks_project_idx ON asset_premium_unlocks (project_id);
