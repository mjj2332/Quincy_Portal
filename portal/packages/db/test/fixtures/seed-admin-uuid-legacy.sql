PRAGMA foreign_keys = ON;

INSERT INTO user (id, name, email, email_verified, image, role, active, created_at, updated_at)
VALUES ('seed-admin', 'Quincy Admin', 'mjj2332@gmail.com', 1, 'https://example.test/quincy.png', 'admin', 1, 1785334000000, 1785334000001);
INSERT INTO projects (id, street, stage_key, archived_by, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'Migration Fixture Lane', 'awaiting_raw', 'seed-admin', 1785334000000, 1785334000000);
INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'raw', 'received', 1, 1785334000000, 1785334000000);
INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'photo', 'projects/fixture/raw/fixture.jpg', 'fixture.jpg', 123, 'upload', 1785334000000, 1785334000000);
INSERT INTO integration_connections (id, provider, status, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000004', 'dropbox', 'connected', 1785334000000, 1785334000000);
INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000005', 'autohdr', 'done', '00000000-0000-4000-8000-000000000001', 0, 1785334000000, 1785334000000);

INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at)
VALUES ('fixture-session', 1785420400000, 'fixture-session-token', 'seed-admin', 1785334000000, 1785334000000);
INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, scope, created_at, updated_at)
VALUES ('fixture-account', 'fixture-google-subject', 'google', 'seed-admin', 'fixture-access-token', 'fixture-refresh-token', 'fixture-id-token', 'openid email', 1785334000000, 1785334000000);
INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at)
VALUES ('fixture-member', '00000000-0000-4000-8000-000000000001', 'seed-admin', 'photographer', 1785334000000);
INSERT INTO document_uploads (id, project_id, collection_id, created_by, kind, version_group_id, version, pdf_asset_id, pdf_key, pdf_filename, pdf_bytes, pdf_content_type, status, expires_at, completion_audit_id, created_at, updated_at)
VALUES ('fixture-document', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'seed-admin', 'copy_pdf', 'fixture-document-group', 1, 'fixture-document-pdf-asset', 'projects/fixture/copy/fixture.pdf', 'fixture.pdf', 321, 'application/pdf', 'pending', 1785420400000, 'fixture-document-audit', 1785334000000, 1785334000000);
INSERT INTO upload_manifests (id, collection_id, expected_count, filenames_json, created_by, created_at)
VALUES ('fixture-manifest', '00000000-0000-4000-8000-000000000002', 1, '["fixture.jpg"]', 'seed-admin', 1785334000000);
INSERT INTO selections (id, asset_id, selected_by, state, created_at)
VALUES ('fixture-selection', '00000000-0000-4000-8000-000000000003', 'seed-admin', 'selected_for_editing', 1785334000000);
INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, state, workflow_id, job_id, lease_expires_at, created_at, updated_at)
VALUES ('fixture-handoff', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 1, 1, 'fixture-selection', '["00000000-0000-4000-8000-000000000003"]', '[{"key":"asset:fixture","assetIds":["00000000-0000-4000-8000-000000000003"]}]', '/Raw/fixture', 'seed-admin', 'completed', 'fixture-workflow', '00000000-0000-4000-8000-000000000005', 1785420400000, 1785334000000, 1785334000000);
INSERT INTO asset_review_state (id, asset_id, stars, updated_by, updated_at)
VALUES ('fixture-review', '00000000-0000-4000-8000-000000000003', 5, 'seed-admin', 1785334000000);
INSERT INTO annotations (id, asset_id, author_id, author_role, scope, note_text, created_at)
VALUES ('fixture-annotation', '00000000-0000-4000-8000-000000000003', 'seed-admin', 'admin', 'raw', 'fixture note', 1785334000000);
INSERT INTO notice_board_posts (id, author_id, body, created_at)
VALUES ('fixture-notice', 'seed-admin', 'fixture notice', 1785334000000);
INSERT INTO publishes (id, project_id, asset_id, publish_version, published_by, published_at)
VALUES ('fixture-publish', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 1, 'seed-admin', 1785334000000);
INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
VALUES ('fixture-audit', 'seed-admin', 'fixture.action', 'fixture', '00000000-0000-4000-8000-000000000001', '{"unchanged":true}', 1785334000000);
INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at)
VALUES ('fixture-notification', 'seed-admin', '00000000-0000-4000-8000-000000000001', 'fixture_type', 'Fixture title', 'Fixture body', 'fixture-source', 1785334000000);
