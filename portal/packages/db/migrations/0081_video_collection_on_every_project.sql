-- Video is a Collection on every Project, like Raw (always-on video). Staff can upload video and add video links
-- whether or not the Video service was ordered, so every Project needs a video Collection row to hold them.
-- Data only: one INSERT ... SELECT, no ALTER, no rebuild, no PRAGMA, no trigger. Archived Projects are included
-- so a restored Project is not missing it. A Project that already has a video Collection is skipped by the
-- NOT EXISTS and by collections_project_kind (project_id, kind) with ON CONFLICT DO NOTHING, so a re-run adds nothing.
-- Each row needs its own id, so SQL mints a UUIDv4 per row (the 0053 idiom) rather than one shared value.
-- Created and updated stamp the apply time. No audit row is written per Project (structural, as at project create).
INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  p.id, 'video', 'empty', 0,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM collections c WHERE c.project_id = p.id AND c.kind = 'video')
ON CONFLICT(project_id, kind) DO NOTHING;
