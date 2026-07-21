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

function createWebhookEventsDatabase(options: { failInsert?: boolean; failReceiptUpdate?: boolean } = {}) {
  const rows = new Map<string, StoredWebhookEvent>();
  let receiptUpdates = 0;
  const receiptBindings: unknown[][] = [];
  let receiptUpdateQuery = "";
  const database = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (query.startsWith("UPDATE integration_connections")) {
            if (options.failReceiptUpdate) throw new Error("receipt update failed");
            receiptUpdates += 1;
            receiptBindings.push(values);
            receiptUpdateQuery = query;
            return { meta: { changes: 1 } };
          }
          if (options.failInsert) throw new Error("storage failed");
          const [id, source, eventId, payloadJson, status, receivedAt] = values as [string, string, string, string, string, number];
          const dedupeKey = `${source}:${eventId}`;
          if (rows.has(dedupeKey)) return { meta: { changes: 0 } };
          rows.set(dedupeKey, { id, source, eventId, payloadJson, status, receivedAt });
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;

  return { database, rows, receiptUpdates: () => receiptUpdates, receiptBindings: () => receiptBindings, receiptUpdateQuery: () => receiptUpdateQuery };
}

const baseEnv = {
  APP_ENV: "production",
  DB: {} as D1Database,
  BACKGROUND: {} as Fetcher,
};

const tonomoBody = JSON.stringify([{ id: "tonomo-order-123", orderNo: "000123", order_name: "Tonomo test order" }]);

function tonomoEnv(database: D1Database, processTonomoEvents = async () => {}) {
  return { ...baseEnv, DB: database, BACKGROUND: { processTonomoEvents } as Fetcher, TONOMO_WEBHOOK_TOKEN: "test-tonomo-token" };
}

function request(url: string, init: RequestInit, env: typeof baseEnv & { TONOMO_WEBHOOK_TOKEN?: string }) {
  return worker.request(url, init, env, { waitUntil: (promise) => { void promise; } } as ExecutionContext);
}

async function dropboxSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dropboxEnv(database: D1Database, handleDropboxWebhook = async () => {}) {
  return { ...baseEnv, DB: database, DROPBOX_APP_SECRET: "test-dropbox-secret", BACKGROUND: { handleDropboxWebhook } as Fetcher };
}

describe("webhook ingress", () => {
  it("reports health", async () => {
    const response = await request("https://webhook.test/health", {}, baseEnv);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "quincy-webhook-ingress" });
  });

  it("echoes the Dropbox verification challenge without a secret", async () => {
    const response = await request("https://webhook.test/webhooks/dropbox?challenge=quincy-test", {}, baseEnv);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("quincy-test");
  });

  it("fails closed when Dropbox posts before its secret is configured", async () => {
    const response = await request("https://webhook.test/webhooks/dropbox", { method: "POST", body: "{}" }, baseEnv);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Dropbox webhook is not configured");
  });

  it("stores a valid Dropbox delivery, records its receipt, and wakes processing", async () => {
    const { database, rows, receiptUpdates, receiptBindings, receiptUpdateQuery } = createWebhookEventsDatabase();
    const body = JSON.stringify({ list_folder: { accounts: ["dbid:one"] } });
    let wakes = 0;
    const response = await request("https://webhook.test/webhooks/dropbox", {
      method: "POST", body, headers: { "X-Dropbox-Signature": await dropboxSignature("test-dropbox-secret", body) },
    }, dropboxEnv(database, async () => { wakes += 1; }));

    expect(response.status).toBe(200);
    expect(rows.size).toBe(1);
    expect(receiptUpdates()).toBe(1);
    const stored = [...rows.values()][0]!;
    expect(receiptBindings()[0]).toEqual([stored.receivedAt, stored.receivedAt, stored.receivedAt, stored.receivedAt, "dropbox", "connected", "error"]);
    expect(receiptUpdateQuery()).toContain("status IN (?, ?)");
    expect(receiptUpdateQuery()).toContain("last_event_at < ?");
    expect(wakes).toBe(1);
  });

  it("rejects an invalid Dropbox signature without storing or waking", async () => {
    const { database, rows, receiptUpdates } = createWebhookEventsDatabase();
    let wakes = 0;
    const response = await request("https://webhook.test/webhooks/dropbox", {
      method: "POST", body: "{}", headers: { "X-Dropbox-Signature": "00" },
    }, dropboxEnv(database, async () => { wakes += 1; }));

    expect(response.status).toBe(401);
    expect(rows.size).toBe(0);
    expect(receiptUpdates()).toBe(0);
    expect(wakes).toBe(0);
  });

  it("wakes processing for a duplicate Dropbox delivery to rescue a stranded row", async () => {
    const { database, rows, receiptUpdates } = createWebhookEventsDatabase();
    const body = "{}";
    const headers = { "X-Dropbox-Signature": await dropboxSignature("test-dropbox-secret", body) };
    let wakes = 0;
    const env = dropboxEnv(database, async () => { wakes += 1; });
    await expect(request("https://webhook.test/webhooks/dropbox", { method: "POST", body, headers }, env)).resolves.toHaveProperty("status", 200);
    await expect(request("https://webhook.test/webhooks/dropbox", { method: "POST", body, headers }, env)).resolves.toHaveProperty("status", 200);
    expect(rows.size).toBe(1);
    expect(receiptUpdates()).toBe(2);
    expect(wakes).toBe(2);
  });

  it("returns non-2xx when Dropbox persistence fails", async () => {
    const { database } = createWebhookEventsDatabase({ failInsert: true });
    const body = "{}";
    const response = await request("https://webhook.test/webhooks/dropbox", {
      method: "POST", body, headers: { "X-Dropbox-Signature": await dropboxSignature("test-dropbox-secret", body) },
    }, dropboxEnv(database));
    expect(response.status).toBe(503);
  });

  it("returns non-2xx when the synchronous Dropbox handoff fails", async () => {
    const { database, rows } = createWebhookEventsDatabase();
    const body = "{}";
    const response = await request("https://webhook.test/webhooks/dropbox", {
      method: "POST", body, headers: { "X-Dropbox-Signature": await dropboxSignature("test-dropbox-secret", body) },
    }, dropboxEnv(database, async () => { throw new Error("background unavailable"); }));
    expect(response.status).toBe(503);
    expect(rows.size).toBe(1);
  });

  it("stores a valid Tonomo array payload as a received webhook event", async () => {
    const { database, rows } = createWebhookEventsDatabase();
    const response = await request(
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

  it("deduplicates an identical Tonomo redelivery and wakes the processor", async () => {
    const { database, rows } = createWebhookEventsDatabase();
    const url = "https://webhook.test/webhooks/tonomo?token=test-tonomo-token&event=order.updated";
    let calls = 0;
    const env = tonomoEnv(database, async () => { calls += 1; });

    const first = await request(url, { method: "POST", body: tonomoBody }, env);
    const second = await request(url, { method: "POST", body: tonomoBody }, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rows.size).toBe(1);
    expect(calls).toBe(2);
  });

  it("starts background processing after storing a new Tonomo event", async () => {
    const { database } = createWebhookEventsDatabase();
    let calls = 0;
    const response = await request(
      "https://webhook.test/webhooks/tonomo?token=test-tonomo-token",
      { method: "POST", body: tonomoBody },
      tonomoEnv(database, async () => { calls += 1; }),
    );

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("rejects a Tonomo request with a bad token without storing it", async () => {
    const { database, rows } = createWebhookEventsDatabase();
    const response = await request(
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
    const response = await request(
      "https://webhook.test/webhooks/tonomo?token=test-tonomo-token",
      { method: "POST", body: "not-json" },
      tonomoEnv(database),
    );

    expect(response.status).toBe(400);
    expect(rows.size).toBe(0);
  });
});
