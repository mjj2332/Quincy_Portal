# #741 5b-counts reuse ledger

| Element | Item used | Notes |
|---|---|---|
| Open-notes count chip on VideoCard ("N open note(s)") | installed `components/reui/badge.tsx`, `variant="secondary"` | same Badge the card already uses for the version and Premium chips; shown only when `latestNoteCount > 0`, hidden when null. No new raw button/input; no new primitive, so no search beyond the installed layer was needed. |
