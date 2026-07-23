/** A collection's count is derived state. Use this in the same D1 batch as its mutation. */
export const COLLECTION_RECEIVED_COUNT_SQL = `
  UPDATE collections
  SET received_count = (SELECT count(*) FROM collection_links WHERE collection_id = ?)
                     + (SELECT count(*) FROM assets WHERE collection_id = ? AND publish_status = 'ready'),
      status = CASE WHEN (SELECT count(*) FROM collection_links WHERE collection_id = ?)
                           + (SELECT count(*) FROM assets WHERE collection_id = ? AND publish_status = 'ready') > 0
                    THEN 'received' ELSE 'empty' END,
      updated_at = ?
  WHERE id = ?
`;

export function collectionReceivedCountBindings(collectionId: string, updatedAt: number) {
  return [collectionId, collectionId, collectionId, collectionId, updatedAt, collectionId] as const;
}
