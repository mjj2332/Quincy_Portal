# Project header revamp

The Project page's header on desktop, tablet and phone. It supersedes the earlier "Project header —
rail to top" prototype (option 2a, #213), whose app shell and rail have since been replaced.

**Status:** prototype only. Nothing here is built yet, and the decisions listed at the bottom of
the page are still open for the owner.

## Files

- `project-header.html` is the whole prototype in one page: every frame, the notes for each frame,
  a working phone, the frame-to-component map and the owner decisions. Read the source for sizes
  and behaviour. The frames are drawn at device size: 1440px desktop, 834px tablet, 390 × 844
  phone.
- Fonts load by relative path from `portal/apps/web/public/fonts/`, so open the file from inside
  the checkout. The copy shared on claude.ai embeds the fonts instead:
  - committed snapshot: https://claude.ai/artifact/SsjUtBffYF4iM2addxCjLr
  - working copy used for review: https://claude.ai/artifact/8xfy7a77Ri4Ynu3BcUxoQw

This is a hand-authored HTML page, not a claude.ai/design export bundle. It follows the same
rules: the prototype decides layout, hierarchy, sizes, copy and behaviour, and the build expresses
them in Quincy tokens (`portal/apps/web/src/styles/`).

## Frames

| Id | Frame |
|---|---|
| D1 | Desktop, project page at rest: Row A (identity + status cluster), Row B (tabs only) |
| D2 | Desktop, Details sheet open (right, 440px, modal) |
| D3 | Desktop, Team popover from the avatar stack |
| D4 | Desktop, Deadline popover |
| D5 | Desktop, ⋯ menu, and the condensed bar that sticks once Row A scrolls away |
| D6 | Desktop, status cluster states (due today, overdue, empty, Dropbox blocked, read-only, archived) |
| T1 | Tablet 834px: the cluster wraps under the title |
| M1 | Phone at rest: project bar (details button + whiteboard), sticky tabs |
| M2 | Phone after scrolling: project bar gone, the name moves into the shell bar |
| M3 | Phone, Project details bottom sheet |
| M4 | Phone, Stage view pushed in the sheet |
| M5 | Phone, Deadline view |
| M6 | Phone, Team view with the on-screen keyboard up |
| A1 | Alternative considered, not recommended: the name in the shell bar, no project bar |

## Building from it

Every frame id above maps to a component in the page's "Frame → component map". Where a frame
conflicts with a ReUI component, a guard or a product capability it does not show, stop and ask
the owner (AGENTS.md, "Building from a prototype"). Both browser-pass stages compare each
screenshot with the frame of the same id, at the same size and state. Phone rows run in Safari on
the iOS Simulator, with the keyboard up for M6.
