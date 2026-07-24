-- Wave 3 read-only D1 inspection. Run with `wrangler d1 execute ... --remote --file=...`
-- separately against production and staging before applying 0013 or enabling writers.
SELECT * FROM d1_migrations ORDER BY id;

SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index')
ORDER BY type, name;

-- Existing RAW duplicates must be remediated before identity backfill.
SELECT a.collection_id, a.content_hash, count(*) AS duplicate_count,
       group_concat(a.id) AS asset_ids
FROM assets a
JOIN collections c ON c.id = a.collection_id
WHERE c.kind = 'raw' AND a.content_hash IS NOT NULL
GROUP BY a.collection_id, a.content_hash
HAVING count(*) > 1;

-- These rows remain quarantined from automatic source-key versioning until reconciled.
SELECT a.id, a.collection_id, a.original_filename, a.content_hash, a.source_path
FROM assets a
JOIN collections c ON c.id = a.collection_id
WHERE c.kind = 'edited' AND a.source = 'dropbox'
  AND (a.source_path IS NULL OR trim(a.source_path) = '')
ORDER BY a.collection_id, a.original_filename, a.id;

-- Before the claim table exists, this is the legacy equivalent of an AutoHDR source-key
-- collision report. Do not collapse these rows automatically.
SELECT a.collection_id,
       lower(rtrim(replace(a.source_path, char(92), '/'), '/')) AS prospective_path_key,
       count(*) AS duplicate_count,
       group_concat(a.id) AS asset_ids
FROM assets a
JOIN collections c ON c.id = a.collection_id
WHERE c.kind = 'edited' AND a.source = 'dropbox'
  AND a.source_path IS NOT NULL
  AND lower(replace(a.source_path, char(92), '/')) LIKE '/autohdr/%'
GROUP BY a.collection_id, prospective_path_key
HAVING count(*) > 1;
