/**
 * QA fixture teardown — the schema-scan guard for id columns WITHOUT a foreign key (Sol round 2).
 * The graph teardown discovers every FK edge from the live database, but a column that holds an
 * entity id with no FK (`rendition_dlq_events.asset_id`, `audit_log.target_id`, ...) is invisible to
 * introspection. Those live in `NO_FK_ID_COLUMNS`, the one hand list left. This guard makes that list
 * impossible to fall behind: every `*_id` / `*Id` column in `schema.ts` without `.references()` must
 * be either in `NO_FK_ID_COLUMNS` or in `NOT_ENTITY_REFERENCES` below, with a reason. A migration that
 * adds an unreferenced id column turns this red until someone decides which it is.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NO_FK_ID_COLUMNS } from "../qa-seed/teardown-graph";
import { freshFixtureDatabase } from "./qa-seed-sqlite-executor";

const schemaSource = readFileSync(new URL("../src/schema.ts", import.meta.url), "utf8");

/** Id-shaped columns that are NOT a reference to a row in this database — external identifiers,
 * dedupe keys, grouping keys. Each must say why. */
const NOT_ENTITY_REFERENCES: Readonly<Record<string, string>> = {
  "account.account_id": "the OAuth provider's own account id (better-auth), not a row here",
  "account.provider_id": "the OAuth provider name ('google'), not a row here",
  "projects.order_id": "Tonomo's external order id",
  "document_uploads.version_group_id": "a generated grouping key shared by every version of one document, never any row's id",
  "document_uploads.pdf_upload_id": "an R2 multipart-upload id",
  "document_uploads.preview_upload_id": "an R2 multipart-upload id",
  "assets.version_group_id": "a generated grouping key shared by every version of one asset, never any row's id",
  "autohdr_handoffs.workflow_id": "a Cloudflare Workflows instance id",
  "autohdr_fetch_claims.workflow_id": "a Cloudflare Workflows instance id",
  "autohdr_output_mappings.folder_id": "a Dropbox folder id",
  "autohdr_path_claims.folder_id": "a Dropbox folder id",
  "editor_folder_mappings.root_folder_id": "a Dropbox folder id",
  "editor_folder_mappings.editing_notes_folder_id": "a Dropbox folder id",
  "webhook_events.event_id": "the webhook provider's own event id",
  "jobs.correlation_id": "a dedupe key string such as `dropbox_sync:<projectId>` (workers/background/src/dropbox/sync.ts); jobs rows are captured via the jobs.project_id FK",
  "notifications.email_message_id": "the email provider's message id",
  "notification_delivery_ledger.email_message_id": "the email provider's message id",
  "external_edited_upload_sessions.r2_upload_id": "an R2 multipart-upload id",
};

/** `table.column` for every `*_id`-named (or `*Id`-keyed) column in a Drizzle schema source that has
 * no `.references(...)` in its own declaration. */
export function unreferencedIdColumns(source: string): string[] {
  const tableStarts = [...source.matchAll(/sqliteTable\(\s*"([a-z_0-9]+)"/g)].map((m) => ({ table: m[1]!, index: m.index! }));
  const out: string[] = [];
  tableStarts.forEach((start, i) => {
    const block = source.slice(start.index, tableStarts[i + 1]?.index ?? source.length);
    const columns = [...block.matchAll(/^\s*([A-Za-z0-9_]+):\s*(?:text|integer|real)\("([a-z0-9_]+)"/gm)].map((m) => ({ prop: m[1]!, column: m[2]!, index: m.index! }));
    columns.forEach((column, j) => {
      const declaration = block.slice(column.index, columns[j + 1]?.index ?? block.length);
      const idShaped = /_id$/.test(column.column) || /Id$/.test(column.prop);
      if (idShaped && !declaration.includes(".references(")) out.push(`${start.table}.${column.column}`);
    });
  });
  return out.sort();
}

describe("guard: every id column without a foreign key is classified", () => {
  const found = unreferencedIdColumns(schemaSource);
  const noFk = new Set(NO_FK_ID_COLUMNS.map((entry) => `${entry.table}.${entry.column}`));

  it("found a non-trivial set of unreferenced id columns (schema.ts parsing didn't silently return nothing)", () => {
    expect(found.length).toBeGreaterThan(30);
    expect(found).toContain("rendition_dlq_events.asset_id");
    expect(found).toContain("audit_log.target_id");
    expect(found).toContain("notification_outbox.project_id");
  });

  it("every unreferenced id column in schema.ts is either a no-FK teardown edge or a justified non-reference", () => {
    const unclassified = found.filter((column) => !noFk.has(column) && !(column in NOT_ENTITY_REFERENCES));
    expect(unclassified).toEqual([]);
  });

  it("no column is in both lists", () => {
    expect([...noFk].filter((column) => column in NOT_ENTITY_REFERENCES)).toEqual([]);
  });

  it("neither list carries a stale entry — every entry is a real, currently-unreferenced column in schema.ts", () => {
    expect([...noFk].filter((column) => !found.includes(column))).toEqual([]);
    expect(Object.keys(NOT_ENTITY_REFERENCES).filter((column) => !found.includes(column))).toEqual([]);
  });

  it("every no-FK entry is also FK-less in the MIGRATED schema (schema.ts and the migrations can diverge)", () => {
    const db = freshFixtureDatabase();
    for (const entry of NO_FK_ID_COLUMNS) {
      const columns = db.prepare(`SELECT name FROM pragma_table_info('${entry.table}');`).all().map((row) => row.name);
      expect(columns, `${entry.table}.${entry.column} exists in the migrated schema`).toContain(entry.column);
      const fks = db.prepare(`SELECT "from" AS column FROM pragma_foreign_key_list('${entry.table}');`).all().map((row) => row.column);
      expect(fks, `${entry.table}.${entry.column} has no FK in the migrated schema`).not.toContain(entry.column);
    }
    db.close();
  });

  it("the scanner fires on a new unreferenced id column, and not on a referenced one — this guard cannot pass vacuously", () => {
    const synthetic = `
export const widgets = sqliteTable("widgets", {
  id: id(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  gadgetId: text("gadget_id"),
  ownerRef: text("owner_ref"),
});`;
    expect(unreferencedIdColumns(synthetic)).toEqual(["widgets.gadget_id"]);
    const unclassified = unreferencedIdColumns(schemaSource + synthetic).filter((column) => !noFk.has(column) && !(column in NOT_ENTITY_REFERENCES));
    expect(unclassified).toEqual(["widgets.gadget_id"]);
  });
});
