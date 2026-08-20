# Comment-Notification Email Content — Plan

> **Status: BUILT, VERIFIED, COMMITTED, AND DEPLOYED to production 2026-08-20 — commit `5b55d64`;
> no migration.**
>
> Built by Terra, then a fresh Terra diff review found one real (latent, non-live) issue: the
> notice-board email formatter would have rendered a "View project" link had any future caller ever
> passed one, breaking the plan's invariant that notice-board mentions never show a project link.
> Terra fixed it (the notice-board branch now unconditionally ignores `link`) with a regression test
> proving it even when a link is supplied, then a narrow Terra final pass confirmed the fix didn't
> regress the project-comment branch. The orchestrating session independently re-ran the full §5
> verify sequence outside any agent sandbox (all six workspaces green, including the two Worker test
> suites Codex's own sandbox cannot run) and read the security-critical diff directly. Opus
> final-draft review approved after mutation-testing the new tests (injected five regressions one at
> a time — reversed escape/`<br />` order, notice-board honoring `link`, `&apos;` instead of `&#39;`,
> an unescaped `projectLabel`, an unescaped `href`, and a missing surrogate guard — all five caught).
> Deployed to the `app` Worker only, per this plan's own Rollout section (background/webhook-ingress
> untouched).
>
> Went through the full `docs/Subagent-Orchestration.md` §2.1 plan-review pipeline: Terra draft →
> two Terra self-review rounds (round 1 found and a fix round closed a real Unicode
> surrogate-pair truncation bug, underspecified HTML-escaping control flow, thin test coverage,
> and one inaccurate research citation; round 2 approved) → Opus plan-tier review round 1
> (**REVERT TO TERRA** — found two blocking issues: HTML emails would have silently collapsed
> multi-line comments into one run-on line, and the plan's stated justification for escaping the
> link `href` was factually wrong, describing a live-attribute-injection threat that can't occur
> since the link is server-built from a validated UUID, not attacker input — plus a worthwhile
> simplification, reusing the already-computed plain-text `body` instead of re-deriving it from
> the rich-text document) → a Terra fix round adopted all findings → Opus plan-tier review round 2
> **APPROVED**, independently re-verifying both fixes by hand rather than trusting the description,
> with two minor implementation notes for the builder (not revert-worthy):
>
> 1. `packages/db/src/notifications.test.ts`'s `mockDb()` only mocks `insert().values()` and
>    `update().set().where()` — a real mention email always supplies `sourceKey`, which takes the
>    raw-SQL `db.run(sql\`…\`)` branch (`notifications.ts:117-122`). New mention-email tests must
>    either omit `sourceKey` (email construction doesn't depend on it) or add
>    `run: vi.fn(async () => ({ meta: { changes: 1 } }))` to the mock, or they'll throw
>    `db.run is not a function`.
> 2. The plan's `href`-safety paragraph attributes UUID validation to `staff-routes.ts:66-71`,
>    which only does `encodeURIComponent`; the actual validation is the `projectIdSchema =
>    z.string().uuid()` route guard (`project-comments.ts:79`, `:93`). The conclusion is
>    unaffected — `encodeURIComponent` alone already percent-encodes `" < > &`, so the citation
>    imprecision doesn't weaken the argument, but a builder citing this paragraph should point at
>    the route guard, not `staff-routes.ts`.
>
> A `/grill-me` round with the user settled six scope decisions before drafting began (see below)
> and one follow-up question mid-pipeline confirmed the in-app notification bell stays unchanged —
> this is an email-only enrichment. Ready for implementation whenever the user wants to proceed;
> this document does not build, commit, or deploy anything itself.

## Facts established before drafting

- Mention emails are deliberately narrow today. `notifyMentions()` has exactly two input scopes:
  `notice-board` and `project-comment` (`portal/workers/app/src/lib/notifications.ts:91`), and
  the only four production callers are the create/edit paths for project comments
  (`portal/workers/app/src/routes/project-comments.ts:87`, `:103`) and notice-board posts
  (`portal/workers/app/src/routes/notice-board.ts:92`, `:121`). This change enriches those
  existing sends only; it does not create a participant/reply notification trigger.
- Both writers already validate and normalize a `RichTextDoc`, derive its semantic plain text with
  `richTextPlainText()`, and persist that document as `content_json`: comments at
  `portal/workers/app/src/routes/project-comments.ts:38-49` and `:85-87`; posts at
  `portal/workers/app/src/routes/notice-board.ts:45-59` and `:85-92`. Passing that normalized
  document onward is equivalent to using the just-stored `content_json`, without adding a
  read-after-write query.
- The semantic-body limits are currently **10,000** characters for project comments
  (`COMMENT_BODY_MAX_LENGTH`, `portal/workers/app/src/routes/project-comments.ts:15`) and
  **2,000** for notice-board posts (`NOTICE_BODY_MAX_LENGTH`,
  `portal/workers/app/src/routes/notice-board.ts:17`). A common 400-character email excerpt will
  therefore naturally show more notice-board posts in full, without a surface-specific rule.
- The user explicitly settled this as an **email-only** enrichment. The in-app notification bell
  (`portal/apps/web/src/components/Topbar.tsx`) remains unchanged and continues to render the
  existing generic notification-row body, not the author or excerpt.
- The authenticated user already supplies the author display name at every caller:
  `SessionUser` includes `name` (`portal/workers/app/src/env.ts:30`), project-comment create/edit
  read `currentUser` before calling `notifyMentions()` (`project-comments.ts:83`, `:97`), and
  notice-board create/edit read `user` (`notice-board.ts:85`, `:103`). For project comments,
  the already-completed access/existence lookup returns the project's `street`
  (`project-comments.ts:32-35`, used before both calls at `:80` and `:94`). No author or project
  lookup is needed for this feature.
- `emitNotifications()` currently receives optional `link` and renders its generic `copy.body`
  unescaped into both email formats (`portal/packages/db/src/notifications.ts:77-87`, `:130-138`).
  Project-comment mentions already get the collaboration link; notice-board mentions intentionally
  get `undefined` because they have no project (`portal/workers/app/src/lib/notifications.ts:113-129`).
- `richTextPlainText()` is already the canonical rich-text-to-plain-text operation in
  `portal/packages/shared/src/rich-text.ts:129-138`, and `@quincy/shared` is exported to the app
  worker (`portal/packages/shared/src/index.ts:13`). It renders hard breaks, blocks, and list
  items with newlines; bullet/numbered lists deliberately become bare newline-separated lines
  without markers. That lossy list presentation is existing `richTextPlainText()` behaviour and
  is acceptable in both plain-text and HTML email excerpts, not a defect to solve here.
- `portal/workers/app/src/lib/r2s3.ts:31-33` has a non-exported `xmlEscape()` that escapes the
  same five characters, but it is XML-specific and Worker-local. It cannot be reused from
  `@quincy/db` without creating the wrong package dependency direction, so a small local
  `escapeHtml()` at the DB email boundary remains the appropriate helper. The other nearby
  `escape` use is SQL `LIKE ... ESCAPE` in
  `portal/workers/app/src/routes/mentionable-users.ts:32`, not output escaping.

## Design

### One shared excerpt rule; HTML formatting stays at the email boundary

Add `MENTION_EMAIL_EXCERPT_MAX_LENGTH = 400` and a named
`truncateForEmail(text: string): string` helper in a new,
clearly-purpose-named `portal/packages/shared/src/email-text.ts`, then export it from
`portal/packages/shared/src/index.ts`. No existing small shared string-utilities module exists.
This pure string helper deliberately accepts the already-derived plain text (`prepared.body`), not
a `RichTextDoc`: both routes already compute and persist
`richTextPlainText(normalizedContent).trim()` as `prepared.body`
(`project-comments.ts:47-48`; `notice-board.ts:57-59`). The excerpt is consequently a provable
prefix of the actual stored `body` column, needs no rich-text fixtures, and does not add a
`RichTextDoc`/rich-text import to `workers/app/src/lib/notifications.ts`.

The helper must:

1. return its input unchanged when it is at or under 400 UTF-16 code units; and
2. when it is longer, take at most the first 399 UTF-16 code units, then append `…`, so the
   delivered excerpt is at most 400 code units including a single trailing ellipsis. After taking
   that prefix, inspect `prefix.charCodeAt(398)`; if it is in the high-surrogate range
   `0xD800`–`0xDBFF`, drop its final character before appending `…`. This boundary result may be
   399 code units, but must never contain a lone surrogate.

The helper is deliberately not grapheme-cluster-aware: ZWJ sequences, skin-tone modifiers, and
combining marks may still split mid-grapheme. Avoiding a lone surrogate (which can break downstream
UTF-8 encoding at the email provider) is the correctness-critical goal; mid-grapheme splitting is
cosmetic and out of scope.

Four hundred characters is a useful email-preview-sized cap: enough context for a short staff
message while keeping a 10,000-character project comment out of an email. This is intentionally
one common rule for both surfaces, not a new HTML renderer or per-surface cap.

The excerpt helper belongs in shared because it is a generic, dependency-free string operation
used by the app Worker. Conversely, add a small non-exported `escapeHtml(value: string)` and a
non-exported mention-email formatter to `portal/packages/db/src/notifications.ts`, adjacent to
`emitNotifications()`, because that is the sole HTML-email interpolation boundary. This placement
follows where the HTML is constructed, not a claim about `@quincy/db`'s declared dependencies.

`escapeHtml` must be one regex pass —
`value.replace(/[&<>"']/g, ...)` — not sequential `.replace()` calls. Use exactly these mappings:
`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, and `'` → `&#39;`. The apostrophe mapping
intentionally differs from Worker-local `xmlEscape()` (`r2s3.ts:31-33`), which uses `&apos;`:
`&#39;` is reliable in legacy HTML mail renderers, including Outlook's Word-based renderer. Truncate
in shared **before** escaping in DB, never after: escaping expands characters such as `&` to
`&amp;`, so post-escape truncation could cut an entity in half.

### Structured mention-email input

Extend `EmitNotificationInput` in `portal/packages/db/src/notifications.ts:77-87` with one
optional field parallel to the existing optional `link` field:

```ts
mentionEmail?:
  | {
      scope: "project-comment";
      authorName: string;
      projectLabel: string;
      excerpt: string;
    }
  | {
      scope: "notice-board";
      authorName: string;
      excerpt: string;
    };
```

Keep `title`, notification-row `body`, recipient selection, idempotent `sourceKey`, and
`EMAIL_ENABLED_EVENTS` unchanged. `mentionEmail` is only supplied for the two `mentioned` scopes;
all other notification types retain the present generic email construction. The DB formatter uses
this structured value rather than asking callers to concatenate unescaped HTML, which keeps
escaping local and makes it impossible to lose one of the author/excerpt fields at one scope.

When `mentionEmail` is present, `emitNotifications()` (or its local formatter) must take a
dedicated branch that constructs both `text` and `html` from the structured fields plus optional
`link`; it **must not** fall through to the current generic `<p>${copy.body}</p>` construction.
The formatter trusts `mentionEmail` unconditionally whenever it is supplied: its `scope` selects
the prose even if `type` is not `mentioned` or its scope disagrees with `projectId`; an optional
`link` still controls the existing link block. Callers are solely responsible for supplying it
only at the two trusted mention call sites, and it is never user-input-driven.

Before every dynamic `html` interpolation, pass the author name, project label, and, when present,
`link` through `escapeHtml`. For the excerpt specifically, use this exact ordering:

```ts
const htmlExcerpt = escapeHtml(mentionEmail.excerpt).replace(/\n/g, "<br />");
```

Escaping must happen **before** inserting `<br />`; reversing the order escapes the inserted tag
and renders it literally. This preserves hard-break/block/list line breaks in HTML just as the
`text` body preserves `\n`. The link is server-constructed from `APP_ORIGIN` plus
`staffPathFor(route)` (`portal/workers/app/src/lib/notifications.ts:116-117`), whose project path
uses an `encodeURIComponent`'d validated UUID (`portal/packages/shared/src/staff-routes.ts:66-71`),
so escaping its `href` is correct hygiene (and handles a literal `&` in any future query string),
not a fix for a live vulnerability. If `link`, or a future URL value, ever becomes caller- or
user-supplied, HTML escaping alone is insufficient: also require an `http:`/`https:` scheme
allowlist because escaping does not neutralize `javascript:` or `data:` href schemes.

For a project comment, use this text body (then append the existing absolute link separated by two
newlines):

```text
Jane Smith commented on 12 Brompton Street:

“Please keep the front elevation crop a little wider.”

https://quincy.flamingfire.my/projects/a8e4de33-6a80-4f61-93bd-90c9b7c87654?collaboration=open
```

Its HTML equivalent is structurally:

```html
<p>Jane Smith commented on 12 Brompton Street:</p><p>“Please keep the front elevation crop a little wider.”</p><p><a href="https://quincy.flamingfire.my/projects/a8e4de33-6a80-4f61-93bd-90c9b7c87654?collaboration=open">View project</a></p>
```

For a notice-board mention, retain the current no-project/no-link behaviour but replace the generic
sentence with:

```text
Jane Smith mentioned you in a notice-board post:

“Please bring the floor-plan printouts to Friday’s meeting.”
```

```html
<p>Jane Smith mentioned you in a notice-board post:</p><p>“Please bring the floor-plan printouts to Friday’s meeting.”</p>
```

The email subject remains the existing `You were mentioned`. The examples show readable prose;
the actual formatter must escape the dynamic pieces before generating HTML, e.g. an author named
`Ava & <Co>` appears verbatim in `text` but as `Ava &amp; &lt;Co&gt;` in `html`. The static phrase and
the optional `View project` block remain DB-owned, preserving the existing `link` behaviour for
the projectId-less notice-board case.

### Route-to-notification plumbing

Extend the discriminated `notifyMentions()` input in
`portal/workers/app/src/lib/notifications.ts:91-96` to carry `body: string`, author name, and (for
project comments) project street — not a `RichTextDoc`. Import and call
`truncateForEmail(input.body)` there once per notification invocation, then pass the resulting
`mentionEmail` object to its sole `emitNotifications()` call (`notifications.ts:122-132`). The
helper is called before the per-mention loop because every recipient of the same created/edited
item sees the same content.

Update all four route call sites with data they already hold:

- Project-comment create at `portal/workers/app/src/routes/project-comments.ts:87`: pass
  `prepared.body`, `currentUser.name`, and `access.street` with the existing `projectId`.
- Project-comment edit at `project-comments.ts:103`: pass the newly normalized
  `prepared.body`, `currentUser.name`, and the already-loaded `access.street`; this means only
  recipients newly mentioned by that edit see the edited content, matching the current `added`
  trigger semantics.
- Notice-board create at `portal/workers/app/src/routes/notice-board.ts:92`: pass
  `prepared.body` and `user.name`.
- Notice-board edit at `notice-board.ts:121`: pass the edited `prepared.body` and `user.name`,
  again only for newly added mention mappings.

No new database query belongs in either route or in `notifyMentions()`: the route has both the
author display name and normalized body in memory, and only the project-comment route needs a
project label, already returned by its access check.

## Files touched

- `portal/packages/shared/src/email-text.ts` — new generic `truncateForEmail(text)` and its
  400-character limit constant. It operates only on already-trimmed plain text, truncates before
  any HTML escaping, and applies the exact high-surrogate boundary predicate; it does not parse or
  render rich text.
- `portal/packages/shared/src/index.ts` — export the new shared email-text helper.
- `portal/packages/shared/test/email-text.test.ts` — unit-test plain strings: under-limit,
  exactly-400, and over-limit inputs; and the emoji boundary
  (`"a".repeat(398) + "😀x"`) that would otherwise cut a high surrogate, asserting an at-most-400
  unit result with no lone surrogate. Include the documented non-goal that the helper need not
  preserve whole grapheme clusters.
- `portal/packages/db/src/notifications.ts` — add the discriminated optional `mentionEmail`
  input; add the one-pass, five-mapping local `escapeHtml` and dedicated formatter branch; preserve
  HTML newlines using `escapeHtml(excerpt).replace(/\n/g, "<br />")`; and retain existing row
  persistence, generic emails, and optional-link behavior.
- `portal/packages/db/src/notifications.test.ts` — assert project-comment and projectId-less
  notice-board formatted bodies; supply hostile values distributing all five characters
  `& < > " '` across author name, excerpt, and project label, and assert each is escaped in `html`
  but verbatim in `text`; supply a `link` containing both `&` and `"` and assert the `href` is
  escaped and cannot be broken out of; use a multiline excerpt to assert escaped-newline-then-
  `<br />` rendering (and no literal `&lt;br /&gt;`); retain/extend the linked versus unlinked
  regression case so notice-board output has no `View project` link or `href`; and add a
  branch-selection regression test proving `mentionEmail` produces enriched markup rather than
  the pre-existing generic `copy.body` HTML.
- `portal/workers/app/src/lib/notifications.ts` — extend `notifyMentions()`'s two scope inputs,
  truncate one supplied plain-text body, and pass structured mention context to
  `emitNotifications()` at its existing call site; no rich-text type/import is added here.
- `portal/workers/app/src/routes/project-comments.ts` — pass the already-held normalized body,
  current user name, and access lookup's project street at both existing mention calls; no new
  query and no trigger change.
- `portal/workers/app/src/routes/notice-board.ts` — pass the already-held normalized body and
  current user name at both existing mention calls; preserve absent `projectId` and link.
- `portal/workers/app/test/project-comments.test.ts` and
  `portal/workers/app/test/notice-board.test.ts` — add a leading/trailing-whitespace, at/under-
  limit rich-text input regression asserting the route's returned/stored `body` is trimmed. This
  verifies the `prepared.body` contract supplied to the truncator without giving the truncator a
  redundant second `.trim()` responsibility.
- `portal/workers/app/test/notifications.test.ts` — update the direct project-comment
  `notifyMentions()` invocation around line 182 for the extended input and assert its enriched,
  collaboration-link email output.
- `portal/workers/app/test/notice-board.test.ts` — update both direct `notifyMentions()` calls
  (currently around lines 44 and 61) for the extended notice-board input; turn the first call's
  existing email assertion into the no-link enriched-email regression test. The existing
  project-comment route integration test remains exercised by the normal app-worker suite; its
  changed internal call shape is compile-checked without inventing a second route-level email
  injection mechanism.

No migration, schema change, API shape change, frontend change, or new package dependency is
expected.

## Verification

Run the repository's standard pre-commit sequence from `portal/` after implementation:

1. `npm run typecheck`
2. `npm run build -w @quincy/web`
3. `npm run test --workspaces`
4. `npx vitest run --config packages/shared/vitest.config.ts`

Read the resulting diff and email-send assertions directly at the §5 gate. In particular verify
all specified shared-helper boundaries (including the already-trimmed input contract and the
emoji/surrogate boundary), escaped HTML versus verbatim plain text for body, author, and project
label, `href` escaping, newline-to-`<br />` ordering, the dedicated `mentionEmail` formatter
branch, project-comment link retention, and the projectId-less notice-board email's deliberate
absence of `href`/`View project`.

There is an intentional route-wiring coverage limit: the existing notice-board test creates a post
over HTTP, deletes its resulting notification, then directly re-invokes `notifyMentions()` with a
hand-built input to observe an email (`portal/workers/app/test/notice-board.test.ts:36-50`). The
real `EMAIL` binding is not simulated by the worker test pool, so no test observes the actual data
the HTTP routes pass into `notifyMentions()`; retain that direct-call boundary rather than invent a
new email-injection mechanism. At the §5 gate, manually read all four route call arguments to
confirm:

- each edit uses the editing user's live `currentUser`/`user` values, never a pre-edit stored
  `existing.authorName` or `existing.authorId`;
- each edit supplies the newly normalized `prepared.body`, never pre-edit content; and
- every call uses `prepared.body`, never the pre-normalization `parsed` document/body whose forged
  mention labels have not been replaced with real names.

These hazards all typecheck and can pass the full suite if wired incorrectly. A browser smoke test
is not required for this server-side email-body-only change; the direct `EMAIL.send` tests plus
these §5 source eyeball checks are the authoritative coverage.

## Rollout

This is a code-only, in-memory email-construction change: `project_comments.content_json` and
`notice_board_posts.content_json` already exist (`portal/packages/db/src/schema.ts:193-215` and
`:770-791`), so no D1 migration is expected. The implementation touches `@quincy/shared`,
`@quincy/db`, and the app Worker only; it does not touch the background or webhook-ingress Worker.
After the review pipeline and §5 gate, deploy the affected app Worker with the established order
consideration: if no background change is introduced, deploy `app` only; if review or
implementation legitimately adds background code, preserve the documented `background` then
`webhook-ingress` then `app` binding order. Commit/deploy only after the required reviews and user
confirmation.
