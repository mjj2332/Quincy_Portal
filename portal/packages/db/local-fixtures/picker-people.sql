-- LOCAL-ONLY QA fixture for the picker polish pass (#550). NEVER apply to a remote/production D1.
-- Apply:  npm run fixtures:picker-people:apply   (wrangler d1 execute ... --local; see docs/Guides/Local-QA-Fixtures.md)
-- Remove: picker-people-remove.sql, by the fixed `550a0000-` UUIDs below.
--
-- CAPABILITY FENCE: every statement is conditional on `__quincy_local_capability`, the table
-- `setup-local.mjs` creates only in a local D1 (the same fence qa-seed uses). Against a database without it
-- (production) each statement dies with `no such table: __quincy_local_capability`; with the table
-- present but the row missing it inserts nothing.
--
-- Two people share the full name "Jordan Lee" (different emails) and two share a long name, so the Team
-- chips show the collision label (name + email) and the long one wraps. One throwaway Project holds all five.
-- Idempotent (INSERT OR IGNORE). One row per statement: local D1 caps compound SELECTs at 5 terms.
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT '550a0000-0000-4000-8000-000000000001', 'Jordan Lee', 'jordan.lee.photography@qa550.test', 0, 'photographer', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT '550a0000-0000-4000-8000-000000000002', 'Jordan Lee', 'jordan.lee.editing@qa550.test', 0, 'editor', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT '550a0000-0000-4000-8000-000000000003', 'Alexandria Montgomery-Featherstonehaugh', 'alexandria.montgomery.featherstonehaugh.photography@qa550.test', 0, 'photographer', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT '550a0000-0000-4000-8000-000000000004', 'Alexandria Montgomery-Featherstonehaugh', 'alexandria.montgomery.featherstonehaugh.editing@qa550.test', 0, 'editor', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at)
SELECT '550a0000-0000-4000-8000-000000000005', 'Sam Rivera', 'sam.rivera@qa550.test', 0, 'photographer', 1, unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO projects (id, street, suburb, postcode, stage_key, created_at, updated_at)
SELECT '550a0000-0000-4000-8000-000000000010', '550 Picker Polish Street', 'Testville', '2000', 'awaiting_raw', unixepoch() * 1000, unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT '550a0000-0000-4000-8000-000000000021', '550a0000-0000-4000-8000-000000000010', '550a0000-0000-4000-8000-000000000001', 'photographer', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT '550a0000-0000-4000-8000-000000000022', '550a0000-0000-4000-8000-000000000010', '550a0000-0000-4000-8000-000000000002', 'editor', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT '550a0000-0000-4000-8000-000000000023', '550a0000-0000-4000-8000-000000000010', '550a0000-0000-4000-8000-000000000003', 'photographer', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT '550a0000-0000-4000-8000-000000000024', '550a0000-0000-4000-8000-000000000010', '550a0000-0000-4000-8000-000000000004', 'editor', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
INSERT OR IGNORE INTO project_members (id, project_id, user_id, role_on_project, created_at)
SELECT '550a0000-0000-4000-8000-000000000025', '550a0000-0000-4000-8000-000000000010', '550a0000-0000-4000-8000-000000000005', 'photographer', unixepoch() * 1000
WHERE EXISTS (SELECT 1 FROM __quincy_local_capability WHERE capability = 'scheduling-fixtures');
