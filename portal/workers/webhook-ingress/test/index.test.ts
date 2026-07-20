import { describe, expect, it } from "vitest";
import worker from "../src/index";

interface StoredWebhookEvent {
  id: string;
  source: string;
  eventId: string;
  payloadJson: string;
  status: string;
  receivedAt: number;
}

function createWebhookEventsDatabase() {
  const rows = new Map<string, StoredWebhookEvent>();
  const database = {
    prepare: () => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          const [id, source, eventId, payloadJson, status, receivedAt] = values as [string, string, string, string, string, number];
          const dedupeKey = `${source}:${eventId}`;
          if (rows.has(dedupeKey)) return { meta: { changes: 0 } };
          rows.set(dedupeKey, { id, source, eventId, payloadJson, status, receivedAt });
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;

  return { database, rows };
}

const baseEnv = {
  APP_ENV: "production",
  DB: {} as D1Database,
  BACKGROUND: {} as Fetcher,
};

const tonomoBody = JSON.stringify([{ id: "tonomo-order-123", orderNo: "000123", order_name: "Tonomo test order" }]);

function tonomoEnv(database: D1Database) {
  return { ...baseEnv, DB: database, TONOMO_WEBHOOK_TOKEN: "test-tonomo-token" };
}

describe("webhook ingress", () => {
  it("reports health", async () => {
    const response = await worker.request("https://webhook.test/health", {}, baseEnv);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "quincy-webhook-ingress" });
  });

  it("echoes the Dropbox verification challenge without a secret", async () => {
    const response = await worker.request("https://webhook.test/webhooks/dropbox?challenge=quincy-test", {}, baseEnv);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("quincy-test");
  });

  it("fails closed when Dropbox posts before its secret is configured", async () => {
    const response = await worker.request("https://webhook.test/webhooks/dropbox", { method: "POST", body: "{}" }, baseEnv);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Dropbox webhook is not configured");
  });

  it("stores a valid Tonomo array payload as a received webhook event", async () => {
    const { database, rows } = createWebhookEventsDatabase();
    const response = await worker.request(
      "https://webhook.test/webhooks/tonomo?token=test-tonomo-token",
      { method: "POST", headers: { "content-type": "application/json" }, body: tonomoBody },
      tonomoEnv(database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect([...rows.values()]).toEqual([
      expect.objectContaining({ source: "tonomo", payloadJson: tonomoBody, status: "received" }),
    ]);
  });

  it("deduplicates an identical Tonomo redelivery", async () => {
    const { database, rows } = createWebhookEventsDatabase();
    const url = "https://webhook.test/webhooks/tonomo?token=test-tonomo-token&event=order.updated";

    const first = await worker.request(url, { method: "POST", body: tonomoBody }, tonomoEnv(database));
    const second = await worker.request(url, { method: "POST", body: tonomoBody }, tonomoEnv(database));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rows.size).toBe(1);
  });

  it("rejects a Tonomo request with a bad token without storing it", async () => {
    const { database, rows } = createWebhookEventsDatabase();
    const response = await worker.request(
      "https://webhook.test/webhooks/tonomo?token=wrong-token",
      { method: "POST", body: tonomoBody },
      tonomoEnv(database),
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("unauthorized");
    expect(rows.size).toBe(0);
  });

  it("rejects invalid Tonomo JSON without storing it", async () => {
    const { database, rows } = createWebhookEventsDatabase();
    const response = await worker.request(
      "https://webhook.test/webhooks/tonomo?token=test-tonomo-token",
      { method: "POST", body: "not-json" },
      tonomoEnv(database),
    );

    expect(response.status).toBe(400);
    expect(rows.size).toBe(0);
  });
});
