# Rich-text editor Tiptap v3 redesign plan

**Status: Phase 1 IMPLEMENTED — built by Terra, fresh Terra diff review (approved, one commit-
hygiene note about unrelated pre-existing dirty files, no code findings), Opus final-draft review
(approved — mutation-tested each of the four fixes by removing it and confirming the corresponding
test fails, and inspected the live ProseMirror schema at runtime to prove zero Phase 2 leakage) →
this session's §5 gate (independently re-ran the full verify sequence: typecheck, `@quincy/web`
build, `npm run test --workspaces`, and the `packages/shared` suite the root script skips — 640
tests green across every workspace). Committed `0f089f5`, deployed to production
(`quincy-portal-app` version `ed143d51-5892-4cb2-a597-2e0d338301aa`), 2026-08-20.

**Manual verification caught and resolved a real discrepancy worth recording.** Luna's local-dev
danger-mode walkthrough reported existing rich-text content losing all formatting on edit+save — a
serious-looking finding that directly contradicted the automated test suite. Rather than trust or
dismiss it, the orchestrating session traced it via direct D1 queries: the "edited" post Luna
reported on was actually a separate duplicate post it had created to test with, not the same row as
the correctly-formatted original, so the report couldn't distinguish a save-time bug from a
creation-time one. The session then independently reproduced the exact scenario itself — real
clicks and keystrokes against a locally-running dev server (not accessibility-tree/automated input)
— on both surfaces: opened the existing correctly-formatted notice-board post, edited it, saved,
reloaded, and confirmed via direct database query that bold/italic/link/bulletList marks survived
byte-for-byte; separately applied a new bold mark to an existing project comment and confirmed the
same. Zero console errors either time. The conclusion: Luna's finding was a testing-methodology
artifact from its automated typing method, not a real defect in Phase 1's code — genuinely
confirmed by reproducing the same scenario with reliable input rather than by re-running the
existing automated suite (which had already passed and couldn't have caught a methodology-specific
false positive). Passive post-deploy production verification (page load, toolbar renders identically
at 5 buttons, all API requests 200, zero console errors) confirmed the live deploy is clean.

Phases 2A, 2B, and 2C remain outstanding — each is its own isolated build/review/gate/deploy cycle
per this plan's Rollout section. This document stays in `docs/plans/` (not `implemented/`) until
all four sub-deploys are complete.

---

**Prior status: APPROVED — not yet built.** Cleared the full `docs/Subagent-Orchestration.md` §2 policy-1
plan-tier sequence: Terra draft → two capped fresh-Terra review rounds (each found and fixed real
issues) → two Opus plan-tier review rounds (each independently verified findings by running the
real `packages/shared` parser/helpers and reading the real `@tiptap/*@3.30.2` package sources, and
each found genuine blocking defects) → the two-revert cap to Terra was exhausted, so a single Opus
instance edited this document directly under §2 policy-1's terminal case, re-verifying every
technical claim against installed/published packages rather than carrying anything over from the
review report (`rich-text.ts`'s three post-parse helpers run against the proposed shapes;
`ListItem.content` read out of `@tiptap/extension-list-item@2.27.2` and
`@tiptap/extension-list@3.30.2`; the type scale read out of `tokens/typography.css`; checklist byte
sizes measured with `TextEncoder`; the heading input-rule regex read out of both `extension-heading`
builds; the Simple Editor CLI command and licence confirmed against the published package and
Tiptap's docs) → a separate fresh Opus self-review then independently re-verified everything from
scratch (re-ran the helper defects, rebuilt all four proposed ProseMirror schemas directly to test
their structural properties, re-derived the byte math, re-checked every CSS token value) and
**approved**, finding only 7 non-blocking wording/sequencing nits (recorded in Review-focus
decisions and risks below) and applying 3 mechanical citation corrections itself. (Phase 1 has
since built, been reviewed, and deployed — see the current status above.)

## Problem and scope

Quincy's notice-board and project-comment composers share a deliberately narrow, portable
`RichTextDoc` contract, but their current five-button Tiptap v2.27.2 toolbar is not a sufficient
long-form writing surface. Migrate the existing shared editor to Tiptap v3 first with no user-visible
or stored-contract change. Only after that independent release is verified, build a Quincy-restyled
toolbar from selectively adopted Tiptap Simple Editor source and add the settled formatting features:
underline, strikethrough, two heading levels, task lists, an in-app link editor, and visible undo/redo.

Both surfaces remain the same shared `RichTextEditor` and `RichTextContent` implementation. Phase 2
extends the shared server trust boundary and both POST/PATCH paths; it does not create a
surface-specific editor, alter author-only editing, or make rendered checklist items interactive.
Live-as-you-type Markdown conversion and Cmd/Ctrl+Enter submission remain unchanged.

## Source map

- [`portal/package.json:27–31`](../../portal/package.json#L27) pins the five direct Tiptap
  dependencies at `2.27.2`; [`RichTextEditor.tsx:82–87`](../../portal/apps/web/src/components/RichTextEditor.tsx#L82)
  configures the current extension set, including disabled headings, strike, and code.
- [`RichTextEditor.tsx:10–25`](../../portal/apps/web/src/components/RichTextEditor.tsx#L10) and
  [`39–54`](../../portal/apps/web/src/components/RichTextEditor.tsx#L39) are the two deliberate
  `RichTextDoc` ↔ Tiptap adapters. In particular, the stored flat link `href` becomes
  `attrs.href` on input and is flattened again on output at
  [`17–20`](../../portal/apps/web/src/components/RichTextEditor.tsx#L17) and
  [`44–47`](../../portal/apps/web/src/components/RichTextEditor.tsx#L44).
- [`RichTextEditor.tsx:28–37`](../../portal/apps/web/src/components/RichTextEditor.tsx#L28) and
  [`57–61`](../../portal/apps/web/src/components/RichTextEditor.tsx#L57) retain the deliberate
  list-only Shift+Enter and hard-break-aware mention query. The submit priority is at
  [`94–105`](../../portal/apps/web/src/components/RichTextEditor.tsx#L94), and today's
  `window.prompt()` link UI and five-button toolbar are at
  [`138–152`](../../portal/apps/web/src/components/RichTextEditor.tsx#L138).
- [`portal/packages/shared/src/rich-text.ts:6–16`](../../portal/packages/shared/src/rich-text.ts#L6)
  defines the current document model (bold, italic, flat-href link, mention, hard break,
  paragraph/bullet/ordered lists). Its strict parser is at
  [`46–126`](../../portal/packages/shared/src/rich-text.ts#L46); its 32 KiB and depth-eight
  trust limits are at [`18–19`](../../portal/packages/shared/src/rich-text.ts#L18).
  [`httpUrl()`](../../portal/packages/shared/src/rich-text.ts#L38) at `38–44` throws **three
  distinct** messages — "Link href must be a non-empty string", "Link href must be an absolute
  HTTP(S) URL", "Link href must use HTTP(S)".
- Three post-parse helpers in the same file are **not** generic tree walkers and each has a
  concrete defect against the Phase-2 shapes. This was measured by running the real functions,
  not inferred:
  - [`textFromBlock`](../../portal/packages/shared/src/rich-text.ts#L129) (`129–133`, behind
    `richTextPlainText` at `136–138`) special-cases `paragraph` for inline content and sends
    everything else down a **block**-recursion path. `richTextPlainText` on a `heading` therefore
    throws `TypeError: Cannot read properties of undefined (reading 'map')`.
  - [`richTextMentionIds`](../../portal/packages/shared/src/rich-text.ts#L141) (`141–151`)
    guards `node.content ?? []` for `paragraph` only; its tail iterates `node.content`
    unguarded, so a content-less `heading` (which the Phase-2 schema below permits, `content?`)
    throws `TypeError: node.content is not iterable`.
  - [`normalizeRichTextMentionLabels`](../../portal/packages/shared/src/rich-text.ts#L154)
    (`154–166`) ends at line `164` with `return { type: node.type, content: … }` for every node
    type it does not name — it **silently drops `attrs`**. Measured today: normalizing
    `{"type":"heading","attrs":{"level":2},…}` returns `{"type":"heading","content":[…]}`, and a
    `taskItem` loses `attrs.checked` the same way. This function runs on **every** server write
    on **both** routes and its output is what is persisted to `contentJson`, so an unfixed tail
    means an h2 notice is stored `attrs`-less, notice-board GET's re-parse rejects it, and the
    post silently degrades to legacy plain text on its **first read**. A project comment is
    served corrupted to the SPA (no re-parse on read) and the next author PATCH 400s.
  Phase 2B/2C must fix all three; see the explicit requirements in §2.
- [`RichTextContent.tsx:4–24`](../../portal/apps/web/src/components/RichTextContent.tsx#L4)
  is the static safe renderer shared by both surfaces; it presently knows bold/italic/link marks,
  mentions, hard breaks, paragraphs, list items, and ordered/bullet lists.
- [`NoticeBoard.tsx:52–78`](../../portal/apps/web/src/components/NoticeBoard.tsx#L52) and
  [`ProjectCollaborationPanel.tsx:81–93`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx#L81)
  each use that same editor for create and author edit and the same renderer for posted content.
  The limits remain 2,000 and 10,000 respectively; neither call site gains an editor variant —
  `RichTextEditor`'s props are unchanged. Their submit buttons are gated only on
  `isPosting`/`isSaving`/`saving` today, not on content; the one content-derived condition Phase 2
  adds to them is the shared byte guard specified in §2.
- Both write routes call the shared parser before persisting: notice board at
  [`notice-board.ts:45–59`](../../portal/workers/app/src/routes/notice-board.ts#L45),
  [`81–124`](../../portal/workers/app/src/routes/notice-board.ts#L81), and project comments at
  [`project-comments.ts:38–49`](../../portal/workers/app/src/routes/project-comments.ts#L38),
  [`78–105`](../../portal/workers/app/src/routes/project-comments.ts#L78). Notice-board reads
  re-parse and fall back to legacy plain text on a parser failure
  ([`notice-board.ts:21–35`](../../portal/workers/app/src/routes/notice-board.ts#L21)); project
  comments deserialize their stored JSON directly ([`project-comments.ts:52–54`](../../portal/workers/app/src/routes/project-comments.ts#L52)).
- [`RichTextEditor.dom.test.tsx:53–176`](../../portal/apps/web/src/components/RichTextEditor.dom.test.tsx#L53)
  already exercises real happy-dom/Tiptap keyboard, mention, hard-break, and link round trips.
  [`NoticeBoard.dom.test.tsx:224–339`](../../portal/apps/web/src/components/NoticeBoard.dom.test.tsx#L224)
  additionally exercises rich content, editing, submit shortcuts, and mention selection.
  [`ProjectCollaborationPanel.dom.test.tsx:196–238`](../../portal/apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx#L196)
  currently covers basic posting, author-only edit/delete controls, cancel, and the project-scoped
  mention lookup request; it does **not** yet assert rich-list/link rendering, Cmd/Ctrl+Enter, or
  that a selected mention reaches the submitted document. Those are explicit Phase-2 additions.
  Shared validator coverage starts at [`rich-text.test.ts:22–80`](../../portal/packages/shared/test/rich-text.test.ts#L22).
- The existing Quincy styling seam is the shared rich-text block at
  [`app.css:434–458`](../../portal/apps/web/src/styles/app.css#L434), backed by the ink/paper and
  signal tokens at [`tokens/colors.css:7–58`](../../portal/apps/web/src/styles/tokens/colors.css#L7).
  Facts that constrain the Phase-2 CSS, read off the current files:
  - `.rich-text` is a **14px / 1.55** block. Its first-child margin reset is
    `.rich-text p:first-child, .rich-text ul:first-child, .rich-text ol:first-child` — it lists
    element selectors individually and therefore does **not** cover `h2`/`h3`.
  - `.rich-text a { color: var(--text-primary); text-decoration: underline; }` — links are
    currently ink-coloured and underlined, i.e. **indistinguishable from a `<u>`**.
  - The real type scale in
    [`tokens/typography.css`](../../portal/apps/web/src/styles/tokens/typography.css) is
    11/12/14/16/18/22/28/36/48/64/88/120 px. **There is no 20px value.** `--type-h3` is
    `var(--weight-regular) var(--text-xl)/var(--leading-snug) var(--font-display)`, i.e. **28px
    regular Mazius Review display serif** — a 2× jump over the 14px body, in the brand display
    face. `--type-h2` is 36px. Neither is usable inside this block; both are page-header roles.
  - `font:` is a **shorthand** and resets `font-family`, `font-size`, `font-weight`, and
    `line-height`. `.rich-text__editor-content` already relies on this ordering
    (`font: var(--type-body); font-size: 14px;`): any longhand override must come **after** the
    shorthand or it is silently discarded.
  `MentionAutocomplete` remains functionally unchanged; its markup and keyboard/a11y contract are
  at [`MentionAutocomplete.tsx:7–57`](../../portal/apps/web/src/components/MentionAutocomplete.tsx#L7).
- **Obtaining the Simple Editor source.** The spike's scratch scaffold no longer exists anywhere
  reachable from this repo, so the figures below are recorded evidence, not a checked-in artifact.
  A builder re-obtains the source into a scratch directory **outside** this repo with:

  ```sh
  npx @tiptap/cli@latest add simple-editor
  ```

  Two licence facts, both checked rather than assumed:
  - The **Simple Editor template and all components it includes are MIT licensed** (per
    <https://tiptap.dev/docs/ui-components/templates/simple-editor>), which permits copying and
    adapting them into this repo.
  - The **CLI tool itself** (`@tiptap/cli`, currently `3.19.4`) ships a *Tiptap Pro License* in
    its own `LICENSE.md` and has `login` / `license` / `status` subcommands, because the same
    `add` command can also install paid Pro components. It labels each component's tier in its
    picker ("Open source (MIT)" vs. a plan name) and prompts for licence acceptance before
    downloading a paid one. Copy into `portal/` **only** components the CLI shows as open-source
    MIT; if `simple-editor` is ever not shown that way at fetch time, stop and escalate rather
    than accepting the Pro terms.

- The Simple Editor spike established the v3.30.2 dependency/API boundary and component structure.
  Its successful scaffold resolved the direct Tiptap packages it used to `3.30.2`; three of those
  packages—`@tiptap/extension-find-and-replace`, `@tiptap/extension-list`, and
  `@tiptap/extensions`—publish no `2.27.2` release. A partial downgrade that omitted those three
  packages produced 23 TypeScript errors, including missing-package imports, v3-only StarterKit
  `link` options, and unavailable Link/search commands. The copied source comprises 161 files,
  including 103 TSX files: generic `button`, `button-group`, `toolbar`, `tooltip`,
  `dropdown-menu`, `popover`, `input`, and `separator` primitives are useful, while its
  `mark-button`, `list-button`, `heading-dropdown-menu`, `link-popover`, and `undo-redo-button`
  controls are extension-wired examples to adapt rather than copy wholesale. Its styling is plain
  global SCSS with a substantial `--tt-*` custom-property theme and `.dark` overrides, so copied
  controls must be restyled into Quincy tokens rather than importing that theme. This is retained
  research evidence only, not a committed second editor implementation or a license to import its
  global styles.

## 1. Phase 1 — Tiptap v2 to v3 compatibility migration (independent deploy)

### Change

Update the existing direct Tiptap dependencies in `portal/package.json` and lockfile from `2.27.2`
to the spike's resolved v3 target, **`3.30.2`**:

- `@tiptap/extension-hard-break`
- `@tiptap/extension-mention`
- `@tiptap/react`
- `@tiptap/starter-kit`

Remove `@tiptap/extension-link` as a direct dependency rather than bumping it: Phase 1 moves Link
into StarterKit, where it is registered exactly once under the `link` option. Keeping a standalone
Link extension would duplicate the `link` name. The spike's successful Simple Editor scaffold also
resolved `@tiptap/core`, `@tiptap/pm`,
`@tiptap/extensions`, `@tiptap/extension-list`, `@tiptap/extension-find-and-replace`,
`extension-highlight`, `extension-horizontal-rule`, `extension-image`, `extension-subscript`,
`extension-superscript`, `extension-text-align`, and `extension-typography` to `3.30.2`.
Do **not** add that template's broader set in Phase 1: only the five already-direct Quincy packages
are addressed now (four upgraded and Link removed as a duplicate registration). Feature-specific v3
packages are added only in Phase 2 when their matching schema surface is enabled — currently just
`@tiptap/extension-list` in 2B.

**Version-drift note.** Quincy already pins its direct Tiptap deps exactly (`2.27.2`, no `^`), per
the repo-wide pinning convention, and that does not change. What *does* change is upstream:
`@tiptap/starter-kit@2.27.2` declares its internal deps as `^2.27.2` ranges, whereas
`@tiptap/starter-kit@3.30.2` declares them as **exact** `3.30.2` — including
`"@tiptap/extension-list": "3.30.2"`, the package 2B promotes to a direct dependency. So under v3,
bumping our direct pin without bumping StarterKit makes npm install a **second, nested copy** of
`@tiptap/extension-list`, and our imported `ListItem`/`TaskItem` would then be different classes
from StarterKit's — the classic duplicate-instance schema failure. Any future patch bump must move
every Tiptap package to the same exact version together, in one change.

Adapt `RichTextEditor.tsx` to v3 without changing its observable document, keyboard, toolbar, or
CSS behavior. The Phase-1 target is this exact configuration (with the existing `ListItemHardBreak`
and `Mention` entries retained after StarterKit); it replaces the standalone Link entry:

```ts
const extensions = [
  StarterKit.configure({
    heading: false,
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
    hardBreak: false,
    strike: false,
    code: false,
    underline: false,
    listKeymap: false,
    trailingNode: false,
    undoRedo: {},
    link: { openOnClick: false, autolink: false, linkOnPaste: false },
  }),
  ListItemHardBreak,
  Mention.configure({ HTMLAttributes: { class: "rich-text__mention" }, suggestion: { items: () => [] } }),
];

const editor = useEditor({
  extensions,
  shouldRerenderOnTransaction: true,
  // existing content, editorProps, callbacks, and editable options
});
```

`shouldRerenderOnTransaction: true` deliberately retains v2's React-render-on-selection behavior:
the existing toolbar reads `editor.isActive()` during render for `aria-pressed`, so it must update
on a caret-only move. `trailingNode: false` prevents v3 from appending a paragraph after a final
list, and `listKeymap: false` preserves v2 list Backspace/Delete behavior. `undoRedo: {}` keeps
the v3 `UndoRedo` extension that StarterKit supplies under its `undoRedo` option (v2 called this
history); it needs no new direct dependency.

The v3 migration must:

- Keep `HardBreak`, `Mention`, the list-only `Shift+Enter` override, and the `mentionQuery()`
  hard-break leaf separator configured exactly as they are today.
- Use the literal target above; do not replace it with a prose enumeration or rely on v3 defaults.
  In particular, retain `hardBreak: false` because `ListItemHardBreak` owns the existing list-only
  Shift+Enter behavior. Do not import v3's consolidated `@tiptap/extension-list` or enable task
  lists until Phase 2.
- Migrate the controlled-content synchronization call exactly from
  `editor.commands.setContent(toTiptap(value), false)` to v3's options-object form
  `editor.commands.setContent(toTiptap(value), { emitUpdate: false })`. Reconcile the remaining
  changed v3 types/command APIs and extension-option names against the spike, then
  keep `toTiptap()` and `tiptapToRichTextDoc()` as symmetrical, non-mutating adapters. The stored
  document must remain byte-for-byte shape-compatible: a flat `{ type: "link", href }` is never
  changed to an `attrs` wire shape, and the existing `hardBreak` remains permitted only as it is
  today.
- Retain the existing Markdown input rules/live conversion and `handleKeyDown` ordering: mention
  menu first, Cmd/Ctrl+Enter next, then normal editor handling. Every Phase-1 UI action must look
  and behave as it did before the dependency upgrade.

Phase 1 has its own commit, review gate, deploy, and production verification. Do not begin Phase 2
or expose any new control until that exact v3 release is live and its old stored documents have
round-tripped safely.

### Non-goals

No `RichTextDoc` type, parser, renderer, endpoint, document-data, visual, or feature change belongs
to Phase 1. In particular, do not add underline, strikethrough, headings, task lists, undo/redo
buttons, a link dialog, Simple Editor UI source, `@tiptap/extension-list`, or any of the spike
template's search/replace, alignment, image, code, highlight, sub/superscript, typography, or
other default extensions.

## 2. Phase 2 — Quincy toolbar and scoped schema expansion (independent v3 deploy sequence)

### Change

Build the redesign only on the verified v3 baseline, retaining one shared `RichTextEditor` and
`RichTextContent` for notices and comments. Selectively port the Simple Editor source into Quincy
component locations: its generic `button`, `button-group`, `toolbar`, `tooltip`, `dropdown-menu`,
`popover`, `input`, and `separator` primitives are the implementation basis. Restyle their copied
SCSS/classes into the existing Quincy CSS/token system—Ink `#0a0a0a`, Warm Paper `#faf8f2`, the
four signal colours, and Apfel Grotezk—not the template's global `--tt-*` theme or `.dark` model.
Restyle `MentionAutocomplete` through its existing classes so it visually belongs with the toolbar,
without altering its lookup, selection, keyboard, or accessibility behavior.

Port/adapt, rather than directly reuse, the template feature-control groups: `mark-button`,
`list-button`, `heading-dropdown-menu`, `link-popover`, and `undo-redo-button` are coupled to the
template's broad v3 extension array and command hooks. Give each Quincy control an explicit,
accessible label, pressed/disabled state, and only a command for an enabled Quincy extension.
Do not copy the Simple Editor shell, starter content, custom nodes, search/replace, text alignment,
image upload, or its default extension set.

The toolbar after Phase 2 contains existing Bold, Italic, Link, bullet list, ordered list,
list-only Shift+Enter behavior, live Markdown conversion, and Cmd/Ctrl+Enter submit, plus:

- Underline and Strikethrough controls.
- A heading dropdown labelled **Section** and **Subsection**, mapped to Tiptap heading levels 2
  and 3 only. Level 1 and levels 4–6 are unavailable. A heading contains the same inline content
  allowed in a paragraph and is a document-level block only: headings are forbidden anywhere
  inside bullet, ordered, or task-list items.

  **Enforce that at the ProseMirror schema level, not with a transaction guard.** Configure
  `heading: { levels: [2, 3] }` and narrow the two item nodes' content expressions so a heading
  is structurally unrepresentable inside them:

  ```ts
  // 2B — taskList does not exist in the schema yet, so it must NOT be named here.
  ListItem.extend({ content: "paragraph (paragraph|bulletList|orderedList)*" })
  // 2C — widen both expressions once TaskList/TaskItem are registered.
  ListItem.extend({ content: "paragraph (paragraph|bulletList|orderedList|taskList)*" })
  TaskItem.extend({ content: "paragraph (paragraph|bulletList|orderedList|taskList)*" })
           .configure({ nested: true })
  ```

  `heading: { levels: [2, 3] }` — the array **order is load-bearing** and must not be "tidied".
  Tiptap's Heading extension builds one input rule per level as
  `^(#{Math.min(...levels),level})\s$` and maps them in array order (verified identical in
  v2 `extension-heading` and v3 `3.30.2`). With `[2, 3]` the level-2 rule `^(#{2,2})\s$` is tried
  first, so `## ` yields h2 and `### ` yields h3. With `[3, 2]` the level-3 rule `^(#{2,3})\s$`
  matches first and `## ` would produce an **h3**. The same `Math.min` floor of 2 is why `# `
  matches nothing and stays a paragraph.

  Why schema, not a transaction guard — **the previous draft's justification for the guard was
  factually wrong and is retracted.** It claimed a paragraph-first `ListItem` would reject "a
  live, currently accepted list item whose first child is a nested list". `ListItem.content` is
  **already** `"paragraph block*"` — paragraph-first — in both `@tiptap/extension-list-item`
  (v2.27.2, as installed) and `@tiptap/extension-list` (v3.30.2). A nested-list-first list item
  is accepted by the *shared JSON parser*, which has no ordering requirement, but has never been
  representable in the *editor's* schema, so the extension above cannot break anything that works
  in the live editor today. It only replaces the permissive `block*` tail — which, once headings
  are enabled in 2B, would otherwise admit a heading inside a list item — with an explicit
  allow-list. This means:
  - The invalid state is unrepresentable rather than merely rejected, so ProseMirror enforces it
    on every editing step by construction: commands, input rules, paste, drop, lift/join,
    `setNode`/`toggleNode`, and undo/redo, with no guard code to keep exhaustive.
  - ProseMirror's paste-fitting resolves a pasted heading inside a list item structurally —
    placing it at a depth where it is allowed (typically lifting it out of the item), or fitting
    its inline content into the item's paragraph. Which of the two it picks depends on the slice's
    open depths and should be **observed and pinned by the test**, not presumed here. Either way
    it **keeps the rest of the paste**, whereas a transaction guard rejects the whole paste and
    discards content the user expected to land.
  - `TaskItem.content` is a **method** (`nested ? "paragraph block*" : "paragraph+"`), not a
    string; Tiptap resolves the field with `callOrReturn`, so a string from `.extend()` legally
    replaces it. Keep `nested: true` regardless — it also supplies the `Tab` sink keymap and the
    branching-list delete keymap, which the content override does not.
  - The **shared parser stays more permissive than the editor** for legacy data: it must continue
    to accept an ordinary `listItem` whose first child is a nested list. That asymmetry is the
    pre-existing status quo, is deliberate, and the compatibility fixture in the test matrix
    pins it.

  Section/Subsection stays **disabled** whenever the selection has a `listItem` or `taskItem`
  ancestor. With the schema in place this is a UI affordance rather than the enforcement
  mechanism (`setNode` would already be a structural no-op), and it must be implemented via
  `editor.can()` on the heading command rather than a hand-rolled ancestor scan.
- Bullet, numbered, and **Checklist** controls. The latter creates Tiptap v3 `taskList` /
  `taskItem` nodes through `@tiptap/extension-list` (pinned to `3.30.2`): import its named
  `TaskList` and `TaskItem` extensions, not `ListKit`, because StarterKit continues to own the
  ordinary bullet/ordered lists.

  Add `"@tiptap/extension-list": "3.30.2"` to `portal/package.json` and regenerate the lockfile
  in **2B**, not 2C: the schema restriction above needs `ListItem` from that package one release
  earlier. This is a promotion, not a new dependency — v3 StarterKit already depends on
  `@tiptap/extension-list@3.30.2` and imports `BulletList`, `ListItem`, `ListKeymap`, and
  `OrderedList` from it, so `StarterKit.configure({ listItem: false })` plus a direct
  `ListItem.extend(...)` registers the **same module instance** and cannot duplicate the
  `listItem` node name. Do not import `ListItem` from `@tiptap/extension-list-item` in v3; that
  package defines a separate copy of the node and StarterKit no longer uses it. 2B imports only
  `ListItem`; 2C adds `TaskList` and `TaskItem` from the package already present.

  Configure `TaskItem` with `nested: true` **and** the narrowed `content` string given above, so
  a task item may contain a nested task list but never a heading, while the shared grammar
  governs all permitted bullet/ordered/task cross-nesting and the maximum depth below. In 2A, enable StarterKit's
  built-in Underline and Strike by omitting their Phase-1 `false` settings; do **not** add
  `@tiptap/extension-underline`, which would duplicate the StarterKit extension.
- A Link popover/dialog that replaces `window.prompt()`: it opens over the current selection,
  pre-fills an existing link, accepts only a non-empty absolute HTTP(S) URL using the same
  validation rule as `httpUrl()`, applies/updates it on confirm, exposes remove-link for an
  existing mark, traps/returns focus appropriately, and closes on cancel/Escape.

  Export a new `isHttpUrl(value: unknown): boolean` predicate from `@quincy/shared` for the
  browser dialog. **`httpUrl()` keeps all three of its distinct error messages** — "Link href
  must be a non-empty string", "Link href must be an absolute HTTP(S) URL", and "Link href must
  use HTTP(S)" (`rich-text.ts:38–44`). They are not collapsed: they are the 400 bodies the write
  routes surface, and flattening three causes into one boolean would make an invalid-link
  rejection undiagnosable server-side. Share the logic without losing the messages by keeping a
  single internal `classifyHref(value): "ok" | "empty" | "relative" | "protocol"`;
  `httpUrl()` maps each non-`ok` result to its existing message string verbatim, and
  `isHttpUrl()` is `classifyHref(value) === "ok"`. The refactor must not change any existing
  message text. Add shared tests asserting each of the three messages is still thrown for the
  empty, relative, and non-HTTP(S) cases respectively, plus browser tests for accepted HTTP(S)
  and rejected empty/relative/non-HTTP(S) input in the dialog. Its mutation must still go through
  the normal conversion and on-change path.
- Visible Undo and Redo controls, disabled when the respective history command cannot run. They
  are editor-only commands backed by StarterKit's already-present v3 `UndoRedo` extension under
  its `undoRedo` option (not v2's `history` extension); they do not alter the stored contract or
  add a dependency.

Extend `RichTextDoc` and its parser only for these explicit new shapes:

- marks `{ type: "underline" }` and `{ type: "strike" }`, each with no attributes;
- heading `{ type: "heading", attrs: { level: 2 | 3 }, content?: RichTextInline[] }`, rejecting
  every extra node/attribute and every other level. A heading is allowed only directly in the
  document's `content`, never inside any list or task-list item;
- task list `{ type: "taskList", content: RichTextTaskItem[] }` and task item
  `{ type: "taskItem", attrs: { checked: boolean }, content: [RichTextParagraph, ...(RichTextParagraph | RichTextBulletList | RichTextOrderedList | RichTextTaskList)[]] }`.
  A task list contains task items only; a task item exists only inside a task list; and its attrs
  are exactly the boolean `checked` value. Keep the ordinary `listItem` **ordering** grammar
  unchanged: an ordinary list item may still contain its current non-empty sequence in any order,
  including a nested list as its first child. That is a deliberate compatibility decision for
  already-stored data, and it is why the parser stays more permissive than the editor schema. The
  parser's only widening for `listItem` is that in 2C it must also accept a `taskList` child —
  required by the deepest-legal chain below, which routes `listItem d5 → taskList d6`. The parser
  continues to reject headings in every list and task item, matching the editor schema above.
  Reuse/extend the existing list-item structural validation rather than accepting arbitrary
  ProseMirror JSON.

Widen `RichTextBlock`/list-item unions and `parseMarks`, `parseInline`, `parseBlock` exhaustively.
Headings and task items contribute their textual content to limits/body derivation; formatting
marks do not.

**The three post-parse helpers each need a named, specific fix — they are not generic tree
walkers and will otherwise corrupt or crash on the new shapes.** These are the measured defects
recorded in the source map; treat this list as the acceptance criteria, not as guidance:

1. **`normalizeRichTextMentionLabels` must preserve `attrs`.** Its tail at
   `rich-text.ts:164` currently returns `{ type: node.type, content: … }` for any node type it
   does not explicitly name, which silently drops `attrs`. Add explicit `heading` and `taskItem`
   branches that copy `attrs` (`{ ...node.attrs }`) alongside the recursed `content`, and change
   the general rule the tail encodes from "keep `type` and `content`" to "**keep every own key of
   the node**, recursing only into `content`". Recursing into `content` is not sufficient. This
   function runs on every write on both routes and its return value is what is persisted, so an
   unfixed tail is an immediate data-integrity bug, not an edge case: an h2 notice is stored
   without `attrs.level`, notice-board GET's re-parse rejects it, and the post degrades to legacy
   plain text on its very first read.
2. **`textFromBlock` needs its own `heading` branch.** `heading` holds **inline** content, so it
   must be handled the same way `paragraph` already is at `rich-text.ts:130` — mapping
   text/hardBreak/mention inline nodes directly — rather than falling through to the block
   recursion path, which today throws
   `TypeError: Cannot read properties of undefined (reading 'map')` on a heading.
3. **Guard every `content` iteration with `?? []`.** The Phase-2 heading schema makes content
   optional (`content?`), so a content-less heading is valid stored data. Today
   `richTextMentionIds`'s tail (`rich-text.ts:147`) throws
   `TypeError: node.content is not iterable` on one. Both `richTextMentionIds` and the
   block-recursion tails of `textFromBlock` and `normalizeRichTextMentionLabels` must iterate
   `node.content ?? []`.

Required tests for the above, in `packages/shared/test/rich-text.test.ts` (2B for heading, 2C for
task items):

- Normalize a document containing an h2, an h3, a checked task item, and an unchecked task item,
  and assert `attrs.level` is still `2` / `3` and `attrs.checked` is still `true` / `false` after
  the round trip — not merely that the text survived.
- Assert the **write path composes**: `parseRichTextDoc(normalizeRichTextMentionLabels(
  parseRichTextDoc(input), names))` must succeed and deep-equal the parse of `input`. This is the
  test that would have caught the silent-degradation bug, because it reproduces exactly what
  notice-board GET does on the next read.
- Assert `richTextPlainText` and `richTextMentionIds` both return without throwing for a
  content-less heading, and that a mention placed inside a heading and inside a task item is
  found by `richTextMentionIds` and relabelled by `normalizeRichTextMentionLabels`.

The new structures must
remain below the existing `RICH_TEXT_MAX_NESTING` of 8 and inside the unchanged
`RICH_TEXT_JSON_MAX_BYTES` 32 KiB cap—do not raise either boundary. The editor must allow no more
than four `listItem`/`taskItem` containers on one root-to-leaf path: the deepest valid chain is
`taskList d0 → taskItem d1 → taskList d2 → taskItem d3 → bulletList d4 → listItem d5 → taskList d6 → taskItem d7 → paragraph d8`.
At that fourth item container, disable indent/nest and any list action that would create a child
list/item, and reject a paste or transaction that would create one at d9; it must not let a user
create a document the server will 400. On that rejection, leave the document unchanged (never
silently truncate or flatten pasted content) and announce “Maximum list nesting is four levels” in
the editor's `aria-live` validation message.

The existing 32 KiB guard is a **serialized-width** boundary, not a depth boundary. Measured on
the canonical stored shapes, using **50-character** paragraphs: a 200-item ordinary bullet list is
28,260 bytes while the identical 200-item checklist is 33,458 bytes, because each task item adds
exactly **26** bytes of
`,"attrs":{"checked":false}` (the 5,198-byte total difference is 200 × 26 less 2 bytes for the
shorter `"taskList"` container name). A checklist's canonical size is `58 + 120n` bytes for `n`
items whose paragraph holds three ASCII characters. Marks amplify serialized width the same way.

A document can therefore be well under its **character** limit and still over the **byte** cap,
which is the whole reason a separate client guard is worth building: the character counter is
visible and self-explanatory, whereas the byte cap is invisible and its server rejection is a
generic invalid-content 400.

Keep the server as authority and add a shared UTF-8 byte-length helper —
`richTextDocByteLength(doc: RichTextDoc): number` — exported from `@quincy/shared` alongside the
already-exported `RICH_TEXT_JSON_MAX_BYTES`. It must measure `JSON.stringify` of the canonical
stored doc via `TextEncoder`, i.e. exactly what `parseRichTextDoc` measures on the incoming body,
so client and server agree. (Residual: the server re-serializes after
`normalizeRichTextMentionLabels` rewrites mention labels to canonical names, so the stored bytes
can differ slightly from the measured request bytes. The difference is bounded by
`STAFF_NAME_MAX_LENGTH` per mention and the server cap is checked pre-normalization, so the client
figure is exact for the accept/reject decision.)

**How submit is blocked — the chosen mechanism, stated precisely.** The submit buttons live in
`NoticeBoard.tsx` and `ProjectCollaborationPanel.tsx`, not in `RichTextEditor`, and today they are
gated only on `isPosting` / `isSaving` / `saving` — not even on the character limit, which only
gates the Cmd/Ctrl+Enter path inside the editor. Neither of the two options previously floated is
taken:

- **Not** a new `RichTextEditor` prop or callback. That would be new cross-component wiring and
  would contradict "neither call site gains a variant".
- **Not** Cmd/Ctrl+Enter-only. The byte cap is invisible to the user, so leaving the button path
  to the server's generic 400 is the outcome this guard exists to avoid.

Instead, **each call site computes the guard itself from state it already owns**, using the shared
helper. `NoticeBoard` already holds `content` / `editingContent` and `ProjectCollaborationPanel`
holds `content` / `editing.content`, and all four are canonical `RichTextDoc` values emitted by
`tiptapToRichTextDoc`. Each site derives
`const overBytes = richTextDocByteLength(doc) > RICH_TEXT_JSON_MAX_BYTES` and ORs it into the
`disabled` expression of its submit button — **all four buttons**: notice-board Post notice and
Save, project-comment Post comment and Save. `RichTextEditor` independently calls the same helper
for its own `aria-live` message and adds the same condition to its existing Cmd/Ctrl+Enter gate.
The `RichTextEditor` signature, and therefore the "no variant" property, is unchanged: the call
sites gain three lines of shared-helper logic each, not a surface-specific editor. This is the one
place both call sites gain composer logic, and it is deliberate.

The editor's `aria-live` message is distinct from the character counter, which is unchanged:
“This formatting is too large to save; remove list items or formatting.”

Ensure each copied/converter path preserves heading `attrs.level` and task-item
`attrs.checked`; it must continue translating only link marks between the stored flat `href` and
Tiptap `attrs.href` representations.

Extend `RichTextContent` correspondingly: render underline and strike as semantic `<u>` and `<s>`,
Section/Subsection as `<h2>`/`<h3>`, and task lists/items as static checklist markup. The posted
renderer must never render a togglable checkbox, install a click/change handler, call a mutation
endpoint, or bypass author-only editing. It may display a non-form check glyph/state with an
accessible completed/not-completed description, but checking/unchecking is possible only in the
author’s full editable composer before submit or during the existing author-only edit flow.

Before 2A enables any new stored shape, harden `RichTextContent`'s block switch with a defensive
default branch. It must safely render an unknown block's available descendant text (or an empty
fragment when it has none), never assume `node.content` exists, and never throw. This protects a
viewer running a stale SPA bundle: project comments return `JSON.parse(contentJson)` without the
notice-board re-parse/fallback, so an old reader must degrade an h2/task-list comment to safe text
rather than unmounting its surrounding tree.

Extend the existing `app.css:434–458` rich-text block in the same Phase-2 change.

**Heading sizing, against the real tokens.** An earlier draft specified `var(--type-h3)` "at its
existing 20px scale". That was wrong twice over: there is no 20px step in the scale
(11/12/14/16/18/22/28/36/48/64/88/120), and `--type-h3` is 28px regular **Mazius Review display
serif** — a 2× jump over the 14px body in the brand display face, inside a comment box. Neither
`--type-h2` (36px) nor `--type-h3` is usable here; they are page-header roles.

Section/Subsection are structural labels inside a UI-scale block, not brand display headlines, so
they stay in the UI sans face and step **one and two sizes up from body**, using real tokens:

```css
.rich-text h2 {
  margin: 16px 0 0;
  font-family: var(--font-sans);
  font-size: var(--text-md);        /* 18px */
  font-weight: var(--weight-bold);
  line-height: 1.3;
  letter-spacing: var(--tracking-tight);
  color: var(--text-primary);
}
.rich-text h3 {
  margin: 14px 0 0;
  font-family: var(--font-sans);
  font-size: var(--text-base);      /* 16px */
  font-weight: var(--weight-bold);
  line-height: 1.35;
  color: var(--text-primary);
}
```

Use **longhands only** here, as written — do not apply a `--type-*` role through the `font:`
shorthand and then override it. `font:` is a shorthand that resets `font-family`, `font-size`,
`font-weight`, and `line-height`; if a token is ever applied that way in this block, every
longhand override **must** be written after the shorthand or it is silently discarded. The
existing `.rich-text__editor-content { font: var(--type-body); font-size: 14px; }` already depends
on that ordering. The matching editor-side selectors
(`.rich-text__editor-content h2` / `h3`) take the same rules so the composer and the posted
content agree.

**Extend the first-child margin reset — it does not cover headings today.** The current selector
enumerates elements individually:

```css
.rich-text p:first-child, .rich-text ul:first-child, .rich-text ol:first-child { margin-top: 0; }
```

It must gain `.rich-text h2:first-child`, `.rich-text h3:first-child`, and (in 2C)
`.rich-text ul.rich-text__task-list:first-child`. "Retained" is not sufficient; a notice that
opens with a Section would otherwise carry a stray 16px top margin.

**Distinguish underline from links.** `.rich-text a` is currently
`color: var(--text-primary); text-decoration: underline`, so a `<u>` would render pixel-identical
to a link. Give the link the distinguishing treatment, since it is the element that must be
identifiable:

```css
.rich-text a { color: var(--signal-info); text-decoration: underline; text-underline-offset: 2px; }
.rich-text u { color: inherit; text-decoration: underline; text-decoration-color: var(--text-muted); text-underline-offset: 2px; }
.rich-text s { text-decoration: line-through; text-decoration-color: var(--text-muted); }
```

This is a small, deliberate visual change to already-posted links, shipping in 2A alongside the
Link dialog; call it out in that sub-deploy's browser verification. `--signal-info` is also the
mention colour, but mentions carry a filled `rich-text__mention` chip background and do not read
as links. `<s>` needs no disambiguation — line-through never collides with a link's underline —
but is specified so its decoration colour matches `<u>`.

Task lists use a dedicated `rich-text__task-list` class (and
the matching editor task-list selector): `list-style: none`, no left bullet gutter, 8px top spacing,
and nested lists indented from the check indicator. Each `rich-text__task-item` is a grid/flex row
with a fixed non-form indicator span, 8px gap, and baseline-aligned text; unchecked uses the
hairline/paper tokens and checked uses `var(--signal-positive)` plus a subtle line-through. The
indicator carries the accessible completed/not-completed text but has no input semantics or event
handler. Keep all toolbar/popover primitives on `var(--type-body)`/`var(--type-label)`, Ink, Warm
Paper, hairline, and focus tokens—no user-agent heading defaults or Simple Editor `--tt-*` theme.

**Phase-2 internal sequencing decision: split it into three isolated app deploys.** This follows
the Shift+Enter plan's one-way-door precedent rather than treating all four new persisted shapes as
a single reversible visual release.

1. **2A — marks and non-persisted UI:** ship underline/strike parser+renderer+controls, the
   Quincy primitive toolbar, Link dialog, Undo/Redo, and the defensive reader fallback. It is the
   smallest mark-contract change; once data is saved, a parser rollback is still unsafe, so prefer
   a roll-forward repair after persistence. Its exact editor target is:

   ```ts
   useEditor({
     shouldRerenderOnTransaction: true,
     extensions: [
       StarterKit.configure({
         heading: false,
         blockquote: false,
         codeBlock: false,
         horizontalRule: false,
         hardBreak: false,
         strike: {},
         code: false,
         underline: {},
         listKeymap: false,
         trailingNode: false,
         undoRedo: {},
         link: { openOnClick: false, autolink: false, linkOnPaste: false },
       }),
       ListItemHardBreak,
       Mention.configure({ HTMLAttributes: { class: "rich-text__mention" }, suggestion: { items: () => [] } }),
     ],
   });
   ```

2. **2B — heading node:** ship the two-level heading extension, schema/parser/converters/renderer
   and heading dropdown by itself. Its exact editor target is:

   ```ts
   import { ListItem } from "@tiptap/extension-list";

   useEditor({
     shouldRerenderOnTransaction: true,
     extensions: [
       StarterKit.configure({
         heading: { levels: [2, 3] },   // array order is load-bearing; see above
         blockquote: false,
         codeBlock: false,
         horizontalRule: false,
         hardBreak: false,
         strike: {},
         code: false,
         underline: {},
         listItem: false,               // re-registered below with a narrowed content expression
         listKeymap: false,
         trailingNode: false,
         undoRedo: {},
         link: { openOnClick: false, autolink: false, linkOnPaste: false },
       }),
       ListItem.extend({ content: "paragraph (paragraph|bulletList|orderedList)*" }),
       ListItemHardBreak,
       Mention.configure({ HTMLAttributes: { class: "rich-text__mention" }, suggestion: { items: () => [] } }),
     ],
   });
   ```

   This admits exactly h2/h3, not StarterKit's default h1–h6 range, and isolates a new block type
   whose absence after rollback can make editing stored content blank and can trigger notice-board
   legacy fallback. The `listItem` content expression must **not** name `taskList` in this
   release — that node type is not registered until 2C, and ProseMirror throws while building the
   schema when a content expression references an unknown node type or group.

3. **2C — task-list nodes:** ship task-list/task-item extension, schema/parser/converters/renderer
   and Checklist control by itself, including the static-reader rule. Its exact editor target is:

   ```ts
   import { ListItem, TaskItem, TaskList } from "@tiptap/extension-list";

   const ITEM_CONTENT = "paragraph (paragraph|bulletList|orderedList|taskList)*";

   useEditor({
     shouldRerenderOnTransaction: true,
     extensions: [
       StarterKit.configure({
         heading: { levels: [2, 3] },   // array order is load-bearing; see above
         blockquote: false,
         codeBlock: false,
         horizontalRule: false,
         hardBreak: false,
         strike: {},
         code: false,
         underline: {},
         listItem: false,               // re-registered below with a narrowed content expression
         listKeymap: false,
         trailingNode: false,
         undoRedo: {},
         link: { openOnClick: false, autolink: false, linkOnPaste: false },
       }),
       ListItem.extend({ content: ITEM_CONTENT }),
       ListItemHardBreak,
       TaskList.configure({}),
       TaskItem.extend({ content: ITEM_CONTENT }).configure({ nested: true }),
       Mention.configure({ HTMLAttributes: { class: "rich-text__mention" }, suggestion: { items: () => [] } }),
     ],
   });
   ```

   This is separately isolated because it adds both a container and stateful item node and has the
   highest content/interaction risk. Both item nodes now name `taskList`, which is legal only
   because `TaskList` is registered in this same array. `nested: true` is still required on
   `TaskItem` even though the `content` override supersedes its content-expression effect: it is
   also what supplies the `Tab` sink keymap and the branching-list delete keymap.

For every sub-deploy, rollback is clean only before the first document using that newly admitted
shape is persisted. After that point, do not revert the parser/extension as a recovery tactic:
notice-board GET can flatten content through its legacy fallback, project-comment edit may feed an
unknown node to Tiptap and open an empty composer, **and a stale project-comment reader can crash
while rendering an unknown node unless the 2A defensive fallback is present**; a later PATCH can
also reject the previously valid stored document. Roll forward with a compatible correction instead.

State plainly what the 2A defensive fallback does **not** cover: it protects only a viewer who has
already loaded the 2A-or-later bundle. A browser tab still running a **pre-2A** bundle will still
crash on the first heading or task list it encounters once 2B/2C ship, because the fallback branch
is not in the code that tab is executing. This is inherent to shipping a reader change and a
writer change in separate deploys — there is no way to reach an already-loaded stale tab — and it
is why 2A ships the fallback first and alone. It is recorded here so the fallback is not mistaken
for complete protection; the exposure window is bounded by how long a tab stays open across the
2A→2B gap, and no data is affected.

### Non-goals

Do not add text alignment, search and replace, inline code, blockquotes, code blocks, text-colour
swatches, emoji shorthand or picker, inline image upload, additional heading levels, a separate
notice/comment implementation, client-side checkbox mutation on posted content, a viewer exception
to author-only edits, or a submit-key change. Plain Enter does not become send; Cmd/Ctrl+Enter stays
the only submit shortcut.

## Tests and verification

### Phase 1

Extend `RichTextEditor.dom.test.tsx` with strict old-document migration cases: the current
paragraph/list/mention/hard-break document shapes must initialize in v3, make a harmless unrelated
edit, and emit the exact same stored JSON shape. Preserve explicit regressions for list-only
Shift+Enter, plain Enter list behavior, open-mention keyboard priority, live Markdown conversion,
and Cmd/Ctrl+Enter submission. The critical link test must load a stored flat-href link, edit
unrelated text, and assert the emitted document retains the exact original flat `href`—not
`attrs.href`, `null`, or an omitted value. Run it for the shared component and through both
notice-board and project-comment author edit DOM flows. Add a controlled-value synchronization test:
an externally supplied new `value` must invoke
`editor.commands.setContent(toTiptap(value), { emitUpdate: false })` behavior without calling
`onUpdate`/the consumer's `onChange`; only a subsequent user edit may emit an update.
Add a selection-only DOM regression: move the caret between bold text, italic text, a link, and
list content without changing the document or mention query, and assert each applicable toolbar
button's `aria-pressed` updates. Add a final-bullet-list round-trip fixture that initializes,
makes an unrelated edit, and asserts the emitted stored JSON has no appended empty paragraph.

Before Phase 1 deploy, manually confirm on each surface that legacy stored content (paragraphs,
links, mentions, bullet/ordered lists, and existing hard breaks) renders, opens in Edit, saves after
an unrelated edit, and retains its formatting. Verify the keyboard and visual toolbar have no
intentional change.

### Phase 2

Extend—not replace—the three existing DOM suites, using this release-specific matrix:

- **2A:** `RichTextEditor.dom.test.tsx` covers underline/strike exact conversion round trips and
  toolbar states, Link dialog apply/edit/remove/cancel/focus behavior, Undo/Redo, and the existing
  flat-link load → unrelated edit → save regression. Separately assert that a **newly created**
  link emits the exact flat `{ type: "link", href }` stored shape; the edit-load regression and
  new-link creation exercise different converter directions. Add a stale-reader fixture proving
  `RichTextContent` renders unknown heading/task-list-shaped JSON as safe fallback text without
  throwing. `NoticeBoard.dom.test.tsx` and
  `ProjectCollaborationPanel.dom.test.tsx` each post, author-edit, and render underline/strike;
  retain their Cmd/Ctrl+Enter and mention-keyboard coverage. No heading or task assertion belongs
  in 2A because those nodes are not yet enabled.
- **2B:** re-run every 2A regression and add exact heading level-2/level-3 conversion, command, and
  rendering tests on the editor and both surfaces. Prove levels 1 and 4–6 are unavailable in both
  the toolbar and the enabled StarterKit schema/input rules: test typed Markdown and every
  Markdown/paste-conversion path so `## ` and `### ` create h2/h3 while `# ` and `#### ` through
  `###### ` remain paragraphs or are rejected, never yielding another heading level in emitted
  JSON. Add an explicit regression that `## ` produces an **h2 and not an h3**, pinning the
  `levels: [2, 3]` array order against a later "tidy-up" to `[3, 2]`.

  Heading-in-list coverage is now **schema-level**, so test the property, not a guard's code
  paths: assert `editor.can().toggleHeading({ level: 2 })` is false with the caret in a bullet or
  ordered list item and that the Section/Subsection control renders disabled there; assert
  `setNode`/`toggleNode` leaves the document byte-identical; and assert that **pasting** a
  document fragment whose list item contains a heading yields an emitted document with **no
  heading inside any list item** while the surrounding pasted content is still present. Pin
  whichever structural resolution ProseMirror actually produces (heading lifted out, or its text
  folded into the item's paragraph) by asserting the exact emitted JSON, rather than asserting a
  presumed one. Add a schema-construction
  smoke test that the 2B extension array builds without throwing — it is the assertion that
  catches a `content` expression naming `taskList` a release early. Task-list-item coverage
  belongs to 2C because task-list nodes are not yet registered in this release.

  Add the `packages/shared` normalization tests named in §2 for headings: `attrs.level` survives
  `normalizeRichTextMentionLabels`, the parse→normalize→parse composition succeeds and round
  trips, and a content-less heading does not throw in `richTextPlainText` or
  `richTextMentionIds`.
- **2C:** re-run every 2A+2B regression and add checked/unchecked task-item editing and rendering,
  allowed cross-list nesting up to the four-item-container/depth-8 boundary, and rejection of the
  d9 attempt, including its unchanged-document and `aria-live` maximum-depth message. Repeat the
  2B heading-in-item assertions for `taskItem` (`editor.can()` false, control disabled,
  `setNode`/`toggleNode` a no-op, paste lifts the heading out), and re-run the 2B ordinary-list
  ones against the widened `ITEM_CONTENT` expression. Both posted-content
  surface suites must assert static task markup:
  clicking an indicator does not change DOM state or issue POST/PATCH, non-authors lack Edit, and
  only the author's composer/edit flow can alter `checked`. Do not fork fixture or component
  behavior by surface.

  Add the `packages/shared` normalization tests named in §2 for task items: `attrs.checked`
  survives `normalizeRichTextMentionLabels` for both `true` and `false`, and the
  parse→normalize→parse composition round trips.

  Add the editor-side byte-guard regression with a fixture that **isolates the byte cap from the
  character cap**. The previously specified 200-items × 50-characters fixture is unusable: its
  plain text is 10,199 characters, already over the 10,000-character comment limit and 5× over
  the 2,000-character notice limit, so it would trip the character path and prove nothing. Use
  **280 task items whose paragraph text is the 3-character string `abc`**:

  | fixture | serialized bytes | plain-text characters |
  | --- | --- | --- |
  | 270 items × `abc` (accepted) | 32,458 | 1,079 |
  | 280 items × `abc` (rejected) | 33,658 | 1,119 |

  The arithmetic is `58 + 120n`: a 59-byte `doc`/`taskList` wrapper, plus 119 bytes per task item
  (`{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"abc"}]}]}`)
  and one separating comma each. 280 → `58 + 33,600 = 33,658`, which is 890 bytes over the 32,768
  cap; 270 → `58 + 32,400 = 32,458`, 310 bytes under it. Both are far below the 2,000-character
  notice limit as well as the 10,000-character comment limit, so **the same pair works on both
  surfaces** and only the byte guard can be what fires. Assert the 280-item document leaves the
  submit button disabled on all four buttons and announces the specific formatting-size message,
  and that Cmd/Ctrl+Enter is also refused, rather than reaching the generic invalid-content route
  error. Assert the 270-item document submits normally.

For every newly admitted mark/node in its release, add a mention-adjacency regression that places
the caret **immediately after** the relevant rendered/model boundary, types `@query`, asserts the
exact lookup argument, selects a returned suggestion, and asserts that the successful selection is
present in the submitted document. Cover the end of underline and strike text in 2A; the end of
both heading levels in 2B; and checked/unchecked task items, including allowed nested content, in
2C.

- `packages/shared/test/rich-text.test.ts`: use separate acceptance and rejection fixtures rather
  than only mixed broad categories. As their releases admit them, separately accept/reject
  underline, strike, h2, h3, unchecked task item, checked task item, and allowed depth-8 nesting;
  reject corresponding unsupported mark attributes, invalid heading levels/attrs/content,
  non-boolean or extra task-item attrs, invalid task-list children, orphan task items, malformed
  cross-list nesting, and d9/depth-greater-than-eight shapes. Include mixed legacy/new documents
  only in addition to these isolated cases, and retain plain-text/mention normalization coverage.
  Add a compatibility fixture for the currently accepted ordinary `listItem` whose first child is
  a nested list, so the Phase-2 parser cannot silently narrow the live contract. This fixture is
  deliberately **not** representable in the editor schema (`ListItem.content` is paragraph-first
  in v2 and v3 alike) and pins the intentional parser-is-more-permissive asymmetry; it must not be
  "fixed" to match the editor. In 2C add a fixture for an ordinary `listItem` containing a
  `taskList`, which the depth-8 chain requires the parser to accept. Add byte-boundary fixtures
  using canonical serialized JSON and the exact sizes above: the 270-item/32,458-byte checklist is
  accepted and the 280-item/33,658-byte checklist is rejected, asserting the measured
  `richTextDocByteLength` of each rather than a hand-copied constant.
- Extend Worker endpoint tests for all four method/route combinations—notice-board POST and PATCH,
  and project-comment POST and PATCH. For each newly admitted shape in the relevant release, run a
  separate valid fixture that stores and returns through each combination: underline, strike, h2,
  h3, unchecked task item, checked task item, and allowed nesting. Pair each with an isolated
  malformed counterpart that returns 400 on each combination; do not satisfy this with one mixed
  document. Retain author-only guards and link-containing documents on both routes, and require
  notice-board GET to re-parse each separately persisted valid shape rather than falling back to
  legacy text.

After each phase/sub-deploy is implemented, run from `portal/`:

```sh
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Then browser-verify the capabilities admitted by that sub-deploy on both surfaces: 2A verifies live
Markdown conversion, Cmd/Ctrl+Enter, mention selection, legacy bold/italic/link, underline/strike,
Link dialog edit/remove, and Undo/Redo, and additionally confirms on an **already-posted** notice
and comment that the recoloured link still reads as a link and is now visually distinct from
underlined text; 2B retains those checks and adds both named heading levels, confirming a
Section as the **first** block of a post has no stray top margin and that `## ` yields the larger
of the two; 2C retains all prior checks and adds normal/task lists plus read-only posted checklist
states, plus the byte guard — paste the 280-item checklist fixture and confirm the submit button is
disabled with the formatting-size message rather than a generic 400 from the server. For
each newly persisted shape, create, reload, author-edit unrelated text, save, and reload again
before declaring its sub-deploy live.

## Rollout

There is no D1 migration in Phase 1, 2A, 2B, or 2C: each persists through the existing
`contentJson` TEXT column, and the next unused migration number remains **0030**. After its own
commit and the complete verification sequence above, each release deploys the built SPA and API by
running exactly:

```sh
cd portal/workers/app && npx wrangler deploy
```

`wrangler deploy` uploads whatever is currently sitting in `apps/web/dist` — it does not build.
`npm run build -w @quincy/web` from the verification block above must therefore be the step
**immediately** before the deploy, in the same session and from the same working tree, or the
release ships a stale SPA bundle against a new API. A rebuild that predates a later source edit is
the failure mode to watch for.

Deploy **only** `workers/app` for Phase 1, then separately for 2A, 2B, and 2C. Do not deploy
`background` or `webhook-ingress`; neither Worker owns this code or needs a new binding/configuration.
Record the app Worker version and perform the stated two-surface browser verification before opening
the next sub-deploy. If a newly persisted shape has been saved, recover only with the compatible
roll-forward described above, not a parser/extension rollback.

## Routing and review

This is a **large cross-system change**, and its shared parser/renderer portion additionally routes
through the **Security, auth, payments, migrations** row of
[`docs/Subagent-Orchestration.md`](../Subagent-Orchestration.md): `parseRichTextDoc` is the trust
boundary for every write and `RichTextContent` renders user-supplied links. Therefore the Phase-2
parser/renderer changes use a max-effort Terra builder and a separate fresh max-effort Terra
reviewer, rather than the general large-change review tier. Phase 1's dependency-only compatibility
migration remains large-cross-system, but its review must explicitly inspect the same trust-boundary
adapters and static renderer behavior. Route the draft through fresh-context Terra plan review
(maximum two rounds), then Opus plan-tier review, before implementation. That path has now been
run to its terminal case: Terra plan review, then two Opus plan-tier rounds, both REQUEST CHANGES,
exhausting the two-revert cap; the round-2 findings were then applied by a reviewer editing this
document directly, and a fresh Opus instance reviews the result. Phase 1 and each of Phase
2A/2B/2C independently follow build → fresh Terra diff review → gate → deploy; do not batch their
commits or deploys merely because they share this plan. The normal final-draft review and independent
verification gate still apply to each.

Once every planned release is built, verified, committed, and deployed, update this status line
with the commit/deploy evidence and move the plan to `docs/plans/implemented/` with `git mv`.

## Review-focus decisions and risks

- **v2→v3 correctness:** the Simple Editor spike proves the template is v3-only and records the
  relevant API changes, but is not a substitute for hand-reviewing the actual dependency graph,
  extension configuration, commands, and v3 types. Phase 1 must prove no hidden behavior or JSON
  shape change before the redesign is allowed to start.
- **Link href round trip:** scrutinize every link-dialog, v3 StarterKit Link configuration, and
  converter edit for the known flat `href` ↔ `attrs.href` corruption regression. The existing-link
  load → unrelated edit → save test and the separate newly-created-link exact-shape test are
  required, not nice-to-haves.
- **Mentions at schema boundaries:** `textBetween` leaf separators are a live concern for newly
  introduced *inline leaf nodes*; underline/strike are marks and headings/task lists are blocks, so
  they do not themselves add that separator mechanism. Retain the adjacency matrix as
  defence-in-depth around conversion and caret boundaries, but focus review attention on the real
  inline-leaf path rather than inventing a separator bug for every new shape.
- **Persisted-schema rollback:** review the chosen 2A/2B/2C isolation, parser acceptance rules,
  converter registration, read rendering, and endpoint GET/PATCH behavior together. New content
  makes a parser rollback unsafe; any post-persistence defect must have a compatible roll-forward
  path.
- **Task-list static delivery:** verify the renderer has no input event or network mutation path,
  that it gives users a clear status, and that only the existing author edit flow can change
  `checked`.
- **Heading containment is structural, not procedural:** the heading-in-list rule is enforced by
  the narrowed `ListItem`/`TaskItem` content expressions, so review it as a schema property — is
  the expression correct, does it name only node types registered in that release, does the
  parser's acceptance match it — rather than auditing a guard for missed transaction paths. The
  earlier transaction-guard rationale (that a paragraph-first `ListItem` would break live content)
  was checked against `@tiptap/extension-list-item@2.27.2` and `@tiptap/extension-list@3.30.2` and
  is false: both are already `"paragraph block*"`. Do not reintroduce the guard on that reasoning.
- **Post-parse helpers are the sharpest edge in Phase 2:** `normalizeRichTextMentionLabels` runs on
  every write on both routes and its output is what is stored, and it drops `attrs` for any node
  type it does not explicitly name. Review the three helper fixes and the
  parse→normalize→parse composition test with the same care as the parser itself; a heading whose
  `attrs.level` is dropped is a silent data-integrity failure visible on the very next read, not a
  rendering nit.
- **Scope containment and visual adoption:** review that Simple Editor primitives are restyled into
  Quincy rather than importing its global theme, and that no unapproved extensions (alignment,
  search/replace, code, colours, emoji, images, or extra headings) enter through copied controls
  or StarterKit defaults.

## Non-blocking notes from the independent Opus self-review (fold in during build, no plan revision required)

The self-review approved this plan after reproducing every fix by executing real code (the helper
defects, all four proposed ProseMirror schemas built directly, the byte math, every CSS token
value) rather than trusting the write-up. It found no issue serious enough to block build, only
these wording/sequencing gaps worth resolving in passing:

1. The 2B test matrix's phrase "levels 1 and 4–6 unavailable in the enabled StarterKit
   schema/input rules" is imprecise: `level` is not schema-constrained (`{type:"heading",
   attrs:{level:1}}` validates against the built 2B editor schema). Enforcement is actually via
   commands + input rules + `parseHTML` + the shared parser, not the schema itself. The test as
   elaborated (typed Markdown and paste never yielding another level in emitted JSON) is correct
   and passes — just don't describe it as schema-level containment when writing the test names.
2. The byte-guard's own sub-deploy is never explicitly assigned in a Change section; only the
   browser-verification paragraph implies it belongs to 2C. State that explicitly.
3. The 2A/2B/2C literal config code blocks dropped Phase 1's `// existing content, editorProps,
   callbacks…` comment when they were copied forward — restore it for readability.
4. "All four are canonical values emitted by `tiptapToRichTextDoc`" is imprecise: the initial and
   edit-load values actually come from `EMPTY_DOC`/the server, not that function. Harmless, but fix
   if touching that sentence anyway.
5. The depth-limit (8) enforcement on the editor side names no concrete mechanism, and "reject the
   whole paste" sits in mild tension with this plan's own argument against transaction guards for
   the heading-in-list case. The *behavior* is unambiguous (don't let a user construct a d9
   document); only the *mechanism* is left to the builder's judgment.
6. `.rich-text ul.rich-text__task-list:first-child` in the CSS spec is redundant —
   `.rich-text ul:first-child` already matches it.
7. The chosen link-vs-underline distinction color (`--signal-info` #2f3b4d) is fairly low-contrast
   against `--text-primary` #0a0a0a. Already routed to browser verification in the test plan; no
   plan change needed, just don't skip that verification step.
