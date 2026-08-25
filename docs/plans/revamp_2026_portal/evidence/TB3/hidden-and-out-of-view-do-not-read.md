# TB3 hidden and out-of-view read evidence

## Hidden observer

The QA Collaboration panel was open before the Admin created the hidden fixture. Commit began
12:34:16.360Z. The QA window stayed backgrounded for 36.002 s, from 12:35:16.032Z through
12:35:52.034Z. On return, the direct marker response was:

```text
throughCreatedAt=2026-08-25T12:34:16.673Z
throughCommentId=[redacted]
updatedAt=2026-08-25T12:34:40.340Z
unreadCount=0
```

The marker changed during the hidden interval (approximately 23.667 s after comment creation), so
the required “zero hidden marker PATCHes and marker unchanged” assertion failed. The connector lost
the filtered Network event stream during a native-dialog reset; no zero-request claim is made.

## Out-of-view presentation gate

Not attempted. A/B did not expose a standalone/compact Collaboration-only route after the access
fixture was removed, and the stage-hidden fixture could not be created safely through the real Admin
UI. Four-page transition counts and IntersectionObserver geometry were not fabricated.
