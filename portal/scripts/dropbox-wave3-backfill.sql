-- MUTATING Wave-3 backfill. Run only after recovery point + preflight review, with all writers
-- disabled. Ambiguous/malformed rows are intentionally untouched for staff remediation.

-- Canonical AutoHDR source keys: only already-absolute, root-contained, structurally simple paths.
UPDATE assets
SET source_path_key = lower(rtrim(replace(source_path, char(92), '/'), '/')),
    updated_at = unixepoch() * 1000
WHERE source = 'dropbox'
  AND source_path_key IS NULL
  AND lower(replace(source_path, char(92), '/')) LIKE '/autohdr/%'
  AND replace(source_path, char(92), '/') NOT LIKE '%//%'
  AND replace(source_path, char(92), '/') NOT LIKE '%/../%'
  AND replace(source_path, char(92), '/') NOT LIKE '%/./%';

-- Reserve only clean one-row edited identities with a trusted content hash.
INSERT INTO edited_source_claims
  (id, collection_id, source_path_key, current_asset_id, content_hash, created_at, updated_at)
SELECT lower(hex(randomblob(16))), a.collection_id, a.source_path_key, a.id, a.content_hash,
       unixepoch() * 1000, unixepoch() * 1000
FROM assets a
JOIN collections c ON c.id = a.collection_id AND c.kind = 'edited'
WHERE a.source = 'dropbox' AND a.source_path_key IS NOT NULL
  AND a.content_hash IS NOT NULL AND a.superseded_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM assets other
    WHERE other.collection_id = a.collection_id
      AND other.source_path_key = a.source_path_key
      AND other.superseded_at IS NULL
      AND other.id <> a.id
  )
ON CONFLICT(collection_id, source_path_key) DO NOTHING;

-- Reserve clean RAW hashes. Duplicate groups from the preflight are deliberately skipped.
INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at)
SELECT lower(hex(randomblob(16))), a.collection_id, 'hash:' || lower(a.content_hash), a.id,
       unixepoch() * 1000
FROM assets a
JOIN collections c ON c.id = a.collection_id AND c.kind = 'raw'
WHERE a.content_hash IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM assets other
    WHERE other.collection_id = a.collection_id
      AND other.content_hash = a.content_hash
      AND other.id <> a.id
  )
ON CONFLICT(collection_id, identity_key) DO NOTHING;
