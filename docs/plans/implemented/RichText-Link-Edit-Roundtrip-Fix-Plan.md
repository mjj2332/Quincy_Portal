# Rich-Text Link Edit Round-Trip Fix — Plan

**Status: implemented and deployed to production (commit `f096b60`, `app` Worker version
`06c0aa98-583e-4830-bfab-60719a3b32a8`, deployed 2026-08-18).** Cleared the full
`docs/Subagent-Orchestration.md` §2 policy 1/2/3 sequence: Terra draft → fresh Terra review
(approved, one trivial citation-range fix applied directly) → Opus plan-tier review (approved, with
two non-blocking implementation notes folded into the plan below) → Terra build (confirmed the
regression by temporarily reverting the fix and watching the new test fail with a null href, then
restored it; typecheck, `apps/web` build, and every runnable test suite passed) → fresh Terra diff
review (approved, no correctness findings) → Opus final-draft review of the diff (approved,
independently re-ran the full verify sequence itself, two non-blocking nits noted only) → this
session's §5 gate (independently re-ran typecheck, the `@quincy/web` build, `npm run test
--workspaces`, and the `packages/shared` suite the root script skips — all green, 391 tests
passing including `worker-app`/`worker-background`, which Terra's own sandbox couldn't run due to
an environment `EPERM` restriction).

**Live verification, 2026-08-18:** reproduced the exact reported bug against the live project
(`projects/ec2d92bf-2340-458c-b1a3-c05c74904fd8`) before fixing, then re-checked after deploy —
clicking Edit on the real multi-link comment loaded all three Vimeo review links with correct
`href` values in the editable DOM (confirmed via direct DOM inspection, not just visually), a
harmless edit saved successfully with no validation-error banner, and the links and their exact
original URLs persisted after save. The test edit was reverted afterward to restore the comment's
original wording; only the link-mark handling was exercised, not the comment content.

## Current state — code inspection and drafting-time snapshot, 2026-08-18

The stored `RichTextDoc` contract deliberately represents a link mark as a flat object,
`{ type: "link", href: string }`, while mentions already carry their values in an `attrs`
object ([`portal/packages/shared/src/rich-text.ts:6-10`](../../portal/packages/shared/src/rich-text.ts#L6-L10)).
The server accepts only that flat link shape and rejects a missing/non-string href through
`httpUrl()` ([`rich-text.ts:38-44`](../../portal/packages/shared/src/rich-text.ts#L38-L44)) and
`parseMarks()` ([`rich-text.ts:46-60`](../../portal/packages/shared/src/rich-text.ts#L46-L60)).

`RichTextEditor` currently passes the stored document to TipTap through a JSON deep clone only
([`portal/apps/web/src/components/RichTextEditor.tsx:10`](../../portal/apps/web/src/components/RichTextEditor.tsx#L10)),
both when the editor is created ([`RichTextEditor.tsx:72-75`](../../portal/apps/web/src/components/RichTextEditor.tsx#L72-L75))
and when an external value is loaded later ([`RichTextEditor.tsx:98-103`](../../portal/apps/web/src/components/RichTextEditor.tsx#L98-L103)).
The reverse conversion already recursively rebuilds the portable document and maps a TipTap
link's `attrs.href` back to the stored flat `href` ([`RichTextEditor.tsx:23-39`](../../portal/apps/web/src/components/RichTextEditor.tsx#L23-L39));
every edit serializes through that conversion in `onUpdate`
([`RichTextEditor.tsx:91-94`](../../portal/apps/web/src/components/RichTextEditor.tsx#L91-L94)).

Consequently, an existing stored link is loaded with no TipTap `attrs.href`, TipTap supplies its
default null href, and the next update sends a flat `{ type: "link", href: null }` mark. The
project-comment PATCH route treats the shared-parser failure as invalid content and returns 400
([`portal/workers/app/src/routes/project-comments.ts:92-105`](../../portal/workers/app/src/routes/project-comments.ts#L92-L105));
the project UI exposes that request through its edit save path
([`portal/apps/web/src/components/ProjectCollaborationPanel.tsx:81-91`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx#L81-L91)).

This is one shared-editor defect, not a project-comments-only defect. The notice-board Edit path
also loads stored content into `RichTextEditor` and PATCHes the result
([`portal/apps/web/src/components/NoticeBoard.tsx:54-75`](../../portal/apps/web/src/components/NoticeBoard.tsx#L54-L75)).
The read-only `RichTextContent` renderer is not in the failing round trip: it consumes the stored
flat `mark.href` directly ([`portal/apps/web/src/components/RichTextContent.tsx:4-16`](../../portal/apps/web/src/components/RichTextContent.tsx#L4-L16)).

Mentions have been checked and are **not broken**: their stored
`{ type: "mention", attrs: { id, label } }` shape already matches the TipTap attrs convention,
and the existing reverse conversion explicitly retains that shape
([`RichTextEditor.tsx:32-35`](../../portal/apps/web/src/components/RichTextEditor.tsx#L32-L35)).
They require no input-side conversion.

The appropriate automated-test home already exists: the component is mounted through the real
happy-dom/TipTap path in
[`portal/apps/web/src/components/RichTextEditor.dom.test.tsx:17-30`](../../portal/apps/web/src/components/RichTextEditor.dom.test.tsx#L17-L30),
including an existing editor-schema round-trip regression test
([`RichTextEditor.dom.test.tsx:138-148`](../../portal/apps/web/src/components/RichTextEditor.dom.test.tsx#L138-L148)).
The web workspace runs Node and happy-dom suites together
([`portal/apps/web/package.json:5-10`](../../portal/apps/web/package.json#L5-L10)); the latter
includes `*.dom.test.tsx` files
([`portal/apps/web/vitest.dom.config.ts:1-4`](../../portal/apps/web/vitest.dom.config.ts#L1-L4)).

## Scope and non-goals

In scope: the input conversion in the shared web editor and its focused DOM regression test.
The same change protects both project comments and notice-board posts because both already use
that component.

Explicitly out of scope: changing the portable `RichTextDoc` wire/storage contract, changing
server validation or either API route, changing the read-only renderer, adding a migration or
backfilling data, redesigning link UX, or changing mention behavior. No document that has already
been successfully saved needs repair: the server only persists the valid flat-href contract.

## Proposed change

1. Update [`portal/apps/web/src/components/RichTextEditor.tsx`](../../portal/apps/web/src/components/RichTextEditor.tsx)
   so `toTiptap()` produces a fresh recursively copied document instead of a JSON-only clone.
   While descending through every node's `content` array, map each text node's `marks` array:

   - Convert a stored `{ type: "link", href }` mark to TipTap's
     `{ type: "link", attrs: { href } }` representation before it reaches `useEditor()` or
     `editor.commands.setContent()`.
   - Copy `bold` and `italic` marks unchanged.
   - Preserve mention nodes and their existing `attrs` unchanged; no mention-specific conversion
     belongs in this fix.
   - Preserve the existing non-mutating behavior by creating new arrays/objects rather than
     rewriting React state passed as `value`.

   Keep the two directions symmetric but explicit rather than introducing one generic
   mark-shape helper. The stored-to-TipTap direction has one narrowly scoped adaptation for a
   typed, trusted `RichTextDoc`; the TipTap-to-stored direction must deliberately discard
   editor-only data and rebuild the server contract. Combining them would make those distinct
   responsibilities less clear and would enlarge a two-line-format fix unnecessarily.

2. Extend
   [`portal/apps/web/src/components/RichTextEditor.dom.test.tsx`](../../portal/apps/web/src/components/RichTextEditor.dom.test.tsx)
   with a full loaded-link round-trip test, alongside the existing schema round-trip coverage.
   Start from a `RichTextDoc` containing a linked text run with a fixed HTTPS URL and a mention
   in the same paragraph. Mount `RichTextEditor`, which exercises
   `toTiptap()` and TipTap/ProseMirror initialization; assert the editing DOM has an anchor with
   that exact href. Then use the suite's existing input-event style to make a harmless edit
   outside the linked text and assert the emitted `onChange` document exactly matches the stored
   contract: the original link remains `{ type: "link", href: originalUrl }` (not `attrs.href`,
   null, or omitted), and the mention attrs are unchanged. This directly covers the previously
   failing load → edit → `tiptapToRichTextDoc()` path without exporting private conversion helpers
   solely for tests.

   **Implementation note (from Opus plan-tier review):** if the "harmless edit outside the linked
   text" is placed inside a list item and triggered via Shift+Enter, `ListItemHardBreak`
   ([`RichTextEditor.tsx:16`](../../portal/apps/web/src/components/RichTextEditor.tsx#L16)) swallows
   the key outside a `listItem` and no `onUpdate` fires. Use the suite's existing `list()` test
   helper (as the current schema round-trip test at `RichTextEditor.dom.test.tsx:138-148` does), or
   drive the edit via `typeAfterCurrentContent` instead of Shift+Enter.

## Test and verification plan

From `portal/`, run the required repository checks after implementation:

```sh
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

The new happy-dom assertion is the regression gate for the link-shape translation. No Worker
test change is required because the server contract and route behavior remain unchanged; the
shared-package suite continues to cover the flat-link validation contract.

After deployment, perform two controlled production checks with a user allowed to author and
edit both items. Use disposable content and remove it afterward where appropriate.

1. On a project detail page, create a project comment containing an HTTPS link. Reload, click
   **Edit**, make a small non-link change, and save. The link must remain visibly underlined and
   recognized as a link while editing, Save must complete without the invalid-content banner, and
   a reload must show the original URL as a working read-only link. The editor intentionally has
   `openOnClick: false` ([`RichTextEditor.tsx:69`](../../portal/apps/web/src/components/RichTextEditor.tsx#L69)),
   so navigation is verified after save in the read-only renderer rather than by opening a tab
   from the editable surface.
2. Repeat the same create → reload → Edit → non-link change → Save → reload flow for a notice
   board post, then delete the disposable post. Confirm the link remains rendered as a working
   read-only link after the edit.

## Rollout and recovery

This is a frontend source fix only: no D1 migration, data migration, shared-contract change, or
API/Worker route change is involved. The affected bundle is nevertheless served in production by
the `app` Worker's `ASSETS` binding, which points at `apps/web/dist`
([`portal/workers/app/wrangler.jsonc:10-15`](../../portal/workers/app/wrangler.jsonc#L10-L15)) and
is the app's SPA fallback ([`portal/workers/app/src/index.ts:81-85`](../../portal/workers/app/src/index.ts#L81-L85)).
There is no independent `apps/web` hosting deploy.

Build the web workspace, then deploy **only** the app Worker:

```sh
npm run build -w @quincy/web
cd portal/workers/app
npx wrangler deploy
```

Do not deploy `background` or `webhook-ingress`; neither codebase nor its binding contract
changes. If an unexpected regression appears, redeploy the immediately preceding app Worker
version. Stored content needs no rollback or repair because this release changes only the
browser-side adapter.

Once the implementation is built, fully verified, committed, and the production checks pass,
update this status line with the commit hash and deploy outcome, then move this plan to
`docs/plans/implemented/` with `git mv` per the repository plan lifecycle.
