import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { ChevronDownIcon, ListChecksIcon, ListIcon, ListOrderedIcon, Redo2Icon, TableIcon, Undo2Icon } from "lucide-react";
import { RICH_TEXT_JSON_MAX_BYTES, richTextDocByteLength, richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { cn } from "../lib/utils";
import {
  createRichTextEditorExtensions,
  type RichTextEditorPreset,
  itemContainerDepth,
  mentionQuery,
  shouldBlockListIndent,
  tiptapToRichTextDoc,
  toTiptap,
} from "../lib/rich-text-tiptap";
import { MentionAutocomplete, type MentionAutocompleteHandle, type MentionableUser } from "./MentionAutocomplete";
import { Button } from "./reui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./reui/dropdown-menu";
import { InputGroup, InputGroupAddon } from "./reui/input-group";
import { DeleteTableDialog } from "./reui/rich-text-editor/delete-table-dialog";
import { RichTextAlignMenu } from "./reui/rich-text-editor/rich-text-align";
import { RichTextHighlightPopover } from "./reui/rich-text-editor/rich-text-highlight";
import { RichTextLinkPopover } from "./reui/rich-text-editor/rich-text-link";
import { RichTextOutlineRail, scrollToRichTextHeading, useRichTextActiveHeading, useRichTextOutline } from "./reui/rich-text-editor/rich-text-outline";
import { RICH_TEXT_BASIC_SLASH_ITEMS, RichTextSlashCommand } from "./reui/rich-text-editor/rich-text-slash-menu";
import { useRichTextState } from "./reui/rich-text-editor/rich-text-state";
import { RICH_TEXT_TABLE_SLASH_ITEM, RichTextTableBubble } from "./reui/rich-text-editor/rich-text-table";
import {
  RichTextButton,
  RichTextToggle,
  RichTextToolbar,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./reui/rich-text-editor/rich-text-toolbar";

/**
 * The one Quincy rich-text editor, built on the vendored ReUI `rich-text-editor-2` parts in
 * `components/reui/rich-text-editor/` (#491, #492). `preset="composer"` is the compact
 * Project-discussion comment box: one `InputGroup` field with a roving-tabindex toolbar inside it.
 * `preset="document"` is the Notice board's page editor (#492): the same field plus alignment,
 * highlight and tables, a "/" block menu, a table bubble and an outline rail. The legacy
 * `RichTextEditor` is retired.
 *
 * What is deliberately NOT the vendor's:
 * - The extension set. The composer builds on `createRichTextEditorExtensions()` (the schema
 *   `parseRichTextDoc` accepts), never the vendor's `createRichTextExtensions`: that one enables h1,
 *   blockquote, code, codeBlock, hr, alignment and highlight, plus StarterKit's autolink, which turns
 *   a typed email into a `mailto:` mark the server rejects with a 400.
 * - The mention UI. `MentionAutocomplete` stays: the vendor's needs a synchronous candidate list
 *   (ours is async and project-scoped), pulls in cmdk, and lacks the #375 `aria-expanded` gate and
 *   Esc-in-any-state that `quincy/project-sheet-layers.ts` depends on.
 *
 * Retained from the legacy editor, each for a lessons.md reason: `rich-text__editor-content` on the
 * ProseMirror element (nine app.css selectors), `editorProps.handleKeyDown` with refs (callbacks
 * change per render), the `valueRef` no-op-transaction guard and the external `setContent` sync.
 */

/** The content surface inside an `InputGroup` that already draws the one border, ground and focus ring. */
const EDITOR_CONTENT_UTILITIES =
  "min-h-[var(--space-8)] w-full min-w-0 px-[var(--space-3)] py-[var(--space-2)] text-base md:text-sm " +
  "bg-transparent focus-visible:!outline-none ";

/** Room for the outline rail's dashes at the right edge (the rail is hidden on a phone). */
const DOCUMENT_CONTENT_UTILITIES = "min-[722px]:pe-12 ";

// The group wrapper's call-site divergences from `InputGroup` (#376): `has-disabled:bg-card` because
// the base's deep `:has(:disabled)` would paint the whole field sunken as soon as Undo/Redo are
// disabled (always, on an empty editor); the sunken ground is re-keyed to the wrapper's own
// `data-disabled` (important, so the higher-specificity `has-disabled` rule cannot beat it); and the
// focus ring is extended to the contenteditable, which the base's `input:focus-visible` misses.
const FIELD_GROUP =
  "group h-auto flex-col items-stretch has-disabled:bg-card data-[disabled]:bg-surface-sunken! " +
  "has-[[contenteditable=true]:focus-visible]:border-primary " +
  "has-[[contenteditable=true]:focus-visible]:outline-[length:var(--border-width-bold)] " +
  "has-[[contenteditable=true]:focus-visible]:outline-solid " +
  "has-[[contenteditable=true]:focus-visible]:outline-ring " +
  "has-[[contenteditable=true]:focus-visible]:outline-offset-2";

/** The character counter appears only from 90% of the limit (or when over it). */
const COUNTER_THRESHOLD = 0.9;

const HEADING_LABEL = { paragraph: "Paragraph", "heading-2": "Section", "heading-3": "Subsection" } as const;
const HEADING_VALUE = { "heading-2": "2", "heading-3": "3", paragraph: "" } as const;

export type QuincyRichTextEditorProps = {
  /** `"composer"`: the compact Project-discussion comment box. `"document"`: the Notice board page editor. */
  preset: RichTextEditorPreset;
  value: RichTextDoc;
  onChange: (value: RichTextDoc) => void;
  limit: number;
  /** The stored-JSON cap the surface's server profile enforces (default: the comment cap). */
  maxBytes?: number;
  disabled?: boolean;
  loadMentionables: (query: string) => Promise<MentionableUser[]>;
  placeholder?: string;
  id?: string;
  onSubmit?: () => void;
};

export function QuincyRichTextEditor({
  preset,
  value,
  onChange,
  limit,
  maxBytes = RICH_TEXT_JSON_MAX_BYTES,
  disabled = false,
  loadMentionables,
  placeholder = "Write a message…",
  id,
  onSubmit,
}: QuincyRichTextEditorProps) {
  const valueRef = useRef(JSON.stringify(value));
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit); onSubmitRef.current = onSubmit;
  const limitRef = useRef(limit); limitRef.current = limit;
  const maxBytesRef = useRef(maxBytes); maxBytesRef.current = maxBytes;
  const isDocument = preset === "document";
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const editorRef = useRef<Editor | null>(null);
  const menu = useRef<MentionAutocompleteHandle>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [rawQuery, setQuery] = useState<string | null>(null);
  // #375: Esc / an outside press closes the mention list and it stays closed until the content
  // actually changes; the sheet's layer gate reads the list as open through `aria-expanded`.
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const query = mentionDismissed ? null : rawQuery;
  const [mentionA11y, setMentionA11y] = useState<{ listboxId: string; activeId?: string; expanded: boolean } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [nestingBlocked, setNestingBlocked] = useState(false);
  const [deleteTableOpen, setDeleteTableOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const extensions = useMemo(() => [
    ...createRichTextEditorExtensions(preset),
    ...(preset === "document" ? [RichTextSlashCommand.configure({ items: [...RICH_TEXT_BASIC_SLASH_ITEMS, RICH_TEXT_TABLE_SLASH_ITEM] })] : []),
  ], [preset]);
  const editor = useEditor({
    extensions,
    // The toolbar subscribes to its own formatting snapshot (`useRichTextState`); the field itself
    // re-renders only on the props and state it owns.
    shouldRerenderOnTransaction: false,
    content: toTiptap(value),
    editable: !disabled,
    editorProps: {
      attributes: { class: "rich-text__editor-content " + EDITOR_CONTENT_UTILITIES + (preset === "document" ? DOCUMENT_CONTENT_UTILITIES : ""), "data-placeholder": placeholder, ...(id ? { id } : {}) },
      handleKeyDown: (view, event) => {
        if (menu.current?.handleKeyDown(event)) return true;
        if (shouldBlockListIndent(event, itemContainerDepth(view.state.selection.$from))) {
          event.preventDefault();
          view.dom.dispatchEvent(new Event("rich-text-nesting-blocked"));
          return true;
        }
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
          if (!disabledRef.current && editorRef.current?.can().setLink({ href: "https://example.com" })) {
            event.preventDefault();
            setLinkOpen(true);
            return true;
          }
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          const doc = tiptapToRichTextDoc(view.state.doc.toJSON());
          const plainText = richTextPlainText(doc);
          if (plainText.trim().length > 0 && plainText.length <= limitRef.current && richTextDocByteLength(doc) <= maxBytesRef.current && !disabledRef.current) {
            event.preventDefault();
            onSubmitRef.current?.();
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: next }) => {
      const doc = tiptapToRichTextDoc(next.getJSON());
      const serialised = JSON.stringify(doc);
      // Tiptap/ProseMirror can dispatch a no-op transaction (e.g. from a blur triggered by a
      // submit button click) that reports the same content as before. Propagating it anyway can
      // clobber a concurrent external reset (e.g. the composer clearing after a successful post)
      // that lands between this event and the next render.
      if (serialised === valueRef.current) return;
      valueRef.current = serialised; onChangeRef.current(doc); setNestingBlocked(false); setMentionDismissed(false); setQuery(mentionQuery(next));
    },
    onSelectionUpdate: ({ editor: next }) => setQuery(mentionQuery(next)),
  });
  editorRef.current = editor;
  const state = useRichTextState(editor);
  // The derived outline rail (document preset only; `null` keeps the composer's selector idle).
  const outline = useRichTextOutline(isDocument ? editor : null);
  const activeHeading = useRichTextActiveHeading(isDocument ? editor : null, pageRef, outline);

  useEffect(() => { if (editor) editor.setEditable(!disabled); }, [disabled, editor]);
  useEffect(() => {
    if (query === null) return;
    // Bubble phase on purpose: the Project sheet snapshots "is a layer open" at window-capture,
    // which must still see this list open for the very press that dismisses it.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && wrapperRef.current?.contains(event.target)) return;
      setMentionDismissed(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [query]);
  // Esc is only seen by the editor's key handler, so a list left open behind a Tab would hold the
  // sheet's layer gate shut for good: close it when focus leaves the editor.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onBlur = () => setMentionDismissed(true);
    dom.addEventListener("blur", onBlur);
    return () => dom.removeEventListener("blur", onBlur);
  }, [editor]);
  useEffect(() => {
    if (!editor) return;
    const announce = () => setNestingBlocked(true);
    editor.view.dom.addEventListener("rich-text-nesting-blocked", announce);
    return () => editor.view.dom.removeEventListener("rich-text-nesting-blocked", announce);
  }, [editor]);
  useEffect(() => {
    if (!editor) return;
    const serialised = JSON.stringify(value);
    if (serialised !== valueRef.current) {
      const applied = editor.commands.setContent(toTiptap(value), { emitUpdate: false });
      if (applied && JSON.stringify(tiptapToRichTextDoc(editor.getJSON())) === serialised) valueRef.current = serialised;
    }
  }, [editor, value]);
  useEffect(() => {
    if (!editor || !mentionA11y) return;
    const dom = editor.view.dom;
    dom.setAttribute("role", "combobox");
    dom.setAttribute("aria-haspopup", "listbox");
    dom.setAttribute("aria-expanded", String(mentionA11y.expanded));
    dom.setAttribute("aria-controls", mentionA11y.listboxId);
    if (mentionA11y.activeId) dom.setAttribute("aria-activedescendant", mentionA11y.activeId);
    else dom.removeAttribute("aria-activedescendant");
  }, [editor, mentionA11y]);
  if (!editor) return null;

  const plainText = richTextPlainText(value);
  const overBytes = richTextDocByteLength(value) > maxBytes;
  const selectMention = (user: MentionableUser) => {
    const activeQuery = query ?? "";
    const from = editor.state.selection.from - activeQuery.length - 1;
    editor.chain().focus().insertContentAt({ from, to: editor.state.selection.from }, { type: "mention", attrs: { id: user.id, label: user.name } }).insertContent(" ").run();
    setQuery(null);
  };
  const setBlock = (next: string) => {
    if (disabled || !state.canHeading) return;
    if (next === "2" || next === "3") editor.chain().focus().toggleHeading({ level: Number(next) as 2 | 3 }).run();
    else editor.chain().focus().setParagraph().run();
  };
  const off = (can: boolean) => disabled || !can;

  return <div ref={wrapperRef} className="group grid gap-[var(--space-2)]" data-disabled={disabled || undefined}>
    <InputGroup data-testid="rich-text-field" className={FIELD_GROUP} data-disabled={disabled || undefined}>
      <InputGroupAddon align="block-start" className="p-[var(--space-1)] cursor-default">
        <RichTextToolbar aria-label="Formatting" className="w-full min-w-0 gap-[var(--space-2)]">
          <RichTextToolbarGroup label="Text style">
            <RichTextToggle label="Bold" shortcut={["mod", "B"]} pressed={state.bold} disabled={off(state.canBold)} onToggle={() => editor.chain().focus().toggleBold().run()}><span aria-hidden="true" className="font-bold">B</span></RichTextToggle>
            <RichTextToggle label="Italic" shortcut={["mod", "I"]} pressed={state.italic} disabled={off(state.canItalic)} onToggle={() => editor.chain().focus().toggleItalic().run()}><span aria-hidden="true" className="italic">I</span></RichTextToggle>
            <RichTextToggle label="Underline" shortcut={["mod", "U"]} pressed={state.underline} disabled={off(state.canUnderline)} onToggle={() => editor.chain().focus().toggleUnderline().run()}><span aria-hidden="true" className="underline">U</span></RichTextToggle>
            <RichTextToggle label="Strikethrough" pressed={state.strike} disabled={off(state.canStrike)} onToggle={() => editor.chain().focus().toggleStrike().run()}><span aria-hidden="true" className="line-through">S</span></RichTextToggle>
          </RichTextToolbarGroup>
          <RichTextToolbarSeparator />
          <RichTextToolbarGroup label="Blocks">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="sm" aria-label="Heading" disabled={off(state.canHeading)} data-toolbar-item="" data-testid="rich-text-heading-menu" className="min-w-[112px] justify-between max-[721px]:h-11" />}
              >
                {HEADING_LABEL[state.blockType]}
                <ChevronDownIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup value={HEADING_VALUE[state.blockType]} onValueChange={(next) => setBlock(String(next))}>
                  <DropdownMenuRadioItem value="">Paragraph</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="2">Section</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="3">Subsection</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <RichTextLinkPopover editor={editor} state={state} disabled={disabled} testId="rich-text-link-popover" open={linkOpen} onOpenChange={setLinkOpen} />
            <RichTextToggle label="Bullet list" pressed={state.bulletList} disabled={off(state.canBulletList) || state.atListNestingLimit} onToggle={() => editor.chain().focus().toggleBulletList().run()}><ListIcon aria-hidden="true" /></RichTextToggle>
            <RichTextToggle label="Ordered list" pressed={state.orderedList} disabled={off(state.canOrderedList) || state.atListNestingLimit} onToggle={() => editor.chain().focus().toggleOrderedList().run()}><ListOrderedIcon aria-hidden="true" /></RichTextToggle>
            <RichTextToggle label="Checklist" pressed={state.taskList} disabled={off(state.canTaskList) || state.atListNestingLimit} onToggle={() => editor.chain().focus().toggleTaskList().run()}><ListChecksIcon aria-hidden="true" /></RichTextToggle>
          </RichTextToolbarGroup>
          {isDocument && <>
            <RichTextToolbarSeparator />
            <RichTextToolbarGroup label="Layout">
              <RichTextAlignMenu editor={editor} state={state} disabled={disabled} />
              <RichTextHighlightPopover editor={editor} state={state} />
              <RichTextButton label="Insert table" disabled={off(state.canInsertTable)} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon aria-hidden="true" /></RichTextButton>
            </RichTextToolbarGroup>
          </>}
          <RichTextToolbarSeparator />
          <RichTextToolbarGroup label="History">
            <RichTextButton label="Undo" shortcut={["mod", "Z"]} disabled={off(state.canUndo)} onClick={() => editor.chain().focus().undo().run()}><Undo2Icon aria-hidden="true" /></RichTextButton>
            <RichTextButton label="Redo" shortcut={["mod", "shift", "Z"]} disabled={off(state.canRedo)} onClick={() => editor.chain().focus().redo().run()}><Redo2Icon aria-hidden="true" /></RichTextButton>
          </RichTextToolbarGroup>
        </RichTextToolbar>
      </InputGroupAddon>
      <div ref={pageRef} className="relative w-full min-w-0">
        <EditorContent editor={editor} className="w-full min-w-0" />
        {isDocument && outline.length >= 2 && <RichTextOutlineRail outline={outline} activeIndex={activeHeading} onSelect={(index) => scrollToRichTextHeading(editor, index)} className="absolute end-1 top-2 z-[1] max-[721px]:hidden" />}
      </div>
    </InputGroup>
    {isDocument && <>
      <RichTextTableBubble editor={editor} onDeleteTable={() => setDeleteTableOpen(true)} />
      <DeleteTableDialog editor={editor} open={deleteTableOpen} onOpenChange={setDeleteTableOpen} />
    </>}
    <MentionAutocomplete ref={menu} query={query} loadMentionables={loadMentionables} onSelect={selectMention} onDismiss={() => setMentionDismissed(true)} onAccessibilityChange={setMentionA11y} />
    {plainText.length >= limit * COUNTER_THRESHOLD && <div data-testid="rich-text-counter" className={cn("text-right [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary", plainText.length > limit && "!text-destructive")}>{plainText.length}/{limit}</div>}
    <div className="min-h-[1.2em] [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-destructive" aria-live="polite">{overBytes ? "This formatting is too large to save; remove list items or formatting." : nestingBlocked ? "Maximum list nesting is four levels" : ""}</div>
  </div>;
}
