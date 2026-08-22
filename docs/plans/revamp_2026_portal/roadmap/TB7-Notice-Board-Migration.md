# TB7 — Notice-Board Migration

**Primary user outcome:** notice-board unread state follows the user across devices and notice mentions use the proven refresh/delivery foundations.

## Scope

- Preserve top-level notice-post model, rich text, mentions, capability gating, and author-only rules.
- Move seen/read state from localStorage to D1 per user.
- Apply route/query refresh and focus/open semantics.
- Mark read only after fresh visible presentation.
- Reuse TB4 durable mention delivery and Admin operations.
- Preserve local collapse preference if useful.
- Preserve drafts during polling.

## Non-goals

- replies/comments under notices;
- pinning;
- priority;
- expiry;
- acknowledgement;
- realtime/social feed ranking;
- external platform;
- universal discussion storage migration unless separately planned after evidence.

## Acceptance

Two-device read state, hidden/background semantics, new notice without reload, durable mention delivery, author/access rules, drafts, desktop/phone behavior, full gate/manual QA.
