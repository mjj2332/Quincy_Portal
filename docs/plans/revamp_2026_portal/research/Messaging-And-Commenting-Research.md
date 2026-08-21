# Research — Messaging and Commenting Systems

**User constraint:** no external managed messaging/comment/feed vendor. Cloudflare infrastructure is acceptable. Quincy needs asynchronous object-scoped feedback, not chat.

## Evaluated categories

### Managed collaboration platforms

Examples considered earlier included Liveblocks, Stream, TalkJS and Knock.

Rejected for the target architecture because:

- discussion/notification state would depend on an additional vendor;
- data/permission models would require synchronization;
- migration/export and long-term lock-in become central concerns;
- realtime/chat capabilities exceed Quincy's requirement.

They remain product references, not target dependencies.

### Self-hosted comment products

#### Artalk

A self-hosted comment server/client with nested comments, moderation, notifications and its own auth/content model.

Mismatch for Quincy:

- separate Go service and storage;
- public/page-key comment assumptions;
- different auth and rich-text model;
- project capability/audit integration still requires custom work.

#### Remark42

A lightweight self-hosted comment engine for blogs/articles with Markdown, nested comments, moderation, voting, images and notifications.

Mismatch for Quincy:

- website/article identity and moderation assumptions;
- separate service/data model;
- project access, Tiptap and audit rules still require adaptation.

#### Coral

A substantial open-source publisher/community commenting platform with moderation features.

Mismatch for Quincy:

- large operational footprint;
- publisher/community orientation;
- Node/MongoDB/Redis stack outside the current Cloudflare-native architecture.

### Self-hosted notification platform

#### Novu

Provides inbox/workflow/preferences/digests across channels, but self-hosting operates a separate multi-service platform.

It may be reconsidered only if Quincy reaches notification complexity that materially exceeds a D1 outbox + Cloudflare Queues/Workflows design.

## Conclusion

Quincy already owns much of the difficult domain-specific foundation:

- project access rules;
- Tiptap rich text;
- mentions;
- author-only mutation;
- auditing;
- notification rows and email;
- project and notice-board UIs.

Adding a second comment product would not eliminate the project-specific work and would introduce another runtime/data/auth model.

Recommended direction:

- generalize/refactor Quincy-owned discussion behavior;
- D1 as source of truth;
- TanStack Query for delayed synchronization;
- R2 for attachments when approved;
- Cloudflare Queues/outbox for reliable notification delivery;
- keep realtime chat in Slack/Google Chat.

## Official/open-source references

- https://github.com/ArtalkJS/Artalk
- https://github.com/umputun/remark42
- https://github.com/coralproject/talk
- https://docs.coralproject.net/
- https://github.com/novuhq/novu
