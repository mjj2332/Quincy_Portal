# #741 5b-counts reuse ledger

| Element | Item used | Notes |
|---|---|---|
| Open-notes count chip on VideoCard ("N open note(s)") | installed `components/reui/badge.tsx`, `variant="info-light" size="sm"`, `tabular-nums`, inline on the versions row | follows the Portal's count-badge precedent (`components/board/board.tsx` "N overdue": light tone, `size="sm"`; number counts use `tabular-nums`), and a light tone so it does not read as the `secondary` "v1" version chip. Inline on the versions row so cards keep one height with or without notes (design review r1); shown only when `latestNoteCount > 0`, hidden when null. No new raw button/input; no new primitive, so no search beyond the installed layer was needed. |
