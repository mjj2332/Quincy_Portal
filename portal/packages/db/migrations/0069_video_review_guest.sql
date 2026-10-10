-- Guest-side video review schema (#741 PR 10). Times are epoch milliseconds. No route reads the new tables yet.
-- client_links is changed in place and never rebuilt: only ADD COLUMN, the 0040-style column swap and the 0064-style DROP COLUMN are used. Every CHECK on it is single-column, because a cross-column CHECK would need a rebuild and would also block a later DROP COLUMN of a column it names.
-- kind separates the legacy delivery link from the new video_review link. allow_comments, allow_approve and allow_download are per-link guest permissions. token_generation is bumped by Replace link and by revoke so older guest sessions stop matching.
-- created_by, updated_at, revoked_by and revoked_at are nullable because an FK column added by ALTER must default to NULL and because delivery rows predate them. The cross-column rules are enforced in the route SQL and pinned by tests: a video_review link needs created_by and updated_at, a delivery link needs publish_version, and revoked_at and revoked_by are both set or both null.
-- revoked (a boolean) is replaced by revoked_at, and existing revoked rows get revoked_at = created_at as the best known time. publish_version becomes nullable by the same swap so a video_review link can leave it empty. These are the only two DROP COLUMN statements, and no deployed Worker reads either column. premium_unlocks is untouched and client_links.id never changes, so its foreign key is unaffected.
-- review_link_videos is a link's Video membership and review_link_version_grants is the per-Version access a link has, both with removed or revoked history. A partial unique index allows one live row per pair, so a removed Video can be added again as a new row.
-- guest_sessions is an anonymous watch session until slice 13 fills guest_id and verified_at. guest_rate_limits is keyed by a hashed bucket with no entity id. guest_email_codes holds single-use codes with a five-try cap. Hash columns are plain text so a versioned prefix can change the algorithm without a migration.
-- guest_link_members, guest_unsubscribe_tokens and guest_notification_digest back the verified-subscriber digest. An unsubscribe token belongs to exactly one membership through guest_link_members.id (a surrogate key, because the QA teardown graph supports only single-column keys to an id column), so a re-created membership never inherits old tokens.
-- Foreign keys to projects, assets, videos, client_links, guest_sessions and guest_link_members cascade, and so do the guest_reviewers keys of sessions, members and digest rows. Foreign keys to user and video_approval_events.actor_guest_id are NO ACTION as in 0068.
-- Rollback: no Worker reads the dropped columns, so a code rollback is safe. Restoring the schema is a D1 Time Travel restore and loses every write since the bookmark.
-- No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE client_links ADD COLUMN kind text NOT NULL DEFAULT 'delivery' CHECK (kind IN ('delivery', 'video_review'));
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN label text CHECK (label IS NULL OR length(trim(label)) BETWEEN 1 AND 80);
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN allow_comments integer NOT NULL DEFAULT 1 CHECK (allow_comments IN (0, 1));
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN allow_approve integer NOT NULL DEFAULT 1 CHECK (allow_approve IN (0, 1));
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN allow_download integer NOT NULL DEFAULT 1 CHECK (allow_download IN (0, 1));
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN created_by text REFERENCES user(id);
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN token_generation integer NOT NULL DEFAULT 1 CHECK (token_generation >= 1);
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN updated_at integer CHECK (updated_at IS NULL OR typeof(updated_at) = 'integer');
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN revoked_at integer CHECK (revoked_at IS NULL OR typeof(revoked_at) = 'integer');
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN revoked_by text REFERENCES user(id);
--> statement-breakpoint
UPDATE client_links SET revoked_at = created_at WHERE revoked <> 0;
--> statement-breakpoint
ALTER TABLE client_links DROP COLUMN revoked;
--> statement-breakpoint
ALTER TABLE client_links ADD COLUMN publish_version_next integer CHECK (publish_version_next IS NULL OR publish_version_next >= 1);
--> statement-breakpoint
UPDATE client_links SET publish_version_next = publish_version;
--> statement-breakpoint
ALTER TABLE client_links DROP COLUMN publish_version;
--> statement-breakpoint
ALTER TABLE client_links RENAME COLUMN publish_version_next TO publish_version;
--> statement-breakpoint
CREATE INDEX client_links_project_kind_idx ON client_links (project_id, kind, created_at);
--> statement-breakpoint
CREATE TABLE review_link_videos (
  id text PRIMARY KEY NOT NULL,
  link_id text NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  added_by text NOT NULL REFERENCES user(id),
  added_at integer NOT NULL CHECK (typeof(added_at) = 'integer'),
  removed_at integer CHECK (removed_at IS NULL OR typeof(removed_at) = 'integer'),
  removed_by text REFERENCES user(id),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX review_link_videos_live_unique ON review_link_videos (link_id, video_id) WHERE removed_at IS NULL;
--> statement-breakpoint
CREATE INDEX review_link_videos_video_idx ON review_link_videos (video_id, removed_at);
--> statement-breakpoint
CREATE TABLE review_link_version_grants (
  id text PRIMARY KEY NOT NULL,
  link_id text NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  granted_by text NOT NULL REFERENCES user(id),
  granted_at integer NOT NULL CHECK (typeof(granted_at) = 'integer'),
  revoked_at integer CHECK (revoked_at IS NULL OR typeof(revoked_at) = 'integer'),
  revoked_by text REFERENCES user(id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX review_link_version_grants_live_unique ON review_link_version_grants (link_id, asset_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX review_link_version_grants_link_video_idx ON review_link_version_grants (link_id, video_id);
--> statement-breakpoint
CREATE TABLE guest_sessions (
  id text PRIMARY KEY NOT NULL,
  token_hash text NOT NULL UNIQUE,
  link_id text NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  link_generation integer NOT NULL CHECK (link_generation >= 1),
  guest_id text REFERENCES guest_reviewers(id) ON DELETE CASCADE,
  verified_at integer CHECK (verified_at IS NULL OR typeof(verified_at) = 'integer'),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  expires_at integer NOT NULL CHECK (typeof(expires_at) = 'integer'),
  last_seen_at integer NOT NULL CHECK (typeof(last_seen_at) = 'integer'),
  CHECK ((guest_id IS NULL) = (verified_at IS NULL)),
  CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE INDEX guest_sessions_link_idx ON guest_sessions (link_id);
--> statement-breakpoint
CREATE INDEX guest_sessions_expires_idx ON guest_sessions (expires_at);
--> statement-breakpoint
CREATE TABLE guest_rate_limits (
  bucket text NOT NULL,
  window_start integer NOT NULL CHECK (typeof(window_start) = 'integer'),
  count integer NOT NULL CHECK (count >= 1),
  PRIMARY KEY (bucket, window_start)
);
--> statement-breakpoint
CREATE INDEX guest_rate_limits_window_idx ON guest_rate_limits (window_start);
--> statement-breakpoint
CREATE TABLE guest_email_codes (
  id text PRIMARY KEY NOT NULL,
  link_id text NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
  email_normalized text NOT NULL CHECK (length(email_normalized) <= 254),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at integer NOT NULL CHECK (typeof(expires_at) = 'integer'),
  consumed_at integer CHECK (consumed_at IS NULL OR typeof(consumed_at) = 'integer'),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer')
);
--> statement-breakpoint
CREATE INDEX guest_email_codes_session_created_idx ON guest_email_codes (session_id, created_at);
--> statement-breakpoint
CREATE INDEX guest_email_codes_link_email_created_idx ON guest_email_codes (link_id, email_normalized, created_at);
--> statement-breakpoint
CREATE TABLE guest_link_members (
  id text PRIMARY KEY NOT NULL,
  link_id text NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  guest_id text NOT NULL REFERENCES guest_reviewers(id) ON DELETE CASCADE,
  first_verified_at integer NOT NULL CHECK (typeof(first_verified_at) = 'integer'),
  last_verified_at integer NOT NULL CHECK (typeof(last_verified_at) = 'integer'),
  last_seen_at integer NOT NULL CHECK (typeof(last_seen_at) = 'integer'),
  unsubscribed_at integer CHECK (unsubscribed_at IS NULL OR typeof(unsubscribed_at) = 'integer'),
  last_digest_sent_at integer CHECK (last_digest_sent_at IS NULL OR typeof(last_digest_sent_at) = 'integer'),
  UNIQUE (link_id, guest_id)
);
--> statement-breakpoint
CREATE TABLE guest_unsubscribe_tokens (
  token_hash text PRIMARY KEY NOT NULL,
  member_id text NOT NULL REFERENCES guest_link_members(id) ON DELETE CASCADE,
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer')
);
--> statement-breakpoint
CREATE INDEX guest_unsubscribe_tokens_created_idx ON guest_unsubscribe_tokens (created_at);
--> statement-breakpoint
CREATE TABLE video_approval_events (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  link_id text REFERENCES client_links(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  decision text NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  actor_guest_id text REFERENCES guest_reviewers(id),
  actor_user_id text REFERENCES user(id),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  CHECK ((actor_guest_id IS NULL) <> (actor_user_id IS NULL)),
  CHECK (actor_guest_id IS NULL OR link_id IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX video_approval_events_asset_revision_unique ON video_approval_events (asset_id, revision);
--> statement-breakpoint
CREATE INDEX video_approval_events_video_idx ON video_approval_events (video_id);
--> statement-breakpoint
CREATE TABLE video_releases (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  approval_event_id text NOT NULL REFERENCES video_approval_events(id) ON DELETE CASCADE,
  approval_revision integer NOT NULL CHECK (approval_revision >= 1),
  released_by text NOT NULL REFERENCES user(id),
  released_at integer NOT NULL CHECK (typeof(released_at) = 'integer'),
  withdrawn_at integer CHECK (withdrawn_at IS NULL OR typeof(withdrawn_at) = 'integer'),
  withdrawn_by text REFERENCES user(id),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX video_releases_live_unique ON video_releases (asset_id) WHERE withdrawn_at IS NULL;
--> statement-breakpoint
CREATE INDEX video_releases_video_idx ON video_releases (video_id);
--> statement-breakpoint
CREATE TABLE video_premium_unlocks (
  video_id text PRIMARY KEY NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  unlocked_by text NOT NULL REFERENCES user(id),
  unlocked_at integer NOT NULL CHECK (typeof(unlocked_at) = 'integer'),
  payment_ref text CHECK (payment_ref IS NULL OR length(payment_ref) <= 200)
);
--> statement-breakpoint
CREATE INDEX video_premium_unlocks_project_idx ON video_premium_unlocks (project_id);
--> statement-breakpoint
CREATE TABLE guest_notification_digest (
  id text PRIMARY KEY NOT NULL,
  guest_id text NOT NULL REFERENCES guest_reviewers(id) ON DELETE CASCADE,
  link_id text NOT NULL REFERENCES client_links(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('video_added', 'version_granted', 'public_note', 'staff_reply', 'video_released')),
  video_id text NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  asset_id text REFERENCES assets(id) ON DELETE CASCADE,
  note_id text REFERENCES video_notes(id) ON DELETE CASCADE,
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  sent_at integer CHECK (sent_at IS NULL OR typeof(sent_at) = 'integer')
);
--> statement-breakpoint
CREATE INDEX guest_notification_digest_pending_guest_link_idx ON guest_notification_digest (guest_id, link_id) WHERE sent_at IS NULL;
--> statement-breakpoint
CREATE INDEX guest_notification_digest_pending_created_idx ON guest_notification_digest (created_at) WHERE sent_at IS NULL;
