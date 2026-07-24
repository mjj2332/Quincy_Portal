-- Run after nullable expansion/backfill and collision remediation. Every query must return zero.
SELECT count(*) AS duplicate_permanent_path_claims
FROM (
  SELECT connection_id, path_key
  FROM autohdr_path_claims
  GROUP BY connection_id, path_key
  HAVING count(*) > 1
);

SELECT count(*) AS duplicate_current_edited_sources
FROM (
  SELECT collection_id, source_path_key
  FROM assets
  WHERE source = 'dropbox' AND source_path_key IS NOT NULL AND superseded_at IS NULL
  GROUP BY collection_id, source_path_key
  HAVING count(*) > 1
);

SELECT count(*) AS legacy_edited_rows_without_source_key
FROM assets a
JOIN collections c ON c.id = a.collection_id
WHERE c.kind = 'edited' AND a.source = 'dropbox' AND a.source_path_key IS NULL;

SELECT count(*) AS blocked_mappings
FROM autohdr_output_mappings
WHERE state = 'blocked_collision';

SELECT count(*) AS unowned_active_source_rows
FROM assets a
JOIN collections c ON c.id = a.collection_id AND c.kind = 'edited'
LEFT JOIN edited_source_claims s
  ON s.collection_id = a.collection_id
 AND s.source_path_key = a.source_path_key
 AND s.current_asset_id = a.id
WHERE a.source = 'dropbox' AND a.source_path_key IS NOT NULL
  AND a.superseded_at IS NULL AND s.id IS NULL;
