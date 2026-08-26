# TB4 queue outage and recovery

Local-only evidence. The browser app was `http://localhost:8787`; background worker was local port 8789. No production binding was used.

## Outage

The app integration Queue-rejection seam forced `NOTIFICATION_QUEUE.send()` to reject for a committed project-comment mention transaction. Expected and observed state:

`comment committed + outbox pending → publish attempt 1 → pending / queue_publish_failed`

The comment was not lost, and the outbox retained intent. The seam ran without a source edit or temporary fault-injection code.

## Recovery

After restoring the local Queue/background path, the recovery work was invoked at 2026-08-26T01:08:02Z. The scheduled endpoint returned HTTP 200 and body `ok`. The background tests also passed stale-work recovery, duplicate Cron invocation, and unrelated-job isolation. Lease values are redacted as `****`; no full lease token or raw error was retained.

The live fixture’s final cleanup state was empty: no fixture outbox, ledger, or comment remained. The labeled project itself was retained for later archival.
