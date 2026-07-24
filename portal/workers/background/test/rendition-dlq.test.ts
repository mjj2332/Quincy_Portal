import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import QuincyBackground from "../src";

declare const __PORTAL_MIGRATION_SQL__: string;

const database = env as unknown as { DB: D1Database };

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
});

function service() {
  return new QuincyBackground({} as ExecutionContext, { DB: database.DB } as never);
}

async function openEvents(assetId: string) {
  return database.DB.prepare("SELECT status FROM rendition_dlq_events WHERE asset_id = ?")
    .bind(assetId)
    .all<{ status: string }>();
}

describe("rendition dead-letter queue consumer", () => {
  it("records an open backlog row and acks a message that exhausted its retries", async () => {
    const assetId = crypto.randomUUID();
    const ack = vi.fn();
    const retry = vi.fn();

    await service().queue({
      queue: "quincy-renditions-dlq",
      messages: [{ body: { type: "generate_renditions", assetId }, ack, retry }],
    } as never);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    const rows = await openEvents(assetId);
    expect(rows.results).toEqual([{ status: "open" }]);
  });

  it("still records and acks an unrecognized DLQ body, rather than dropping it silently", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ack = vi.fn();
    const retry = vi.fn();

    try {
      await service().queue({
        queue: "quincy-renditions-dlq",
        messages: [{ body: { type: "generate_renditions" }, ack, retry }],
      } as never);

      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("Rendition DLQ message has an unrecognized body", { queue: "quincy-renditions-dlq", assetId: "unparseable-dlq-body" });
      const rows = await openEvents("unparseable-dlq-body");
      expect(rows.results.length).toBeGreaterThan(0);
      expect(rows.results[0]).toEqual({ status: "open" });
    } finally {
      error.mockRestore();
    }
  });
});
