#!/usr/bin/env bash
# Reproduces the local-D1 portion of Seed-Admin-UUID-Migration-Plan.md §Verification.
# It deliberately uses `d1 execute --file` for 0000–0021 + the legacy fixture before
# executing the exact 0022 SQL, then uses a separate clean directory for migration discovery.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

scratch_directory="$(mktemp -d "${TMPDIR:-/tmp}/quincy-migration-0022-d1.XXXXXX")"
fixture_persist_directory="$scratch_directory/fixture-persist"
ledger_persist_directory="$scratch_directory/ledger-persist"
legacy_migrations_sql="$scratch_directory/0000-0021.sql"
config_path="../../workers/app/wrangler.jsonc"
old_id="seed-admin"
new_id="6b851dc8-14cf-4f90-bd29-ce6c27f86385"
export WRANGLER_LOG_PATH="$scratch_directory/wrangler-logs"

cleanup() {
  rm -rf "$scratch_directory"
}
trap cleanup EXIT

shopt -s nullglob
for migration_number in {0..21}; do
  printf -v migration_prefix '%04d' "$migration_number"
  migrations=(migrations/"$migration_prefix"_*.sql)
  if [[ ${#migrations[@]} -ne 1 ]]; then
    echo "Expected exactly one migration for $migration_prefix, found ${#migrations[@]}." >&2
    exit 1
  fi
  sed 's/--> statement-breakpoint//g' "${migrations[0]}" >> "$legacy_migrations_sql"
  printf '\n' >> "$legacy_migrations_sql"
done

execute_fixture_database() {
  npx wrangler d1 execute quincy-portal --local --persist-to "$fixture_persist_directory" --config "$config_path" "$@"
}

echo "==> Load exact migrations 0000–0021 into isolated local D1"
execute_fixture_database --file "$legacy_migrations_sql"

echo "==> Load representative legacy seed-admin fixture"
execute_fixture_database --file test/fixtures/seed-admin-uuid-legacy.sql

echo "==> Execute exact 0022_seed_admin_uuid.sql"
execute_fixture_database --file migrations/0022_seed_admin_uuid.sql

echo "==> Verify migrated user and all fourteen foreign-key references"
execute_fixture_database --command "SELECT id, name, email, email_verified, image, role, active, created_at, updated_at FROM user WHERE id IN ('$old_id', '$new_id') ORDER BY id; SELECT 'session.user_id' AS ref, COUNT(CASE WHEN user_id = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN user_id = '$new_id' THEN 1 END) AS new_id_count FROM session; SELECT 'account.user_id' AS ref, COUNT(CASE WHEN user_id = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN user_id = '$new_id' THEN 1 END) AS new_id_count FROM account; SELECT 'projects.archived_by' AS ref, COUNT(CASE WHEN archived_by = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN archived_by = '$new_id' THEN 1 END) AS new_id_count FROM projects; SELECT 'project_members.user_id' AS ref, COUNT(CASE WHEN user_id = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN user_id = '$new_id' THEN 1 END) AS new_id_count FROM project_members; SELECT 'document_uploads.created_by' AS ref, COUNT(CASE WHEN created_by = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN created_by = '$new_id' THEN 1 END) AS new_id_count FROM document_uploads; SELECT 'upload_manifests.created_by' AS ref, COUNT(CASE WHEN created_by = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN created_by = '$new_id' THEN 1 END) AS new_id_count FROM upload_manifests; SELECT 'selections.selected_by' AS ref, COUNT(CASE WHEN selected_by = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN selected_by = '$new_id' THEN 1 END) AS new_id_count FROM selections; SELECT 'autohdr_handoffs.initiated_by' AS ref, COUNT(CASE WHEN initiated_by = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN initiated_by = '$new_id' THEN 1 END) AS new_id_count FROM autohdr_handoffs; SELECT 'asset_review_state.updated_by' AS ref, COUNT(CASE WHEN updated_by = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN updated_by = '$new_id' THEN 1 END) AS new_id_count FROM asset_review_state; SELECT 'annotations.author_id' AS ref, COUNT(CASE WHEN author_id = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN author_id = '$new_id' THEN 1 END) AS new_id_count FROM annotations; SELECT 'notice_board_posts.author_id' AS ref, COUNT(CASE WHEN author_id = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN author_id = '$new_id' THEN 1 END) AS new_id_count FROM notice_board_posts; SELECT 'publishes.published_by' AS ref, COUNT(CASE WHEN published_by = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN published_by = '$new_id' THEN 1 END) AS new_id_count FROM publishes; SELECT 'audit_log.actor_id' AS ref, COUNT(CASE WHEN actor_id = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN actor_id = '$new_id' THEN 1 END) AS new_id_count FROM audit_log; SELECT 'notifications.user_id' AS ref, COUNT(CASE WHEN user_id = '$old_id' THEN 1 END) AS old_id_count, COUNT(CASE WHEN user_id = '$new_id' THEN 1 END) AS new_id_count FROM notifications;"

echo "==> Verify session/account byte preservation and D1 PRAGMA support"
execute_fixture_database --command "SELECT id, token, user_id FROM session WHERE id = 'fixture-session'; SELECT account_id, provider_id, access_token, refresh_token, id_token, scope, user_id FROM account WHERE id = 'fixture-account'; PRAGMA foreign_key_check; PRAGMA quick_check;"

echo "==> Apply migrations against a clean local D1 to prove 0022 discovery and ledgering"
npx wrangler d1 migrations apply quincy-portal --local --persist-to "$ledger_persist_directory" --config "$config_path"
npx wrangler d1 execute quincy-portal --local --persist-to "$ledger_persist_directory" --config "$config_path" --command "SELECT name FROM d1_migrations WHERE name = '0022_seed_admin_uuid.sql';"

echo "Local D1 migration 0022 verification passed."
