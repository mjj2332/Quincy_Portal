# TB4 email retry, DLQ, and unknown outcome

Local-only evidence. No real inbox or production email provider was used.

## Error classification and retry controls

The background integration matrix passed the documented quota-transient codes (`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, and `E_INTERNAL_SERVER_ERROR`), the uncoded failure case, persistent retry-to-DLQ, permanent failure, and post-send unknown classification. It also passed the fourth pre-email failure DLQ record/ack behavior.

The same suite passed:

- live-lease protection and 409 refusal;
- unknown-email immediate-resend refusal;
- Cron handling of an unknown email;
- bounded recovery of stale processing work;
- concurrent replay without duplicate acknowledgement.

Lease values are redacted as `****`. Only safe error codes are recorded; raw provider errors, payload JSON, email addresses, cookies, and tokens were not retained.

## Admin observation

In real Chrome, all four Admin filters were exercised. The live table showed:

- one pending/stuck row;
- one FAILED row;
- one UNKNOWN row with the bold duplicate-warning state;
- a DLQ row that was replayed successfully and moved out of the DLQ filter.

The Admin response/UI audit showed only operational fields: updated time, redacted project label, redacted recipient display name, channel states, delivery state, and safe error code. No message body, recipient address, payload, cookie, token, or raw provider message appeared in the DOM, console, or screenshots.

The UNKNOWN warning confirmation was visibly shown. Reliable affirmative control of the native confirmation dialog was not available in this browser session, so no manual unknown replay is claimed; the route tests passed the duplicate-warning and 409 safeguards.

After capture, all fixture email/outbox/ledger/notification rows were removed and the local synthetic recipient was deleted.
