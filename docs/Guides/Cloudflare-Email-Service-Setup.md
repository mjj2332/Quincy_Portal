# Cloudflare Email Service — Setup Guide

For enabling real email delivery for `Notifications-Plan.md`'s in-app + email notifications
feature. **Not required to build or deploy the feature** — in-app notifications work with no
Cloudflare email setup at all; without this, email sends will just fail silently and land in each
notification row's `email_error` column (the plan's existing best-effort, no-retry behavior).
Follow this whenever you're ready to make email delivery actually work.

Grounded in Cloudflare's current docs (fetched 2026-07-28) rather than assumed — cite links below
so you can re-check anything that looks off, since Cloudflare Email Service is explicitly still a
beta product and UI/behavior can shift.

## The two independent things you need

Cloudflare's own docs describe these as two separate axes, not a sequence — you don't have to do
one before the other, though in practice the destination-address step below happens to live under
the "Email Routing" section of the dashboard.

1. **Sender-domain onboarding** ("Email Sending") — authorizes `flamingfire.my` to send outbound
   mail via the Workers binding at all. **This is required** — Cloudflare's docs are explicit that
   "the sender address must always belong to a domain you have onboarded to Email Service," so
   skipping this means the binding can't send, full stop, even to an already-verified destination.
2. **Destination-address verification** — each individual staff email address that should be
   allowed to *receive* notifications must be added and verified once. Sending to a verified
   destination address is **free on every Cloudflare plan**, including Workers Free — you do not
   need Workers Paid for this. (Workers Paid is only required if you ever want to send to
   arbitrary/unverified recipients, which this feature never does — every recipient is a known
   staff member.)

## Step 1 — Onboard the sending domain

1. In the Cloudflare dashboard, go to **Compute → Email Service → Email Sending**.
2. Select **Onboard Domain** and choose `flamingfire.my`.
3. Cloudflare will ask you to add DNS records on a `cf-bounce` subdomain of your domain (MX, SPF,
   DKIM, and DMARC records) — these authenticate outbound mail and handle bounce processing. If
   `flamingfire.my`'s DNS is already managed in this same Cloudflare account/zone, this is
   typically a one-click "add these records for me" step; otherwise you'll need to add them at
   whatever registrar/DNS host you use for this domain.
4. Wait for DNS propagation and onboarding to show as confirmed in the dashboard before testing a
   send.

Reference: [Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/).

## Step 2 — Verify each staff destination address

1. Go to **Compute → Email Service → Email Routing → Destination Addresses** (verifying a
   destination address lives under the "Email Routing" section of the dashboard even though it's
   what makes *outbound* sending to that address work — this is just how Cloudflare's UI is
   organized, it doesn't mean you need to set up full inbound Email Routing/MX records on your
   root domain for this feature to work).
2. Enter each staff member's email address (everyone who should receive notifications) and submit.
3. Cloudflare sends a verification email to that address — the recipient has to open it and click
   **Verify email address**. Until they do, sending to that address will keep failing (the row's
   `email_error` will show it).
4. Repeat for every current staff member. **Ongoing**: this needs to be a step in your "add a new
   staff member" checklist going forward — a newly added user's account works immediately for
   in-app notifications, but their email notifications will silently fail until someone verifies
   their address here. (Nothing in the code enforces or reminds you of this — it's a manual
   dashboard step, not something Quincy Portal can automate.)

Reference: [Email Routing destination addresses](https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/).

## Step 3 — Set the sender address secret

The Worker code (both `workers/app` and `workers/background`) reads a `NOTIFICATIONS_FROM_ADDRESS`
variable for the `from` field on every send — this needs to be an address on the onboarded domain
(e.g. `notifications@flamingfire.my`). Set it as a `wrangler secret`/var per environment, the same
way other environment-specific config is already set in this repo — check with whoever built the
notifications feature for the exact variable name if it differs from this.

```bash
npx wrangler secret put NOTIFICATIONS_FROM_ADDRESS
```

Run this in both `portal/workers/app/` and `portal/workers/background/` (or check whichever
config style the actual build used — `wrangler.jsonc` vars vs. `wrangler secret`).

## Step 4 — Confirm the `send_email` binding is live

Both Workers' `wrangler.jsonc` should declare:

```jsonc
"send_email": [{ "name": "EMAIL" }]
```

No `destination_address` restriction is needed — there are multiple distinct staff recipients, not
one fixed address. (Cloudflare also supports an `allowed_destination_addresses` allowlist if you
ever want to additionally restrict the binding itself beyond account-level verification — not
necessary for this feature, since account-level destination verification already gates it.)

Reference: [Configure send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

## Step 5 — Send a real test

Once steps 1–4 are done and both Workers are deployed, trigger a real event (e.g. move a test
project from `awaiting_raw` to `raw_review`, or post a comment on an asset with an assigned
editor) and confirm:

- The in-app notification appears (this works regardless of the above steps).
- The recipient's verified inbox actually receives the email.
- If it doesn't arrive, check that notification's row in the `notifications` table —
  `email_error` will usually explain why (unverified destination, sender domain not onboarded,
  etc.).

## Pricing note

Sending to verified destination addresses (exactly this feature's use case) is free on every
Cloudflare plan. You do not need to upgrade anything for this to work.

Reference: [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

## If something in this guide is stale

Cloudflare Email Service is explicitly in beta — menu names/flows can change. If a step above
doesn't match what you see in the dashboard, the linked docs pages are the source of truth; this
guide is a snapshot, not something Quincy Portal keeps in sync automatically.
