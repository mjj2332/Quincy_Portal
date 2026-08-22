# TB6 — Project-Card Detail and Shared Discussion

**Primary user outcome:** staff can inspect project summary, activity, and discussion from Kanban without duplicating project data or comments.

## Presentation

- URL-addressable state.
- Desktop side sheet over board.
- Phone full-screen presentation.
- Back/Forward closes/reopens predictably.
- Refresh and direct link preserve context.
- Native new-tab path and clear link to `/projects/:projectId`.

## Views

- **Overview:** project summary, presentation-safe Stage, Priority, Photographers/Editors, Deadline/reminder summary.
- **Activity:** immutable structured project events.
- **Discussion:** existing project discussion and unread state.

Do not interleave Activity and Discussion into one undifferentiated feed.

## Scope

- Reuse project/board queries and TB2 freshness.
- Reuse TB4C activity and TB3 discussion.
- Invalidate board, sheet, and workspace coherently after mutations.
- Add only controls already authorized by accepted contracts.
- Preserve access and collaboration-only projections.

## Non-goals

- `kanban_card` table for project cards;
- duplicate comment/activity store;
- full workspace replacement;
- generic board/card product;
- new reminder/team stores.

## Acceptance

Same data/discussion/activity is consistent across board/sheet/workspace; URL/navigation/focus/scroll/mobile/access behavior passes; no duplicate domain store; full gate/manual QA.
