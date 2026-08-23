# TB6 — Project-Card Detail and Shared Discussion

**Primary user outcome:** authorized users can inspect project summary, activity, and discussion from production views without duplicating project data or comments.

**Sequence:** after TB5C, before TB7  
**Dependencies:** TB2 freshness, TB3 discussion/read state, TB4C activity, TB4E External Editor safe projection, accepted Dashboard/Kanban/Calendar navigation state

## Presentation

- URL-addressable state.
- Desktop side sheet; phone full-screen presentation.
- Back/Forward closes/reopens predictably.
- Refresh/direct link preserve context.
- Native new-tab path and clear link to `/projects/:projectId`.
- May be opened from Kanban or Calendar project context without creating a Calendar-specific detail store.

## Views

- **Overview:** project summary, presentation-safe Stage, Priority, team, Deadline/reminder summary.
- **Activity:** immutable structured project events.
- **Discussion:** existing project discussion/unread state.

Do not interleave Activity and Discussion.

## Authorization/projection

- Internal Admin/Editor receive their approved project projection.
- External Editor may open TB6 only for assigned non-archived projects and receives the TB4E external-safe Overview/Activity/Discussion projection.
- Hidden event categories/fields are omitted server-side, not merely hidden in the sheet.
- Losing membership while sheet is open purges data/closes the sheet through the approved access-loss freshness behavior.
- Collaboration-only fallback semantics remain distinct from normal External Editor assigned-project access.

## Scope

Reuse project/board/Calendar queries where safe, TB2 freshness, TB4C activity and TB3 discussion. Invalidate board/Calendar/sheet/workspace coherently after source mutations. Add only controls already authorized by accepted contracts.

## Non-goals

No `kanban_card` table, duplicate comment/activity store, full workspace replacement, generic board/card product, Calendar-specific detail store, or new reminder/team stores.

## Acceptance

Same authorized data/discussion/activity remains consistent across Dashboard views/sheet/workspace; URL/navigation/focus/scroll/mobile/access behavior passes; External Editor field/event privacy holds; no duplicate domain store; full gate/manual QA.
