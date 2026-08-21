# TB7 — Notice-Board Migration

**Primary user outcome:** notice read state is server-synchronized and the notice board reuses the proven discussion/notification foundations.

## Scope

- Move read/seen state from localStorage to D1.
- Apply route/query refresh conventions.
- Reuse shared rich-text, mentions and delivery pipeline.
- Decide and implement only approved notice-specific behavior:
  - replies/comments;
  - pinning;
  - priority;
  - expiry;
  - acknowledgement.
- Preserve capability and author-only rules unless changed explicitly.

## Non-goals

- social network feed ranking;
- realtime chat;
- external feed platform;
- migrating every historical product event into notices.

## Acceptance

- read state follows two simulated devices;
- new notice appears without reload;
- collapse state may remain local, but unread state is server-authoritative;
- mention delivery uses the new reliable path;
- notice-specific metadata behaves correctly;
- drafts survive polling.

## Checkpoint

Validate that the shared discussion foundation supports a second distinct domain without becoming generic prop/schema sprawl.
