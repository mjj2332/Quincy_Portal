ALTER TABLE collection_links ADD COLUMN position integer NOT NULL DEFAULT 0;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY created_at, id) AS row_number
  FROM collection_links
)
UPDATE collection_links
SET position = (SELECT row_number * 1024 FROM ranked WHERE ranked.id = collection_links.id);
--> statement-breakpoint
CREATE INDEX collection_links_collection_position_idx ON collection_links (collection_id, position, id);
