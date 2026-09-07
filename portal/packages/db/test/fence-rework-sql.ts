import { readFileSync } from "node:fs";

/**
 * Extracts the fenced ```sql blocks from the fence-rework normative SQL fixture.
 *
 * The fixture (test/fixtures/fence-rework-normative-sql.md) is a byte-for-byte copy of the
 * ```sql fences that used to live in docs/plans/implemented/tb5a/fence-rework-sol-design.md,
 * a planning doc deleted in commit 0dbeca7. Moving the fixture beside the tests (see #58)
 * removes the fragile ../../../../docs/... dependency on a doc that was never meant to be a
 * durable test dependency.
 *
 * Shared by stage-board-bundles.test.ts and tb5a-migration-proof.test.ts, both of which pin
 * NORMATIVE_*_SQL constants against these blocks.
 */
export function fenceReworkSqlBlocks(): string[] {
  const fixture = readFileSync(new URL("fixtures/fence-rework-normative-sql.md", import.meta.url), "utf8");
  return [...fixture.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]!);
}
