# TB3 — Project Discussion v2

**Primary user outcome:** project feedback refreshes asynchronously and unread state follows the user across devices.

## Scope

- Apply route/query conventions to project discussion.
- Preserve Tiptap content, mentions, access, author-only edits/deletes and audits.
- Add server-side read marker.
- Add delayed refresh while panel is open and focus refetch.
- Keep cursor pagination.
- Choose adapter-first or common-schema migration.
- Write durable notification intent compatible with TB4, but do not require full Queue migration unless planned together.

## Non-goals

- realtime chat;
- notice-board migration;
- reactions/attachments/replies unless explicitly approved;
- broad collaboration panel redesign;
- deleting current tables.

## Acceptance

- another tab/user's comment appears without reload;
- read state follows simulated devices;
- drafts survive refetch;
- access/mention/audit policies remain exact;
- pagination/order remain correct;
- direct collaboration link still opens the panel.

## Checkpoint

Confirm that the discussion API/model can serve the project-card experience and later notice board without speculative over-generalization.
