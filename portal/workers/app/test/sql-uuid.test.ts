import { describe, expect, it } from "vitest";
import { SQL_UUID_V4 } from "../src/lib/sql-uuid";
import { database } from "./embedded-media-support";

/** The SQL UUID v4 expression (#741 15b): `INSERT ... SELECT` mints one id per row, so it must differ per row and be a well-formed version 4 variant 1 UUID. */
describe("SQL_UUID_V4", () => {
  it("yields a lower-case v4 UUID with the RFC 4122 variant, distinct on every row of one statement", async () => {
    const rows = (await database.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) SELECT ${SQL_UUID_V4} AS id FROM n`).all<{ id: string }>()).results;
    expect(rows).toHaveLength(500);
    for (const { id } of rows) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(rows.map((row) => row.id)).size).toBe(500);
  });

  it("uses every variant nibble and is a single expression usable as a column value", async () => {
    const rows = (await database.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) SELECT substr(${SQL_UUID_V4}, 20, 1) AS variant FROM n`).all<{ variant: string }>()).results;
    expect(new Set(rows.map((row) => row.variant))).toEqual(new Set(["8", "9", "a", "b"]));
  });
});
