# TB3 cross-tab timing

All identities, project IDs, comment IDs, and source-tab IDs are redacted. Times are local wall
clock from the browser/DevTools evidence.

## Same-session Admin tabs

| Operation | Sender request(s) | Receiver request(s) | Result |
|---|---|---|---|
| create | 12:18:27.158 POST; 12:18:27.174 comments GET + marker GET; 12:18:27.203 marker PATCH | 12:18:27.219 comments GET + marker GET; 12:18:27.235 marker PATCH | 61 ms from sender POST to receiver GET; one row, no reload |
| edit | 12:20:44.907 PATCH; 12:20:44.928 comments GET | 12:20:44.935 comments GET | 28 ms from sender PATCH; one edited row |
| delete | UI confirmation completed | timing lost across connector reset | row disappeared in both tabs |

Actual receiver invalidation payload for edit:

```json
{"version":1,"type":"project-data-invalidated","projectId":"[A]","committedAt":"2026-08-25T12:20:44.935Z","resources":[{"kind":"comments"}],"sourceTabId":"[redacted]"}
```

No comment body, author, detail resource, or asset resource appeared in the captured payload.

## Cross-principal visible convergence

Admin commit began 12:32:29.197Z. The QA page was foregrounded at 12:33:20.042Z and rendered one
row: 50.845 s. The marker response carried the Admin row tuple (createdAt 12:32:30.490Z,
ID redacted) and `unreadCount:0`. This exceeds the 30-second target.

The two-device item was intentionally not attempted: it needs a second storage-partition-isolated
session for the same QA principal, which this tooling cannot drive.
