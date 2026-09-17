import type { Env } from "./env";

export const EXTERNAL_PROVISIONING_FROZEN_FLAG = "external_editor_provisioning_frozen";
const MAX_PURGE_ATTEMPTS = 5;
const PURGE_DEADLINE_MS = 30 * 60_000;
const PURGE_RETRY_DELAY_MS = 60_000;

type PurgePayload = { userId: string; roleChangeAuditId: string; authorizationEpoch: number; attempts?: number; deadlineAt?: number; nextAttemptAt?: number };
type PurgeJob = { id: string; retries: number; payloadJson: string | null };

/**
 * Latches the freeze. Re-asserting on conflict is deliberate — see the feature-flag ownership guard
 * and #161 — and so is clearing `updated_by`: the row names the admin who last released it, and a
 * re-freeze by the worker must not leave that admin looking like its author. Release is the admin
 * PATCH /api/users/external-provisioning-freeze.
 */
async function freezeProvisioning(env: Env, now: number, details: { attempts: number; deadlineAt: number; jobId: string }): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES (?, 1, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1, updated_by = NULL, updated_at = ?`)
      .bind(EXTERNAL_PROVISIONING_FROZEN_FLAG, now, now),
    env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'external.provisioning.frozen', 'feature_flag', ?, ?, ?)`)
      .bind(crypto.randomUUID(), EXTERNAL_PROVISIONING_FROZEN_FLAG, JSON.stringify(details), now),
  ]);
  console.error("External provisioning frozen: bounded zone purge exhausted; manual Cloudflare zone purge required, then release in Admin → Users", details);
}

async function purgeZone(env: Env): Promise<boolean> {
  if (!env.CLOUDFLARE_ZONE_ID || !env.CLOUDFLARE_CACHE_PURGE_TOKEN) return false;
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.CLOUDFLARE_ZONE_ID)}/purge_cache`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_CACHE_PURGE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ purge_everything: true }),
  });
  if (!response.ok) return false;
  try {
    const result = await response.json() as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}

/** Handles the conversion-only purge job; on exhaustion the runbook freezes provisioning. */
export async function processExternalRoleCachePurges(env: Env, now = Date.now()): Promise<number> {
  const rows = await env.DB.prepare(`SELECT id, retries, payload_json AS payloadJson FROM jobs WHERE kind = 'external_role_conversion_cache_purge' AND status = 'queued' ORDER BY created_at, id LIMIT 20`).all<PurgeJob>();
  let processed = 0;
  for (const row of rows.results) {
    let payload: PurgePayload;
    try { payload = JSON.parse(row.payloadJson ?? "") as PurgePayload; } catch { payload = { userId: "unknown", roleChangeAuditId: "unknown", authorizationEpoch: 0 }; }
    const attempts = payload.attempts ?? row.retries ?? 0;
    const deadlineAt = payload.deadlineAt ?? now + PURGE_DEADLINE_MS;
    if (payload.nextAttemptAt && payload.nextAttemptAt > now) continue;
    const claim = await env.DB.prepare(`UPDATE jobs SET status = 'running', retries = ?, payload_json = ?, updated_at = ? WHERE id = ? AND status = 'queued' RETURNING id`)
      .bind(attempts + 1, JSON.stringify({ ...payload, attempts: attempts + 1, deadlineAt }), now, row.id).first<{ id: string }>();
    if (!claim) continue;
    processed += 1;
    const nextAttempts = attempts + 1;
    if (await purgeZone(env)) {
      await env.DB.prepare(`UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ? AND status = 'running'`).bind(now, row.id).run();
      continue;
    }
    if (nextAttempts >= MAX_PURGE_ATTEMPTS || now >= deadlineAt) {
      await env.DB.prepare(`UPDATE jobs SET status = 'failed', error = ?, payload_json = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
        .bind("bounded zone purge retry exhaustion; manual zone purge required", JSON.stringify({ ...payload, attempts: nextAttempts, deadlineAt }), now, row.id).run();
      await freezeProvisioning(env, now, { attempts: nextAttempts, deadlineAt, jobId: row.id });
      continue;
    }
    await env.DB.prepare(`UPDATE jobs SET status = 'queued', error = ?, payload_json = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .bind("zone purge retry pending", JSON.stringify({ ...payload, attempts: nextAttempts, deadlineAt, nextAttemptAt: now + PURGE_RETRY_DELAY_MS }), now, row.id).run();
  }
  return processed;
}
