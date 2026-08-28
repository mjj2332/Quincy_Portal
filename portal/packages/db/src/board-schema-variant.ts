/**
 * The rollback table is the migration breakpoint marker. This query is deliberately raw and
 * references only objects that exist before 0037.
 *
 * Only the terminal `tb5a_0037` result is cached per D1 binding: the rollback table is a permanent
 * table, so once present it never disappears, and an isolate that first sees `tb5a_0037` will
 * always see it. A `pre_0037` result is NOT cached — it is re-checked on the next call with the
 * same cheap `sqlite_master` lookup — so an isolate that started during the maintenance window
 * flips to `tb5a_0037` as soon as the migration lands, and test files that share this module but
 * isolate their own D1 storage each resolve against their own schema.
 */
export type BoardSchemaVariant = "pre_0037" | "tb5a_0037";

export const BOARD_SCHEMA_MARKER_SQL = `SELECT EXISTS (
  SELECT 1
  FROM sqlite_master
  WHERE type = 'table'
    AND name = 'project_board_order_0037_rollback'
) AS tb5a_0037_exists;`;

export const BOARD_CONTRACT_FLAG = "tb5a_board_contract_enabled";

const variantByDatabase = new WeakMap<D1Database, Promise<BoardSchemaVariant>>();

export function boardSchemaVariant(database: D1Database): Promise<BoardSchemaVariant> {
  const cached = variantByDatabase.get(database);
  if (cached) return cached;

  const pending = database.prepare(BOARD_SCHEMA_MARKER_SQL).first<{ tb5a_0037_exists: number | boolean }>()
    .then((row): BoardSchemaVariant => (row?.tb5a_0037_exists === 1 || row?.tb5a_0037_exists === true ? "tb5a_0037" : "pre_0037"))
    .then((variant) => {
      // Cache only the terminal state; keep re-checking while pre_0037 (see the type doc).
      if (variant !== "tb5a_0037") variantByDatabase.delete(database);
      return variant;
    });
  variantByDatabase.set(database, pending);
  return pending;
}

export async function boardContractEnabled(database: D1Database, variant: BoardSchemaVariant): Promise<boolean> {
  if (variant === "pre_0037") return false;
  const row = await database.prepare(
    "SELECT enabled FROM feature_flags WHERE key = ?",
  ).bind(BOARD_CONTRACT_FLAG).first<{ enabled: number | boolean }>();
  return row?.enabled === 1 || row?.enabled === true;
}

