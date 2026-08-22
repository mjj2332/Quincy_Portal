# TB2 — Route-Safe Project Data Freshness

**Primary user outcome:** Project Workspace detail and active collection assets receive relevant changes without reload while routes/tabs/drafts remain correct.

## Scope

- Add TanStack Query provider and typed key factory.
- Migrate project detail and active collection assets only.
- Keys include project ID and collection kind.
- Use query AbortSignal/late-response protection.
- Focus/reconnect refetch and bounded visible polling.
- Narrow mutation invalidation plus same-browser BroadcastChannel messages.
- Preserve existing job/AutoHDR/ingest/comment/checklist lifecycles temporarily.
- Preserve active tab, Lightbox, selection, scroll, and drafts.
- Clear inaccessible data on permanent access loss.

## Targets

- same-browser tab: approximately two seconds after successful mutation;
- another browser/session: within bounded polling target, generally 30 seconds.

## Non-goals

- every API conversion;
- router replacement;
- WebSockets;
- duplicate five-second special polling;
- UI redesign.

## Acceptance

- direct URL and A/B project isolation;
- RAW/Edited separation;
- late response cannot overwrite new route/collection;
- focus/poll/broadcast external update;
- narrow invalidation;
- no draft/Lightbox/selection loss;
- access removal clears private data;
- Back/Forward/new-tab intact;
- full gate/manual QA.
