# Cloudflare Cache Purge — Setup Guide

Two **background-Worker-only** secrets, `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_CACHE_PURGE_TOKEN`,
that let the background Worker call Cloudflare's full-zone purge after an `external_editor` role
transition (TB4E). **Do this once before the first External Editor account is ever provisioned or
converted** — not before, not as part of the TB4E deploy (TB4E shipped without them by design,
enabled-but-dark).

## Why it matters

When a user is converted to or from `external_editor`, their old cached edge responses could still
be served for up to the edge TTL. The background Worker's `processExternalRoleCachePurges` job
(`workers/background/src/external-role-cache-purge.ts`) fires a `purge_everything` for the zone to
close that window. Without both secrets, `purgeZone()` returns `false` on every attempt →
`MAX_PURGE_ATTEMPTS` (5) over `PURGE_DEADLINE_MS` (30 min) exhaust → the job **freezes External
Editor provisioning** (sets the `external_editor_provisioning_frozen` feature flag, writes an
`external.provisioning.frozen` audit row) and pages the operator to run a manual zone purge. So a
missing secret doesn't lose data — it stops all further External Editor provisioning until
someone purges by hand and an admin releases the freeze (below). Nothing releases it automatically:
a later successful purge does not undo the exhaustion that froze it (#161).

Grounded in Cloudflare's current docs (fetched 2026-08-28); links below are the source of truth if
a dashboard flow has shifted.

## Step 1 — Find the Zone ID

Dashboard: select the **`flamingfire.my`** zone → **Overview** → **Zone ID** in the right-hand
"API" panel. Or, once you have the token (step 2), one call gives you the ID and confirms the
token can see exactly that zone:

```bash
curl -s "https://api.cloudflare.com/client/v4/zones?name=flamingfire.my" \
  -H "Authorization: Bearer <TOKEN>" | jq '{zone: .result[0].name, zone_id: .result[0].id}'
```

The Zone ID is a 32-hex-char string; it is not secret the way the token is (it shows in dashboard
URLs). Reference: [Find zone and account IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).

## Step 2 — Create a scoped API token

1. Dashboard → **My Profile → API Tokens** (user token) → **Create Token → Create Custom Token**.
2. **Permissions:** one row — **Zone · Cache Purge · Purge** (this is the only permission the
   Worker needs; it calls `POST /zones/{id}/purge_cache` with `{"purge_everything": true}`).
3. **Zone Resources:** **Include · Specific zone · `flamingfire.my`** — not "All zones".
4. Optionally set **Client IP Address Filtering** / **TTL**; leave blank if unsure.
5. Create, then **copy the token value now** — it is shown once.

Reference: [Create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/),
[Cache Purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/).

## Step 3 — Validate the token without purging

Confirm the token is live before wiring it in — do **not** run a real purge to test:

```bash
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer <TOKEN>" | jq '.success, .result.status'
```

Expect `true` / `"active"`. The zone-name call in step 1 doubles as the scope check.

**Never paste the token into a shared terminal, chat, or ticket.** If it lands somewhere it
shouldn't, roll it (dashboard → API Tokens → the token → **Roll**) and re-run step 4 with the new
value — a Cache-Purge token is low blast radius but it can flush the whole production edge cache.

## Step 4 — Set the secrets on the background Worker only

```bash
cd "<repo>/portal/workers/background"   # the dir with wrangler.jsonc — wrangler reads the
                                        # Worker name (quincy-portal-background) from it, and
                                        # top-level = production (there is no staging env)
npx wrangler secret put CLOUDFLARE_ZONE_ID
npx wrangler secret put CLOUDFLARE_CACHE_PURGE_TOKEN
```

- **Background Worker only.** `workers/app` and `workers/web` must never hold these — the app
  Worker has no purge code path and the token would be needless blast radius. `workers/background/
  wrangler.jsonc` already carries a comment marking them as secret-only; do not add them as
  committed `vars`.
- After `wrangler secret put`, redeploy is not required for the secret to take effect on the next
  invocation, but follow the repo's usual **background → webhook-ingress → app** order if you
  redeploy for any other reason.

## Step 5 — Confirm wiring without triggering a purge

- `npx wrangler secret list` in `portal/workers/background` shows both keys.
- The env type already declares them (`workers/background/src/env.ts`) — no code change needed.
- The job only runs on a real `external_editor` role transition, so there is nothing to smoke-test
  until the first provisioning. When that happens, watch the `jobs` table for a
  `kind = 'external_role_conversion_cache_purge'` row reaching `status = 'done'` and confirm the
  `external_editor_provisioning_frozen` flag stays `0`.

## If provisioning is already frozen

If the flag got set (secrets were missing when a transition ran):

1. Run the full-zone purge by hand — dashboard **Caching → Configuration → Purge Everything**, or
   `curl -X POST https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/purge_cache -H "Authorization: Bearer <TOKEN>" -d '{"purge_everything":true}'`.
2. Verify the purge in the dashboard, then release the freeze in **Admin → Users → Release
   freeze** (or `PATCH /api/users/external-provisioning-freeze` with `{"frozen": false}` as an
   admin). The release writes an `external.provisioning.released` audit row with the actor, so the
   operator evidence is recorded for you. Do not clear the flag with a hand-written D1 statement:
   it leaves no audit trail.
3. Set the secrets (steps 1–4) so it does not recur.

## If something in this guide is stale

Cloudflare dashboard menu names shift. The linked docs pages are authoritative; this guide is a
snapshot, not something Quincy Portal keeps in sync.
