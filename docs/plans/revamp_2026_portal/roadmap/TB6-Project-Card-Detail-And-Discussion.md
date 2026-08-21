# TB6 — Project-Card Detail and Shared Discussion

**Primary user outcome:** a user can inspect and discuss a project from the board without duplicating project data/comments.

## Scope

- Define responsive quick-detail presentation (sheet/dialog/route combination).
- Reuse project query, activity and project discussion.
- Provide canonical link to full `/projects/:projectId` workspace.
- Preserve deep-link/Back behavior when quick-detail state is URL-addressable.
- Add only card controls justified by the product.

Potential sections:

- project summary;
- stage/priority;
- shared editor roster, project due date/time and configured reminder summary;
- activity timeline;
- project discussion.

## Non-goals

- new `kanban_card` table for existing project cards;
- duplicate card-comment store;
- full project-workspace replacement;
- arbitrary generic board/card product.

## Acceptance

- same project discussion appears consistently in workspace and card detail;
- updates invalidate both views;
- route/open-new-tab behavior is predictable;
- focus/scroll/mobile sheet behavior passes QA;
- access restrictions remain exact.
- project deadline/editor updates invalidate the board card, collaboration pane and quick detail consistently;
- TB6 does not create a second reminder or editor-assignment store.

## Checkpoint

Confirm the project/card relationship before any future non-project board concept is considered.
