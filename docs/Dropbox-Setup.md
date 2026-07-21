# Quincy Portal — Dropbox integration setup

> **Purpose:** everything the Dropbox App Console needs, plus how the portal side works.
> Written 2026-07-20. App key/secret are already entered in local `.dev.vars` and uploaded
> as Worker secrets to all three deployed workers — this doc is the checklist to verify the
> console configuration matches what the code expects.

## What the integration does

One **studio-level** Dropbox connection (not per-user): an admin clicks **Connect Dropbox**
in Admin → Integrations, approves once, and the portal stores the OAuth tokens encrypted
(AES-256-GCM; key never leaves Worker secrets). The background worker then uses that
connection to:
- **Pull RAW captures**: each shoot's Dropbox folder (from the project's `rawFolderPath` /
  `rawFolderLink`) is synced file-by-file into R2 — JPEG-only, idempotent by content hash,
  XMP star ratings read during ingest.
- **autoHDR round-trip**: copy selected RAWs into the autoHDR watch folder and ingest the
  returned edits (folder paths to be confirmed with the autoHDR account — still TODO).
- **Webhook-driven delta sync**: Dropbox notifies the ingress worker on changes; a Durable
  Object runs cursor ticks so nothing is polled.

## Dropbox App Console checklist (verify these exact values)

Console: <https://www.dropbox.com/developers/apps> → your app.

| Setting | Required value | Why |
|---|---|---|
| API | Scoped access | Modern app model |
| Access type | **Full Dropbox** | Shoot folders live anywhere in the studio Dropbox, not inside an app folder |
| Permissions (scopes) | `files.metadata.read` · `files.content.read` · `files.content.write` · `sharing.read` | list folders · download RAWs · upload to the autoHDR watch folder · resolve shared-folder links (`dropbox.com/scl/fo/…`, the form Tonomo sends) to real paths |
| OAuth 2 → Redirect URIs | `https://quincy.flamingfire.my/api/integrations/dropbox/callback` | Production connect flow (APP_ORIGIN is the prod host). Optionally also add `http://localhost:8787/api/integrations/dropbox/callback` for local dev. |
| Webhooks → Webhook URIs | `https://quincy-portal-webhook-ingress.mjj2332.workers.dev/webhooks/dropbox` | The ingress worker answers Dropbox's verification challenge automatically (GET echo) and HMAC-verifies every delivery |

> **Scope changes only apply to NEW tokens.** If you edit permissions after connecting,
> disconnect/reconnect in Admin → Integrations so a fresh token carries the new scopes.

## Secrets & where they live

| Secret | Local dev | Production |
|---|---|---|
| `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` | `portal/workers/app/.dev.vars` (gitignored) | Worker secrets on `quincy-portal-app` + `quincy-portal-background`; the secret also on `quincy-portal-webhook-ingress` (webhook HMAC) |
| `INTEGRATION_KEK` (32-byte AES key, base64) | `.dev.vars` | Worker secret on app + background — encrypts the stored Dropbox tokens; the DB row is ciphertext only |

Uploaded 2026-07-20. Rotating the KEK invalidates the stored connection (reconnect after).

## Connecting (once the current build wave is deployed)

1. Sign in at <https://quincy.flamingfire.my> as admin → **Admin → Integrations**.
2. **Connect Dropbox** → approve in Dropbox → you land back in the portal; the card shows
   **connected** with the granted scopes.
3. On any shoot with a Dropbox folder set (the New-shoot/Edit-details "Dropbox" fields),
   use **Sync from Dropbox** in the workspace — frames appear in the RAW tab with their
   star ratings.

## Troubleshooting

- Card shows **error** + `lastError`: usually scope missing (reconnect after fixing
  permissions) or the folder path not matching (`rawFolderPath` should look like
  `/Photos/2026/12 Kings Road`, case-insensitive).
- Webhook not firing: check the console's webhook shows **Enabled** after the challenge;
  deliveries are HMAC-verified, so a signature mismatch (wrong app secret on the ingress
  worker) drops them with 401.
