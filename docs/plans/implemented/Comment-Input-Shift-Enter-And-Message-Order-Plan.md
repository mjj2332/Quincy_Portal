# Comment Input Shift+Enter and Message Order — Plan

> **Status: IMPLEMENTED — both features built, gate-verified, committed, and deployed to
> production, per this plan's own Sequencing section requiring two separate, isolated deploys.**
> Feature B (newest-first project comments) shipped first, commit `d1d6bd3`. Feature A (Shift+Enter
> soft breaks) shipped second in the next commit on `main` — both deployed via `portal/workers/app`'s
> `wrangler deploy` on 2026-08-17. Each feature went through its own
> build → fresh-Terra-diff-review → Opus-final-draft-review → independent §5 gate before deploying;
> Feature A's Opus diff review additionally hand-traced the mention-after-break and edit-round-trip
> tests against the real editor/parser code to confirm they genuinely fail without their respective
> fixes.
>
> Drafted by Terra, two fresh Terra
> review rounds (round 1 found and fixed 4 issues; round 2 approved with no findings), then three Opus
> plan-tier review rounds per `docs/Subagent-Orchestration.md` §2 policy 1: round 1 found one blocking
> issue (the original server-side `hardBreak` gate mirrored the client's list-item-only keyboard
> constraint, but the schema doesn't enforce it — paste, list-toggle-off, and backspace-lift could all
> put a hard break in a top-level paragraph and hit an unrecoverable 400), fixed by dropping the gate;
> round 2 found a persisted-data rollback gap, fixed; round 3 (after the two-revert budget was used up)
> found one real functional regression — registering the `hardBreak` node would silently break
> `@`-mention autocomplete immediately after a soft break, since the mention lookup's leaf-text
> separator doesn't match its own regex's whitespace check — plus five smaller findings, all fixed
> directly in this document per policy 1's terminal case, then confirmed by a fresh Opus self-review.
> No migration is required: the current migration maximum is `0028`, but neither change alters storage.

## Source and scope

This plan covers:

1. List-item-only `Shift+Enter` soft line breaks in the shared rich-text editor used by [`RichTextEditor.tsx`](../../portal/apps/web/src/components/RichTextEditor.tsx), therefore covering both project comments and the notice board.
2. Newest-first project comments, while retaining the notice board's already-correct newest-first behavior.

The editor change also requires extending the shared rich-text trust boundary and renderer: `hardBreak` currently cannot survive submission because [`rich-text.ts`](../../portal/packages/shared/src/rich-text.ts:9) permits only text and mention inline nodes, while [`tiptapToRichTextDoc`](../../portal/apps/web/src/components/RichTextEditor.tsx:12) would already preserve an unrecognised Tiptap node as `{ type: "hardBreak" }`.

## Sequencing

Land Feature B (newest-first project comments) first, in its own commit and deploy. It is a pure, fully reversible ordering flip that touches no shared code. Land Feature A (Shift+Enter/`hardBreak`) second, in its own separate commit and deploy: it registers a node in the shared ProseMirror schema and widens the shared rich-text trust boundary that guards stored documents on both surfaces (project comments and notice board), so it needs isolation. In particular, [`notice-board.ts`](../../portal/workers/app/src/routes/notice-board.ts:21) catches `parseRichTextDoc` failures on its read path and falls back to `legacyBodyToRichTextDoc`; a parser regression would therefore present to users as formatting having vanished rather than as a visible error. Isolating Feature A makes that regression straightforward to identify and roll back without also rolling back Feature B.

That rollback is clean only before the first `hardBreak` is persisted. The notice-board read path re-parses stored JSON on every GET and falls back at [`notice-board.ts` line 24](../../portal/workers/app/src/routes/notice-board.ts:24), so reverting the parser after a post contains a hard break would flatten that post's entire rich document into the legacy single paragraph: bullets, ordered lists, links, mention chips, and the break are all lost. Project-comment reads instead use bare `JSON.parse` in [`serializeComment`](../../portal/workers/app/src/routes/project-comments.ts:52), so they still succeed, but `RichTextContent`'s unrecognised-inline fallback renders nothing useful for the hard-break segment and any later PATCH of that round-tripped document receives a 400 when validation rejects it. On both surfaces the author-edit path degrades worse than the read path: opening the edit composer feeds the stored JSON to `setContent`, which calls `schema.nodeFromJSON` and throws `Unknown node type: hardBreak` once the node is no longer registered; Tiptap catches that, logs `[tiptap warn]: Invalid content`, and substitutes an empty document, so the edit composer opens blank over the author's own post — inviting them to retype it — before any 400 is ever surfaced. Once Feature A is live and any hard break has been stored, prefer a roll-forward fix and redeploy over a revert.

## 1. List-item-only Shift+Enter soft breaks

[`RichTextEditor.tsx`](../../portal/apps/web/src/components/RichTextEditor.tsx:55) currently configures StarterKit with `hardBreak: false`. Its `editorProps.handleKeyDown` first gives [`MentionAutocomplete`](../../portal/apps/web/src/components/MentionAutocomplete.tsx:29) the key event, then handles Cmd/Ctrl+Enter submission, and otherwise returns `false` ([lines 65–76](../../portal/apps/web/src/components/RichTextEditor.tsx:65)). Keep that ordering unchanged.

The installed Tiptap version is 2.27.2. Its `HardBreak` extension provides `editor.commands.setHardBreak()` and normally binds both `Mod-Enter` and `Shift-Enter`; use `HardBreak.extend()` to replace those default shortcuts rather than enabling StarterKit's globally-bound version.

- Add the directly declared, pinned dependency `"@tiptap/extension-hard-break": "2.27.2"` to [`portal/package.json`](../../portal/package.json:21), and update [`portal/package-lock.json`](../../portal/package-lock.json). Although it is currently present transitively through StarterKit, this component imports and configures it directly.

- In [`RichTextEditor.tsx`](../../portal/apps/web/src/components/RichTextEditor.tsx:1), import `HardBreak` and define this extension beside the existing helpers:

  ```ts
  const ListItemHardBreak = HardBreak.extend({
    addKeyboardShortcuts() {
      return {
        "Shift-Enter": () => {
          if (!this.editor.isActive("listItem")) return true;
          return this.editor.commands.setHardBreak();
        },
      };
    },
  });
  ```

- Leave `hardBreak: false` in the [`StarterKit.configure`](../../portal/apps/web/src/components/RichTextEditor.tsx:55) options, then append `ListItemHardBreak` to the memoized `extensions` array after StarterKit. This supplies the `hardBreak` node and `setHardBreak` command, but replaces the upstream global shortcut map with the one scoped shortcut above.

  `editor.isActive("listItem")` checks the selection's active node ancestry, so it is true inside either StarterKit-enabled `bulletList → listItem` or `orderedList → listItem`. The editor has paragraphs and those two list types enabled; headings, blockquotes, code blocks, and horizontal rules are explicitly disabled. Outside a list item the handler returns `true` to make the no-op explicit and observable in tests, including the happy-dom harness where ProseMirror's native capture path does not behave like a real browser.

- Do not add a `Mod-Enter` hard-break binding. Cmd/Ctrl+Enter remains handled first by `editorProps.handleKeyDown`; it will still submit valid content and return `true`. The mention menu remains first in that handler, so its existing Enter-to-select behavior is untouched: because `MentionAutocomplete` matches `event.key === "Enter"` without a `shiftKey` check, an open suggestion popup also consumes Shift+Enter to select the highlighted mention before `ListItemHardBreak` can run. This is intentional; the mention path remains unchanged.

- Update `mentionQuery` in [`RichTextEditor.tsx`](../../portal/apps/web/src/components/RichTextEditor.tsx:29) to pass a function `leafText` instead of the bare `"\0"`: `(node) => node.type.name === "hardBreak" ? "\n" : "\0"`. `hardBreak` is an inline **leaf**, so `doc.textBetween`'s `blockSeparator` never applies to it and the current literal `"\0"` would land between the break and a following `@`. Because `\0` is not in JS `\s`, the `/(?:^|\s)@([^\s@]*)$/u` probe would fail and the mention popup would never open for an `@` typed immediately after a soft break — a regression against today's plain-Enter behavior, which yields `"\n"`. Keep `"\0"` for every other leaf: it is what stops an `@` abutting an existing mention chip from retriggering the popup. `prosemirror-model` 1.25.11 supports the callback form of `leafText`.

- Extend the portable document contract in [`portal/packages/shared/src/rich-text.ts`](../../portal/packages/shared/src/rich-text.ts):

  - Add `RichTextHardBreak = { type: "hardBreak" }` to `RichTextInline`.
  - Update `parseInline` to accept only `{ type: "hardBreak" }` with no extra attributes.
  - Accept `hardBreak` in any paragraph, including a top-level paragraph. The server trust boundary must validate the safe portable document contract, not enforce the editor's keyboard-only UI affordance. Registering the node widens paste as well as typing, in two ways that both produce a **top-level** break: `HardBreak.parseHTML()` is `[{ tag: 'br' }]`, so pasted HTML `<br>`s (Gmail, Word, most web pages) — today silently dropped because the node is absent from the schema — become real nodes; and `HardBreak` sets `linebreakReplacement: true`, which makes `prosemirror-model` turn embedded newlines into that node inside preserve-whitespace content such as `<pre>` or `white-space: pre`. Lifting a list item out of its list produces the same shape. A list-item-gated server rule would therefore reject an ordinary paste with a 400 the user cannot diagnose or repair. Do not add or reuse list-item context in `parseInline` or `parseBlock` for this purpose.
  - Make plain-text derivation emit `"\n"` for a hard break. The edit is in the `textFromBlock` helper's paragraph branch, not in `richTextPlainText` itself: its current `node.type === "text" ? node.text : node.attrs.label` would read `attrs` off a break node. This makes body derivation and the character counters on both surfaces represent the visual line break.
  - Make `richTextMentionIds` ignore hard breaks and make `normalizeRichTextMentionLabels` copy them unchanged.

- Update [`RichTextContent.tsx`](../../portal/apps/web/src/components/RichTextContent.tsx:13) so `inline()` renders `hardBreak` as `<br key={index} />`; it currently treats every non-mention inline node as text. This makes persisted soft breaks render identically in project comments and notice-board posts.

No surface-specific extension or keyboard override exists in [`ProjectCollaborationPanel.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx:92) or [`NoticeBoard.tsx`](../../portal/apps/web/src/components/NoticeBoard.tsx:75); both instantiate the same `RichTextEditor`, so no duplicate editor configuration is needed.

## 2. Newest-first messages

### Project comments

[`project-comments.ts`](../../portal/workers/app/src/routes/project-comments.ts:73) already queries comments in descending `createdAt`, then descending `id` order. It derives `oldest` from `rows.at(-1)` before serializing, but reverses the result at [line 75](../../portal/workers/app/src/routes/project-comments.ts:75):

```ts
return c.json({ project: access, comments: rows.reverse().map(serializeComment), ...(oldest && rows.length === (parsed.data.limit ?? MAX_LIMIT) ? { nextCursor: encodeCursor(oldest) } : {}) });
```

Remove only `.reverse()`, returning `rows.map(serializeComment)`. The cursor remains correct: each descending page's final row is its oldest item, so it is precisely the cursor needed by the `before` predicate for the next, older page.

Beyond the panel component's own initial fetch at [`ProjectCollaborationPanel.tsx` line 58](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx:58), [`ProjectWorkspace.tsx`](../../portal/apps/web/src/screens/ProjectWorkspace.tsx:167) is the additional production consumer: it fetches the response for the collaboration-only fallback and passes it unchanged as `initialComments`. It performs no sort or order-dependent transformation, so the backend change safely makes that fallback newest-first as well.

Update [`ProjectCollaborationPanel.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx):

- In `load()` at [line 60](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx:60), change older-page insertion from:

  ```ts
  before ? [...(response.comments ?? []), ...current] : (response.comments ?? [])
  ```

  to:

  ```ts
  before ? [...current, ...(response.comments ?? [])] : (response.comments ?? [])
  ```

  The initial API page is newest-first; subsequent pages are older and therefore append below it.

- In `submit()` at [line 82](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx:82), change:

  ```ts
  setComments((current) => [...current, comment]);
  ```

  to:

  ```ts
  setComments((current) => [comment, ...current]);
  ```

  This places a newly posted comment at the visible top immediately.

- Move the `nextCursor` "Load older comments" button currently rendered before `.project-collaboration__comments` at [line 91](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx:91) to immediately after that list. Keep its label, disabled/loading state, and `load(nextCursor)` callback unchanged.

- Leave the composer exactly where it is: after the comment list and the relocated older-comments button ([line 93](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx:93)). No unread state exists in this component.

### Notice board: explicitly no production change

No ordering implementation change is needed for the notice board.

- [`notice-board.ts`](../../portal/workers/app/src/routes/notice-board.ts:71) queries descending `createdAt`/`id` and returns `rows.map(serializePost)` unchanged at [line 72](../../portal/workers/app/src/routes/notice-board.ts:72).
- [`NoticeBoard.tsx`](../../portal/apps/web/src/components/NoticeBoard.tsx:47) stores the API order directly, renders `posts.map(...)` at [line 73](../../portal/apps/web/src/components/NoticeBoard.tsx:73), and prepends newly posted items at [line 54](../../portal/apps/web/src/components/NoticeBoard.tsx:54).
- There is no second sort or alternate post render path. Its `seenId`/`latestId` localStorage unread logic is notice-board-only and remains untouched.
- Do not add notice-board pagination; it remains a flat, limited list with no cursor.

## Files touched

- [`portal/package.json`](../../portal/package.json)
- [`portal/package-lock.json`](../../portal/package-lock.json)
- [`portal/apps/web/src/components/RichTextEditor.tsx`](../../portal/apps/web/src/components/RichTextEditor.tsx)
- [`portal/apps/web/src/components/RichTextContent.tsx`](../../portal/apps/web/src/components/RichTextContent.tsx)
- [`portal/apps/web/src/components/RichTextEditor.dom.test.tsx`](../../portal/apps/web/src/components/RichTextEditor.dom.test.tsx) — new
- [`portal/apps/web/src/components/ProjectCollaborationPanel.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx)
- [`portal/apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx)
- [`portal/apps/web/src/components/NoticeBoard.dom.test.tsx`](../../portal/apps/web/src/components/NoticeBoard.dom.test.tsx)
- [`portal/packages/shared/src/rich-text.ts`](../../portal/packages/shared/src/rich-text.ts)
- [`portal/packages/shared/test/rich-text.test.ts`](../../portal/packages/shared/test/rich-text.test.ts)
- [`portal/workers/app/src/routes/project-comments.ts`](../../portal/workers/app/src/routes/project-comments.ts)
- [`portal/workers/app/test/project-comments.test.ts`](../../portal/workers/app/test/project-comments.test.ts)
- [`portal/workers/app/test/notice-board.test.ts`](../../portal/workers/app/test/notice-board.test.ts)

[`NoticeBoard.tsx`](../../portal/apps/web/src/components/NoticeBoard.tsx) and [`portal/workers/app/src/routes/notice-board.ts`](../../portal/workers/app/src/routes/notice-board.ts) are confirmed no-change files.

## Test coverage

- Add a new [`RichTextEditor.dom.test.tsx`](../../portal/apps/web/src/components/RichTextEditor.dom.test.tsx) suite; none currently exists. Render `RichTextEditor` with a list-shaped `value` prop, whose initial selection lands at the start of the first list item's paragraph, dispatch Shift+Enter, and assert the exact `onChange` payload: the list still has exactly one `listItem`, and that paragraph's content is exactly `[{ type: "hardBreak" }, { type: "text", text: "original text" }]` for an initial item whose text is `original text`. This deliberately tests a caret at position 0, so the expected order is break-then-text rather than a break in the middle of the text. Do not drive this through raw DOM text mutation—the existing `NoticeBoard.dom.test.tsx` helper assigns `editor.textContent` wholesale and cannot represent a mid-text caret; the initial `value` prop plus a dispatched keydown is the working mechanism in this test harness. For Shift+Enter in a top-level paragraph, dispatch a `cancelable: true` keydown and assert directly that `defaultPrevented === true` as well as that the document is unchanged, making the explicit no-op observable in this harness. These payload assertions must be strict rather than loose: [`docs/lessons.md`](../lessons.md:553) records that “a loose `expect.objectContaining`/`arrayContaining` test assertion passed anyway” through a real editor-corruption bug, and its rule is to “test this class of interception with a strict/exact assertion on the resulting document.” Include coverage that plain Enter still creates a list item and that Enter on an empty list item exits the list. Also assert that Cmd/Ctrl+Enter on empty or over-limit content neither submits nor inserts a hard break, protecting the intentional decision not to bind `Mod-Enter` in `ListItemHardBreak`. Also cover the mention probe across a soft break: in a list item, dispatch Shift+Enter, then type `@` and assert the mention lookup fires (`loadMentionables` called) and the listbox renders — this is the assertion that fails without the `mentionQuery` `leafText` callback fix above.

- Add an edit round-trip case to that suite: mount `RichTextEditor` with a stored list-item-hard-break document as the `value` prop — the same `toTiptap` → `setContent` path both edit composers take — then assert `onChange` reproduces the break unchanged through `getJSON` → `tiptapToRichTextDoc`. This is the case that fails if `hardBreak` is missing from the schema, because `schema.nodeFromJSON` throws and Tiptap silently substitutes an empty document.

- Extend [`rich-text.test.ts`](../../portal/packages/shared/test/rich-text.test.ts) to accept and round-trip hard breaks in both a list-item paragraph and a plain top-level paragraph, derive their plain-text newlines, ignore them during mention extraction/normalisation, and reject attributes on the node.

- Extend the existing rich-list rendering test in [`NoticeBoard.dom.test.tsx`](../../portal/apps/web/src/components/NoticeBoard.dom.test.tsx:224) with a `hardBreak` inside a list paragraph and assert the rendered notice contains `<br>`. Keep its existing keyboard mention tests ([lines 268–323](../../portal/apps/web/src/components/NoticeBoard.dom.test.tsx:268)) and Cmd/Ctrl+Enter test ([lines 325–338](../../portal/apps/web/src/components/NoticeBoard.dom.test.tsx:325)) unchanged as regressions for input priority and submission.

- Extend [`project-comments.test.ts`](../../portal/workers/app/test/project-comments.test.ts:39): rename its ascending-order assertion and update expected pages to newest-first—full page `[third, second, first]`, first limited page `[third, second]`, then older page `[first]`. This proves the cursor still points from the page's oldest row to the next older page. Add a valid list-with-hard-break post case so the project-comments endpoint accepts the new shared document contract.

- Add a new case to [`notice-board.test.ts`](../../portal/workers/app/test/notice-board.test.ts:98), alongside the existing legacy/newest-first test rather than inside it (that test's `posts[0]` assertion depends on its own future-dated fixture): POST a valid list-with-hard-break payload, then GET the post list and assert the returned `content` for that id preserves the break. Do not stop at the POST's `201 Created` response: the GET exercises stored-content re-parsing, including the fallback-prone read path. No ordering expectation changes because the endpoint already returns the required order.

- Extend [`ProjectCollaborationPanel.dom.test.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx:157) with a newest-first fixture and cursor-bearing second page. Assert that a posted comment becomes the first rendered article, clicking "Load older comments" appends the older response after the existing articles, and the load button is after `.project-collaboration__comments` while the compose form remains below both.

## Verification

From `portal/`, run the required repository verification sequence:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Also manually verify in a browser on both project comments and the notice board:

- Shift+Enter inside bullet and ordered list items inserts a visible line break without adding another bullet/number.
- Shift+Enter in a plain paragraph does nothing.
- Plain Enter still creates/exits list items normally, Cmd/Ctrl+Enter submits, and an open mention menu still consumes Enter to select.
- With the mention suggestion popup open, Shift+Enter selects the highlighted mention rather than inserting a hard break.
- Inside a list item, press Shift+Enter and then type `@` as the first character on the new visual line — the mention menu must still open and selection must still work.
- Paste HTML containing a `<br>` (for example, copy two lines from an email) into an empty composer paragraph on both surfaces, then post it. It must submit successfully — not 400 — and render the break. This exercises the deliberately ungated server rule on its most common real input.
- Submit a comment and a notice with a Shift+Enter break between visible text, then confirm each posted `RichTextContent` rendering visibly shows that break; a trailing `<br>` at a paragraph boundary is visually invisible, so editor state alone is insufficient.
- Project comments load newest-first, a new comment jumps to the top, and "Load older comments" appears and appends below the history.
- Notice-board order, composer placement, unread badge behavior, and absence of pagination remain unchanged.

## Rollout

No D1 migration, background-worker deployment, or webhook-ingress deployment is needed. Build the web assets, then deploy only the app worker:

```bash
cd portal/workers/app && npx wrangler deploy
```

The app worker's [`wrangler.jsonc`](../../portal/workers/app/wrangler.jsonc:10) serves `../../apps/web/dist` through its `ASSETS` binding, so the web bundle and project-comments API route ship together in that deploy.
