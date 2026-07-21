-- Quincy Portal seed (apply after migrations, all envs)
-- Pipeline stages: stable keys, admin-editable labels/order (Implementation-Plan §2 A4).
INSERT OR IGNORE INTO pipeline_stages (key, label, display_order, active) VALUES
  ('awaiting_raw',    'Awaiting RAW',      1, 1),
  ('raw_review',      'RAW review',        2, 1),
  ('editing_autohdr', 'Editing · autoHDR', 3, 1),
  ('edited_review',   'Edited review',     4, 1),
  ('delivered',       'Delivered',         5, 1);

-- Bootstrap admin (Implementation-Plan §7 item 8).
-- REPLACE the email before applying to a real environment; Google sign-in only
-- succeeds for users that exist and are active (closed system).
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
VALUES (
  'seed-admin',
  'Quincy Admin',
  'mjj2332@gmail.com',
  0,
  'admin',
  1,
  unixepoch() * 1000,
  unixepoch() * 1000
);
