Answers: which area map to read before exploring a part of the Portal. Each map is ≤60 lines and every row cites `path:line` or `path` + symbol.

| Map | Read it when you touch |
|---|---|
| `docs/maps/notifications.md` | a notification type, the outbox, email gating, preferences, delivery or the digest |
| `docs/maps/queues.md` | a queue message type, its producer or consumer, archived-Project guards, or a Workflow |
| `docs/maps/routes.md` | an API route, its mounting, middleware, the route manifest, or External DTO decoding |
| `docs/maps/project-sheet.md` | the Project sheet over the Dashboard, focus return, in-app navigation in tests, or the staff video notes panel |
| `docs/maps/date-time-controls.md` | any date, time, deadline or subtask-schedule control |
| `docs/maps/new-table.md` | a new D1 table or column (migration number, schema, seed, teardown, prod deploy) |
| `docs/maps/base-ui.md` | a Base UI Menu, Dialog or Popover: dismissal reasons, `anchor`, focus return, nesting |
| `docs/maps/tokens.md` | a design token or a style guard test under `portal/apps/web/src/styles/` |

Line numbers drift: when a cited line no longer holds its symbol, grep the symbol and fix the map in the same PR.

Last verified against 495766e9
