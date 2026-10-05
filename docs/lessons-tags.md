# Lessons tag vocabulary

Every `## ` section in `docs/lessons.md` carries a `Tags:` line directly under its heading
(`Tags: <tag>, <tag> · #NNN`). Find sections with `node scripts/lessons-index.mjs <tag | #issue | heading text>`.
`portal/packages/shared/test/docs-integrity.guard.test.ts` rejects a section whose tags are missing or not listed here.
Add a tag here first, one bullet per tag, in the form below.

- `auth` — sessions, better-auth, Google OAuth, Origin/cookie checks
- `routing` — TanStack Router, URL state, navigation transport, lazy route chunks
- `d1-migrations` — D1/drizzle schema, migrations, SQL shape limits
- `workers-runtime` — Cloudflare Workers, wrangler dev, bindings, request handling
- `queues-workflows` — Queues, Workflows, retries, timeouts, durable failure handling
- `dropbox` — Dropbox API, folder trees, Tonomo RAW/Editor mirrors
- `media-renditions` — Image renditions, thumbnails, uploads, R2 media
- `notifications` — Notification bell, outbox, activity feed, email digests
- `css-tokens` — Tailwind v4, cascade, design tokens, breakpoints, focus rings drawn in CSS
- `focus-overlays` — Focus management, popovers, dialogs, sheets, floating-UI placement
- `reui-vendor` — Vendored ReUI/base-nova components and their Quincy adaptations
- `board-dnd` — Kanban Board, dnd-kit, drag state, card order
- `gantt-calendar` — Calendar and Timeline (event-calendar, Gantt) views
- `rich-text` — Tiptap editors, embedded images/video, link previews
- `whiteboard` — Project whiteboard (Excalidraw, socket, versions, media)
- `testing-guards` — Test design, grep/AST guards, flakes, CI test coverage
- `deploy-ci` — CI, deploys, rollouts, production verification
- `agent-tooling` — Agent workflow, subagents, local tooling traps, review process
- `qa-browser` — Real-browser verification and what only a browser reveals
- `search-filters` — Dashboard search/Filter, query cache, optimistic state, paging
- `scheduling` — Shoot dates, Deadlines, reminders, Tonomo scheduling data
- `permissions` — Authorization, author-only rules, archived/read-only access
