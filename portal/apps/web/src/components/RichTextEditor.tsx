import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Extension } from "@tiptap/core";
import { setBlockType } from "@tiptap/pm/commands";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import HardBreak from "@tiptap/extension-hard-break";
import Mention from "@tiptap/extension-mention";
import { ListItem, TaskItem, TaskList } from "@tiptap/extension-list";
import { isHttpUrl, RICH_TEXT_JSON_MAX_BYTES, RICH_TEXT_MAX_NESTING, richTextDocByteLength, richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { MentionAutocomplete, type MentionAutocompleteHandle, type MentionableUser } from "./MentionAutocomplete";
import { Modal } from "./Modal";
import { Button } from "./ui/button";

// §6.8 body-input state set, shared by the link dialog's URL field.
const FIELD_LABEL = "grid gap-[var(--space-1)] [font:var(--type-label)] text-[length:var(--text-xs)] text-foreground-secondary";
const FIELD_INPUT = "bg-card border-solid border-[length:var(--border-width-hair)] border-border " +
  "rounded-[var(--radius-sm)] [font:var(--type-body)] text-[length:var(--text-sm)] " +
  "px-[var(--space-3)] py-[var(--space-2)] text-foreground hover:border-border-hover " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 aria-invalid:border-destructive " +
  "max-[720px]:min-h-[44px]";
const FIELD_ERROR = "m-0 text-destructive text-[length:var(--text-xs)]";

function toTiptap(doc: RichTextDoc): Record<string, unknown> {
  const copy = (node: unknown): unknown => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const valueNode = node as Record<string, unknown>;
    if (valueNode.type === "text") return {
      type: "text",
      text: valueNode.text,
      ...(Array.isArray(valueNode.marks) ? { marks: valueNode.marks.map((mark) => {
        const current = mark as Record<string, unknown>;
        return current.type === "link" ? { type: "link", attrs: { href: current.href } } : { ...current };
      }) } : {}),
    };
    if (valueNode.type === "mention") return { type: "mention", attrs: { ...(valueNode.attrs as Record<string, unknown>) } };
    if (valueNode.type === "heading" || valueNode.type === "taskItem") return { type: valueNode.type, attrs: { ...(valueNode.attrs as Record<string, unknown>) }, ...(Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {}) };
    return { type: valueNode.type, ...(Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {}) };
  };
  return copy(doc) as Record<string, unknown>;
}

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

/** Tiptap's generic block commands otherwise lift a list item before making it a heading. */
const ListItemHeadingCommandBoundary = Extension.create({
  addCommands() {
    return {
      setNode: (typeOrName, attributes = {}) => (props) => {
        if ((typeof typeOrName === "string" ? typeOrName : typeOrName.name) === "heading" && (this.editor.isActive("listItem") || this.editor.isActive("taskItem"))) return false;
        const type = typeof typeOrName === "string" ? props.state.schema.nodes[typeOrName] : typeOrName;
        if (!type?.isTextblock) return false;
        const attributesToCopy = props.state.selection.$anchor.sameParent(props.state.selection.$head) ? props.state.selection.$anchor.parent.attrs : undefined;
        return props.chain()
          .command(({ commands }) => setBlockType(type, { ...attributesToCopy, ...attributes })(props.state) || commands.clearNodes())
          .command(({ state }) => setBlockType(type, { ...attributesToCopy, ...attributes })(state, props.dispatch))
          .run();
      },
    };
  },
});

const LIST_NESTING_CONTAINERS = new Set(["bulletList", "orderedList", "taskList", "listItem", "taskItem"]);
/** A level is a list plus its item; the server starts the outer list at depth zero. */
const RICH_TEXT_MAX_ITEM_CONTAINER_LEVELS = Math.floor((RICH_TEXT_MAX_NESTING + 1) / 2);

function isListNestingContainer(node: ProseMirrorNode): boolean {
  return LIST_NESTING_CONTAINERS.has(node.type.name);
}

function exceedsListNestingLimit(doc: ProseMirrorNode): boolean {
  const visit = (node: ProseMirrorNode, depth: number): boolean => {
    if (isListNestingContainer(node) && depth > RICH_TEXT_MAX_NESTING) return true;
    let exceeded = false;
    // Match parseBlock(): only descending from a list or list-item consumes nesting depth.
    node.forEach((child) => { if (!exceeded) exceeded = visit(child, depth + (isListNestingContainer(node) ? 1 : 0)); });
    return exceeded;
  };
  let exceeded = false;
  doc.forEach((child) => { if (!exceeded) exceeded = visit(child, 0); });
  return exceeded;
}

function itemContainerDepth($from: { depth: number; node: (depth: number) => { type: { name: string } } }): number {
  let count = 0;
  for (let depth = 0; depth <= $from.depth; depth += 1) {
    const name = $from.node(depth).type.name;
    if (name === "listItem" || name === "taskItem") count += 1;
  }
  return count;
}

export function shouldBlockListIndent(event: Pick<KeyboardEvent, "key" | "shiftKey">, depth: number): boolean {
  return event.key === "Tab" && !event.shiftKey && depth >= RICH_TEXT_MAX_ITEM_CONTAINER_LEVELS;
}

/** Rejects d9 list transactions before ProseMirror mutates the editor document. */
const ListNestingBoundary = Extension.create({
  name: "listNestingBoundary",
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction: (transaction) => {
        if (!transaction.docChanged || !exceedsListNestingLimit(transaction.doc)) return true;
        this.editor.view?.dom.dispatchEvent(new Event("rich-text-nesting-blocked"));
        return false;
      },
    })];
  },
});

/** The Phase 2C editor schema, shared with direct schema regression tests. */
export function createRichTextEditorExtensions() {
  const itemContent = "paragraph (paragraph|bulletList|orderedList|taskList)*";
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      hardBreak: false,
      strike: {},
      code: false,
      underline: {},
      listItem: false,
      listKeymap: false,
      trailingNode: false,
      undoRedo: {},
      link: { openOnClick: false, autolink: false, linkOnPaste: false },
    }),
    ListItem.extend({ content: itemContent }),
    ListItemHardBreak,
    TaskList.configure({}),
    TaskItem.extend({ content: itemContent }).configure({ nested: true }),
    Mention.configure({ HTMLAttributes: { class: "rich-text__mention" }, suggestion: { items: () => [] } }),
    ListItemHeadingCommandBoundary,
    ListNestingBoundary,
  ];
}

function ToolbarGroup({ children }: { children: ReactNode }) {
  return <div className="rich-text__toolbar-group">{children}</div>;
}

function ToolbarButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="rich-text__toolbar-button" aria-label={label} {...(active === undefined ? {} : { "aria-pressed": active })} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>;
}

function ToolbarDivider() { return <span className="rich-text__toolbar-divider" aria-hidden="true" />; }

/** Removes TipTap-only attributes before data leaves the browser. */
export function tiptapToRichTextDoc(value: unknown): RichTextDoc {
  const copy = (node: unknown): unknown => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const valueNode = node as Record<string, unknown>;
    if (valueNode.type === "text") return { type: "text", text: valueNode.text, ...(Array.isArray(valueNode.marks) ? { marks: valueNode.marks.map((mark) => {
      const current = mark as Record<string, unknown>;
      return current.type === "link" ? { type: "link", href: current.attrs && typeof current.attrs === "object" ? (current.attrs as Record<string, unknown>).href : undefined } : { type: current.type };
    }) } : {}) };
    if (valueNode.type === "mention") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "mention", attrs: { id: attrs?.id, label: attrs?.label } };
    }
    if (valueNode.type === "heading") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "heading", attrs: { level: attrs?.level }, ...(Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {}) };
    }
    if (valueNode.type === "taskItem") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "taskItem", attrs: { checked: attrs?.checked }, ...(Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {}) };
    }
    return { type: valueNode.type, ...(Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {}) };
  };
  return copy(value) as RichTextDoc;
}

function mentionQuery(editor: NonNullable<ReturnType<typeof useEditor>>): string | null {
  const { from } = editor.state.selection;
  const before = editor.state.doc.textBetween(Math.max(0, from - 160), from, "\n", (node) => node.type.name === "hardBreak" ? "\n" : "\0");
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? match[1]! : null;
}

export function RichTextEditor({ value, onChange, limit, disabled = false, loadMentionables, placeholder = "Write a message…", id, onSubmit }: {
  value: RichTextDoc;
  onChange: (value: RichTextDoc) => void;
  limit: number;
  disabled?: boolean;
  loadMentionables: (query: string) => Promise<MentionableUser[]>;
  placeholder?: string;
  id?: string;
  onSubmit?: () => void;
}) {
  const valueRef = useRef(JSON.stringify(value));
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit); onSubmitRef.current = onSubmit;
  const limitRef = useRef(limit); limitRef.current = limit;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const menu = useRef<MentionAutocompleteHandle>(null);
  const linkTrigger = useRef<HTMLButtonElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const linkErrorId = `rich-text-link-error-${useId()}`;
  const linkSelection = useRef<{ from: number; to: number } | undefined>(undefined);
  const linkWasActive = useRef(false);
  const returnFocusToLinkTrigger = useRef(false);
  const [query, setQuery] = useState<string | null>(null);
  const [mentionA11y, setMentionA11y] = useState<{ listboxId: string; activeId?: string; expanded: boolean } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [nestingBlocked, setNestingBlocked] = useState(false);
  const extensions = useMemo(createRichTextEditorExtensions, []);
  const editor = useEditor({
    extensions,
    shouldRerenderOnTransaction: true,
    content: toTiptap(value),
    editable: !disabled,
    editorProps: {
      attributes: { class: "rich-text__editor-content", "data-placeholder": placeholder, ...(id ? { id } : {}) },
      handleKeyDown: (view, event) => {
        if (menu.current?.handleKeyDown(event)) return true;
        if (shouldBlockListIndent(event, itemContainerDepth(view.state.selection.$from))) {
          event.preventDefault();
          view.dom.dispatchEvent(new Event("rich-text-nesting-blocked"));
          return true;
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          const doc = tiptapToRichTextDoc(view.state.doc.toJSON());
          const plainText = richTextPlainText(doc);
          if (plainText.trim().length > 0 && plainText.length <= limitRef.current && richTextDocByteLength(doc) <= RICH_TEXT_JSON_MAX_BYTES && !disabledRef.current) {
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
      valueRef.current = serialised; onChangeRef.current(doc); setNestingBlocked(false); setQuery(mentionQuery(next));
    },
    onSelectionUpdate: ({ editor: next }) => setQuery(mentionQuery(next)),
  });

  useEffect(() => { if (editor) editor.setEditable(!disabled); }, [disabled, editor]);
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
  // §6.7 — this is the one owner that stays. Initial focus becomes `Modal`'s
  // `initialFocus={linkInput}`; containment becomes `FloatingFocusManager modal`'s real trap.
  // This half is not `FloatingFocusManager`'s to take over: after Apply/Remove, focus must land
  // in the editor at the restored selection, not back on the trigger — see `Modal`'s
  // `returnFocus={false}` below and `applyLink`/`removeLink`'s `closeLinkDialog({returnFocus: false})`.
  useEffect(() => {
    if (linkOpen) return;
    if (returnFocusToLinkTrigger.current) {
      returnFocusToLinkTrigger.current = false;
      linkTrigger.current?.focus();
    }
  }, [linkOpen]);
  if (!editor) return null;
  const plainText = richTextPlainText(value);
  const overBytes = richTextDocByteLength(value) > RICH_TEXT_JSON_MAX_BYTES;
  const atListNestingLimit = itemContainerDepth(editor.state.selection.$from) >= RICH_TEXT_MAX_ITEM_CONTAINER_LEVELS;
  const selectMention = (user: MentionableUser) => {
    const activeQuery = query ?? "";
    const from = editor.state.selection.from - activeQuery.length - 1;
    editor.chain().focus().insertContentAt({ from, to: editor.state.selection.from }, { type: "mention", attrs: { id: user.id, label: user.name } }).insertContent(" ").run();
    setQuery(null);
  };
  const openLinkDialog = () => {
    const href = editor.getAttributes("link").href;
    const { from, to } = editor.state.selection;
    linkSelection.current = { from, to };
    linkWasActive.current = editor.isActive("link");
    setLinkHref(typeof href === "string" ? href : "");
    setLinkError(null);
    setLinkOpen(true);
  };
  const closeLinkDialog = ({ returnFocus = true }: { returnFocus?: boolean } = {}) => {
    returnFocusToLinkTrigger.current = returnFocus;
    setLinkOpen(false); setLinkError(null);
  };
  const applyLink = () => {
    const href = linkInput.current?.value ?? linkHref;
    if (!isHttpUrl(href)) { setLinkError("Enter a non-empty absolute HTTP(S) URL."); return; }
    const chain = editor.chain().focus();
    if (linkSelection.current) chain.setTextSelection(linkSelection.current);
    if (linkWasActive.current) chain.extendMarkRange("link");
    chain.setLink({ href }).run();
    closeLinkDialog({ returnFocus: false });
  };
  const removeLink = () => {
    const chain = editor.chain().focus();
    if (linkSelection.current) chain.setTextSelection(linkSelection.current);
    chain.unsetLink().run();
    closeLinkDialog({ returnFocus: false });
  };
  const canUseHeading = !disabled && (editor.can().toggleHeading({ level: 2 }) || editor.can().toggleHeading({ level: 3 }));
  return <div className={`rich-text-editor${disabled ? " is-disabled" : ""}`}>
    <div className="rich-text__toolbar" role="toolbar" aria-label="Formatting">
      <ToolbarGroup>
        <ToolbarButton label="Bold" active={editor.isActive("bold")} disabled={disabled || !editor.can().toggleBold()} onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></ToolbarButton>
        <ToolbarButton label="Italic" active={editor.isActive("italic")} disabled={disabled || !editor.can().toggleItalic()} onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></ToolbarButton>
        <ToolbarButton label="Underline" active={editor.isActive("underline")} disabled={disabled || !editor.can().toggleUnderline()} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></ToolbarButton>
        <ToolbarButton label="Strikethrough" active={editor.isActive("strike")} disabled={disabled || !editor.can().toggleStrike()} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></ToolbarButton>
      </ToolbarGroup>
      <ToolbarDivider />
      <ToolbarGroup>
        <select className="rich-text__toolbar-select" aria-label="Heading" value={editor.isActive("heading", { level: 2 }) ? "2" : editor.isActive("heading", { level: 3 }) ? "3" : ""} disabled={!canUseHeading} onChange={(event) => {
          if (!canUseHeading) return;
          const level = event.currentTarget.value;
          if (level === "2" || level === "3") editor.chain().focus().toggleHeading({ level: Number(level) as 2 | 3 }).run();
          else editor.chain().focus().setParagraph().run();
        }}>
          <option value="">Paragraph</option>
          <option value="2">Section</option>
          <option value="3">Subsection</option>
        </select>
        <button ref={linkTrigger} type="button" className="rich-text__toolbar-button" aria-label="Link" aria-pressed={editor.isActive("link")} disabled={disabled || !editor.can().setLink({ href: "https://example.com" })} onMouseDown={(event) => event.preventDefault()} onClick={openLinkDialog}>Link</button>
        <ToolbarButton label="Bullet list" active={editor.isActive("bulletList")} disabled={disabled || atListNestingLimit || !editor.can().toggleBulletList()} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</ToolbarButton>
        <ToolbarButton label="Ordered list" active={editor.isActive("orderedList")} disabled={disabled || atListNestingLimit || !editor.can().toggleOrderedList()} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. List</ToolbarButton>
        <ToolbarButton label="Checklist" active={editor.isActive("taskList")} disabled={disabled || atListNestingLimit || !editor.can().toggleTaskList()} onClick={() => editor.chain().focus().toggleTaskList().run()}>☑ List</ToolbarButton>
      </ToolbarGroup>
      <ToolbarDivider />
      <ToolbarGroup>
        <ToolbarButton label="Undo" disabled={disabled || !editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>Undo</ToolbarButton>
        <ToolbarButton label="Redo" disabled={disabled || !editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>Redo</ToolbarButton>
      </ToolbarGroup>
    </div>
    <Modal
      open={linkOpen}
      onClose={() => closeLinkDialog()}
      returnFocus={false}
      title={linkWasActive.current ? "Edit link" : "Add link"}
      initialFocus={linkInput}
      testId="rich-text-link-modal"
      describedBy={linkError ? linkErrorId : undefined}
      footer={<>
        {linkWasActive.current && <Button variant="secondary" onClick={removeLink}>Remove link</Button>}
        <span className="flex-1" />
        <Button variant="secondary" onClick={() => closeLinkDialog()}>Cancel</Button>
        <Button onClick={applyLink}>Apply link</Button>
      </>}
    >
      <label className={FIELD_LABEL}>URL
        <input
          ref={linkInput}
          className={FIELD_INPUT}
          type="url"
          value={linkHref}
          onInput={(event) => { setLinkHref(event.currentTarget.value); setLinkError(null); }}
          onChange={(event) => { setLinkHref(event.target.value); setLinkError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyLink(); } }}
          aria-invalid={linkError ? true : undefined}
          placeholder="https://example.com"
        />
      </label>
      {linkError && <p id={linkErrorId} className={FIELD_ERROR} role="alert">{linkError}</p>}
    </Modal>
    <EditorContent editor={editor} />
    <MentionAutocomplete ref={menu} query={query} loadMentionables={loadMentionables} onSelect={selectMention} onAccessibilityChange={setMentionA11y} />
    <div className={`rich-text__counter${plainText.length > limit ? " is-over" : ""}`}>{plainText.length}/{limit}</div>
    <div className="rich-text__validation" aria-live="polite">{overBytes ? "This formatting is too large to save; remove list items or formatting." : nestingBlocked ? "Maximum list nesting is four levels" : ""}</div>
  </div>;
}
