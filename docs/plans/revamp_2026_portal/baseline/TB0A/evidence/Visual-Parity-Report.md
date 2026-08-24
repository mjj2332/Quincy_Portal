# TB0A Visual Parity Report

Capture status: complete. All 22 `tb0a-*` screenshots were captured from the authenticated
local Worker at `http://localhost:8787/` after `npm run build -w @quincy/web` passed.

`window.innerWidth/innerHeight` matched the requested viewport before every capture:
`1440×900`, `1024×768`, or `390×844`. The browser screenshot backend produced different stored
PNG heights for TB0 and TB0A on some desktop/mobile captures; this is a capture-surface artifact.
Comparison was made against the verified page viewport and normalized layout, not raw PNG height.

`PASS` means no React 19.2 visual drift was found. `*` marks a real difference that is not a TB0A
regression and is recorded below.

| Before → after pair | Result | Difference / judgment |
|---|---|---|
| `current-admin-1440-directory.png` → `tb0a-admin-1440-directory.png` | PASS* | Layout and hierarchy match. Current unread notification badge and capture-surface scale differ. |
| `current-admin-1440-integrations.png` → `tb0a-admin-1440-integrations.png` | PASS* | Layout and hierarchy match. Current unread notification badge and capture-surface scale differ. |
| `current-admin-1440-pipeline.png` → `tb0a-admin-1440-pipeline.png` | PASS* | Layout matches. The missing Up/Down controls are the intentional TB0B pipeline-order boundary already deployed, not TB0A drift. |
| `current-admin-1440-users.png` → `tb0a-admin-1440-users.png` | PASS* | Layout and hierarchy match. Current unread notification badge and capture-surface scale differ. |
| `current-create-project-1024-empty-correct.png` → `tb0a-create-project-1024-empty-correct.png` | PASS* | Empty form and focused street field match; current unread badge and capture-surface scale differ. |
| `current-create-project-1440-empty-correct.png` → `tb0a-create-project-1440-empty-correct.png` | PASS* | Empty form and focused street field match; current unread badge and capture-surface scale differ. |
| `current-create-project-390-empty-correct.png` → `tb0a-create-project-390-empty-correct.png` | PASS* | Responsive empty form and focus treatment match; current unread badge differs. |
| `current-create-project-390-focused-correct.png` → `tb0a-create-project-390-focused-correct.png` | PASS* | Focus treatment matches; current unread badge differs. |
| `current-dashboard-1024-kanban-notice-open.png` → `tb0a-dashboard-1024-kanban-notice-open.png` | PASS* | Responsive layout and open Notice Board match. Local project is now RAW review with 2 RAW/cover preview and Needs review 1, versus the baseline Awaiting RAW/0 RAW placeholder fixture. |
| `current-dashboard-1024-list-notice-open.png` → `tb0a-dashboard-1024-list-notice-open.png` | PASS* | List layout matches. Same local project fixture drift as the Kanban pair. |
| `current-dashboard-1440-kanban-notice-open.png` → `tb0a-dashboard-1440-kanban-notice-open.png` | PASS* | Desktop layout matches. Same local project fixture drift; notice timestamps also advanced from 4 to 5 days. |
| `current-dashboard-1440-list-notice-open.png` → `tb0a-dashboard-1440-list-notice-open.png` | PASS* | List layout and scroll state match. Same local project fixture drift. |
| `current-dashboard-390-kanban-notice-open.png` → `tb0a-dashboard-390-kanban-notice-open.png` | PASS* | Phone overflow/clipping and Kanban state match. Same local project fixture drift. |
| `current-dashboard-390-list-notice-open.png` → `tb0a-dashboard-390-list-notice-open.png` | PASS* | Phone overflow/clipping and List state match. Same local project fixture drift. |
| `current-edited-1440-empty.png` → `tb0a-edited-1440-empty.png` | PASS* | Edited empty layout and closed Collaboration rail match. Current stage/count warning reflects local fixture drift. |
| `current-notifications-1440-open.png` → `tb0a-notifications-1440-open.png` | PASS* | Open menu placement matches. Baseline was caught up; current local state has one unread RAW-ready notification. It was not opened, read, dismissed, or changed. |
| `current-workspace-1024-closed.png` → `tb0a-workspace-1024-closed.png` | PASS* | Closed Collaboration state and responsive layout match. Current project data differs from the baseline fixture. |
| `current-workspace-1024-default.png` → `tb0a-workspace-1024-default.png` | PASS* | Default open Collaboration state matches. Current project data differs from the baseline fixture. |
| `current-workspace-1440-collaboration-closed.png` → `tb0a-workspace-1440-collaboration-closed.png` | PASS* | Closed Collaboration state matches. Current project is RAW review with two processing synthetic assets; baseline was Awaiting RAW with transient upload-error rows. |
| `current-workspace-1440-collaboration-open.png` → `tb0a-workspace-1440-collaboration-open.png` | PASS* | Open Collaboration state and layout match. Current project has two synthetic processing assets and two checklist items; baseline had one checklist item and no persisted assets. |
| `current-workspace-390-closed.png` → `tb0a-workspace-390-closed.png` | PASS* | Phone closed Collaboration state matches. Current project data differs from the baseline fixture. |
| `current-workspace-390-open.png` → `tb0a-workspace-390-open.png` | PASS* | Phone open Collaboration state matches. Current project data differs from the baseline fixture. |

## Non-noise differences recorded

- The local synthetic project had changed before this task: stage `RAW review`, expected count 5,
  two synthetic RAW assets in processing, two checklist items, and failed local background-worker
  manual-upload jobs. TB0 showed `Awaiting RAW`, expected count 4, no persisted assets, one
  checklist item, and transient four-file R2 upload-error rows. No upload, data repair, deletion,
  or direct database mutation was performed to recreate or undo that transient state.
- The notification menu was not caught up locally: one unread `RAW ready for review` item was
  visible. The menu was opened read-only; the item was not clicked or marked read.
- TB0's Pipeline screenshot predates TB0B and shows Up/Down stage-order controls. Their absence
  in TB0A is the approved, already-deployed TB0B boundary.
- Stored PNG dimensions differ on some baseline/after pairs because the screenshot surfaces used
  different browser-surface cropping. Page viewport dimensions were exact and independently
  verified for every after image.

## Redaction check

Passed visual review for all 22 after images. Visible content is synthetic local fixture data plus
the intentional seeded test identity `mjj2332@gmail.com`; no secret, signed URL, token, provider
UID, private Dropbox path, real client contact, or billing data is visible.
