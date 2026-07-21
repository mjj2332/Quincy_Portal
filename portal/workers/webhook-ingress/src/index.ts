import { Hono } from "hono";

import type { Env } from "./env";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const maxTonomoBodyBytes = 1_024 * 1_024;
const tonomoEvents = new Set(["order.created", "order.updated"]);

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = value.slice(index * 2, index * 2 + 2);
    bytes[index] = Number.parseInt(pair, 16);
  }
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function hmacSha256(secret: string, rawBody: ArrayBuffer): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
}

async function sha256(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function sha256Bytes(value: ArrayBuffer): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

async function readBodyWithinLimit(request: Request, limit: number): Promise<ArrayBuffer | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit) return null;

  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function firstOrderKey(payload: unknown): string | undefined {
  const firstOrder = Array.isArray(payload) ? payload[0] : payload;
  if (!firstOrder || typeof firstOrder !== "object" || Array.isArray(firstOrder)) return undefined;
  const order = firstOrder as Record<string, unknown>;
  const key = order.id ?? order.orderNo;
  return typeof key === "string" || typeof key === "number" ? String(key) : undefined;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (context) => context.json({ ok: true, service: "quincy-webhook-ingress" }));

app.get("/webhooks/dropbox", (context) => {
  const challenge = context.req.query("challenge");
  return new Response(challenge ?? "", { headers: { "content-type": "text/plain; charset=utf-8" } });
});

app.post("/webhooks/dropbox", async (context) => {
  if (!context.env.DROPBOX_APP_SECRET) {
    return context.text("Dropbox webhook is not configured", 503);
  }
  const signature = context.req.header("X-Dropbox-Signature");
  const suppliedSignature = signature ? fromHex(signature) : null;
  const rawBody = await context.req.raw.arrayBuffer();
  const expectedSignature = await hmacSha256(context.env.DROPBOX_APP_SECRET, rawBody);
  if (!suppliedSignature || !constantTimeEqual(suppliedSignature, expectedSignature)) {
    return context.text("Invalid Dropbox signature", 401);
  }

  const timestamp = context.req.header("X-Dropbox-Request-Timestamp") ?? "";
  const eventId = await sha256(`${signature}:${timestamp}`);
  const payloadJson = new TextDecoder().decode(rawBody);
  // One receipt instant belongs to both durable observations. It must be captured before
  // either write so concurrent deliveries can never move a connection backwards in time.
  const receivedAt = Date.now();
  try {
    await context.env.DB.prepare(
      "INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, event_id) DO NOTHING",
    )
      .bind(crypto.randomUUID(), "dropbox", eventId, payloadJson, "received", receivedAt)
      .run();
    // Wake on both new and duplicate events. A prior wake can have been interrupted after
    // storage, and a redelivery is our at-least-once stranded-row rescue.
    let handoffError: unknown;
    try {
      await context.env.BACKGROUND.handleDropboxWebhook();
    } catch (error) {
      handoffError = error;
    }
    // A receipt timestamp is deliberately separate from sync health: it means that a
    // valid Dropbox delivery was verified and durably recorded (or was already present).
    // Dropbox sends account-level notifications, so every configured Dropbox connection
    // has observed the receipt.
    await context.env.DB.prepare(
      "UPDATE integration_connections SET last_event_at = CASE WHEN last_event_at IS NULL OR last_event_at < ? THEN ? ELSE last_event_at END, updated_at = CASE WHEN last_event_at IS NULL OR last_event_at < ? THEN ? ELSE updated_at END WHERE provider = ? AND status IN (?, ?)",
    ).bind(receivedAt, receivedAt, receivedAt, receivedAt, "dropbox", "connected", "error").run();
    if (handoffError) throw handoffError;
  } catch (error) {
    // Dropbox retries only on non-2xx. Never acknowledge an event whose durable storage,
    // receipt bookkeeping, or synchronous background handoff did not complete.
    console.error("Dropbox webhook persistence or handoff failed", error);
    return context.text("Dropbox webhook processing failed", 503);
  }
  return context.text("ok");
});

app.get("/webhooks/tonomo", (context) => context.text("Method not allowed", 405, { Allow: "POST" }));

app.post("/webhooks/tonomo", async (context) => {
  const token = context.req.query("token");
  const expectedToken = context.env.TONOMO_WEBHOOK_TOKEN;
  if (!expectedToken) return context.text("Tonomo webhook is not configured", 503);
  if (!constantTimeEqual(encoder.encode(token ?? ""), encoder.encode(expectedToken))) {
    return context.text("unauthorized", 401);
  }

  const event = context.req.query("event") ?? "order.created";
  if (!tonomoEvents.has(event)) return context.text("Invalid Tonomo event", 400);

  const rawBody = await readBodyWithinLimit(context.req.raw, maxTonomoBodyBytes);
  if (!rawBody) return context.text("Payload too large", 413);

  let payloadJson: string;
  let payload: unknown;
  try {
    payloadJson = decoder.decode(rawBody);
    payload = JSON.parse(payloadJson);
  } catch {
    return context.text("Invalid JSON", 400);
  }
  if (!payload || typeof payload !== "object") return context.text("Invalid JSON", 400);

  const bodyHash = await sha256Bytes(rawBody);
  const stableOrderKey = firstOrderKey(payload) ?? bodyHash;
  const eventId = await sha256(`${event}:${stableOrderKey}:${bodyHash}`);
  try {
    await context.env.DB.prepare(
      "INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, event_id) DO NOTHING",
    )
      .bind(crypto.randomUUID(), "tonomo", eventId, payloadJson, "received", Date.now())
      .run();
    context.executionCtx.waitUntil(context.env.BACKGROUND.processTonomoEvents().catch((error) => {
      // The event is durably stored; an RPC failure must not make Tonomo retry a deduped delivery.
      console.error("Tonomo webhook handoff failed", error);
    }));
  } catch (error) {
    console.error("Tonomo webhook storage failed", error);
    return context.text("Webhook storage failed", 500);
  }
  return context.json({ ok: true });
});

app.notFound((context) => context.text("Not found", 404));

export default app;
