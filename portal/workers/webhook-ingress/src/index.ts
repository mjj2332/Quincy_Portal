import { Hono } from "hono";

import type { Env } from "./env";

const encoder = new TextEncoder();

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
  try {
    const result = await context.env.DB.prepare(
      "INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, event_id) DO NOTHING",
    )
      .bind(crypto.randomUUID(), "dropbox", eventId, payloadJson, "received", Date.now())
      .run();
    if (result.meta.changes === 0) return context.text("ok");
    await context.env.BACKGROUND.handleDropboxWebhook();
  } catch (error) {
    // Dropbox retries only on non-2xx; record failures in Worker logs while acknowledging promptly.
    console.error("Dropbox webhook handoff failed", error);
  }
  return context.text("ok");
});

app.notFound((context) => context.text("Not found", 404));

export default app;
