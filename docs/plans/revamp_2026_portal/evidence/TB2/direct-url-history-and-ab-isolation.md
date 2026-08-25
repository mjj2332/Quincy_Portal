# TB2 item 1 — direct URL, history, and A/B isolation

Fixture labels: A = `1 Synthetic Test Street`; B = `2 Synthetic Test Avenue`. Both were local
synthetic projects in the same already-authenticated Chrome session.

## Observed route sequence

| UTC | Action | URL / DOM result | Network result |
|---|---|---|---|
| 03:57:06.980 | New tab, direct paste to A | `/projects/A`; street A; RAW 2 | A detail and `A/assets?collection=raw` requests only for project data. |
| 03:57:16.086 | Ordinary `← Dashboard` link | `/`; dashboard showed both A and B | Dashboard project list loaded; no full-page document reload. |
| 03:57:31.611 | Dashboard link B | `/projects/B`; street B; RAW 0 | B detail, B raw assets, ingest, jobs, comments, and subtasks requests. No A project-data request. |
| 03:57:44.218 | Ordinary `← Dashboard`, then dashboard link A | `/projects/A`; street A; RAW 2 | A detail and A raw assets were requested; B data did not appear in the A DOM. |
| 03:58:00.317 | Back | Dashboard DOM contained both A and B cards. |
| 03:58:10.974 | Forward | `/projects/A`; street A; RAW 2 | A detail/assets restored; no B asset request. |
| After 03:58:10.974 | Cmd-click B | New tab `/projects/B`; street B; RAW 0 | Separate tab contained no A street or A count. The exact click timestamp was not emitted by the tab-list API. |

The last Cmd-click produced a new local tab with B's URL and no A content. The route transitions
were SPA transitions: observed traffic was API/static asset traffic, not a replacement HTML
document navigation. Query-key expectations were preserved as exact project/collection tuples.

## Disposition

Pass. URL, street, collection count, and asset request project IDs stayed aligned across direct
URL entry, ordinary links, Back/Forward, and new-tab navigation. The full request ledger and
throttle details are consolidated in `manual-qa.md`.
