INSERT INTO user (id, name, email, email_verified, image, role, active, created_at, updated_at)
SELECT '6b851dc8-14cf-4f90-bd29-ce6c27f86385', name,
       'seed-admin-legacy-6b851dc8@invalid', email_verified, image, role, active,
       created_at, updated_at
FROM user
WHERE id = 'seed-admin';

UPDATE session            SET user_id      = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id      = 'seed-admin';
UPDATE account            SET user_id      = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id      = 'seed-admin';
UPDATE projects           SET archived_by  = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE archived_by  = 'seed-admin';
UPDATE project_members    SET user_id      = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id      = 'seed-admin';
UPDATE document_uploads   SET created_by   = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE created_by   = 'seed-admin';
UPDATE upload_manifests   SET created_by   = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE created_by   = 'seed-admin';
UPDATE selections         SET selected_by  = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE selected_by  = 'seed-admin';
UPDATE autohdr_handoffs   SET initiated_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE initiated_by = 'seed-admin';
UPDATE asset_review_state SET updated_by    = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE updated_by    = 'seed-admin';
UPDATE annotations        SET author_id    = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE author_id    = 'seed-admin';
UPDATE notice_board_posts SET author_id    = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE author_id    = 'seed-admin';
UPDATE publishes          SET published_by = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE published_by = 'seed-admin';
UPDATE audit_log          SET actor_id     = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE actor_id     = 'seed-admin';
UPDATE notifications      SET user_id      = '6b851dc8-14cf-4f90-bd29-ce6c27f86385' WHERE user_id      = 'seed-admin';

DELETE FROM user WHERE id = 'seed-admin';

UPDATE user
SET email = 'mjj2332@gmail.com'
WHERE id = '6b851dc8-14cf-4f90-bd29-ce6c27f86385';
