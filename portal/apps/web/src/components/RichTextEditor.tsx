import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import HardBreak from "@tiptap/extension-hard-break";
import Link from "@tiptap/extension-link";
import Mention from "@tiptap/extension-mention";
import { richTextPlainText, type RichTextDoc } from "@quincy/shared";
import { MentionAutocomplete, type MentionAutocompleteHandle, type MentionableUser } from "./MentionAutocomplete";

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
  const [query, setQuery] = useState<string | null>(null);
  const [mentionA11y, setMentionA11y] = useState<{ listboxId: string; activeId?: string; expanded: boolean } | null>(null);
  const extensions = useMemo(() => [
    StarterKit.configure({ heading: false, blockquote: false, codeBlock: false, horizontalRule: false, hardBreak: false, strike: false, code: false }),
    ListItemHardBreak,
    Link.configure({ openOnClick: false, autolink: false, linkOnPaste: false }),
    Mention.configure({ HTMLAttributes: { class: "rich-text__mention" }, suggestion: { items: () => [] } }),
  ], []);
  const editor = useEditor({
    extensions,
    content: toTiptap(value),
    editable: !disabled,
    editorProps: {
      attributes: { class: "rich-text__editor-content", "data-placeholder": placeholder, ...(id ? { id } : {}) },
      handleKeyDown: (view, event) => {
        if (menu.current?.handleKeyDown(event)) return true;
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          const plainText = richTextPlainText(tiptapToRichTextDoc(view.state.doc.toJSON()));
          if (plainText.trim().length > 0 && plainText.length <= limitRef.current && !disabledRef.current) {
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
      valueRef.current = JSON.stringify(doc); onChangeRef.current(doc); setQuery(mentionQuery(next));
    },
    onSelectionUpdate: ({ editor: next }) => setQuery(mentionQuery(next)),
  });

  useEffect(() => { if (editor) editor.setEditable(!disabled); }, [disabled, editor]);
  useEffect(() => {
    if (!editor) return;
    const serialised = JSON.stringify(value);
    if (serialised !== valueRef.current) { valueRef.current = serialised; editor.commands.setContent(toTiptap(value), false); }
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
  const selectMention = (user: MentionableUser) => {
    const activeQuery = query ?? "";
    const from = editor.state.selection.from - activeQuery.length - 1;
    editor.chain().focus().insertContentAt({ from, to: editor.state.selection.from }, { type: "mention", attrs: { id: user.id, label: user.name } }).insertContent(" ").run();
    setQuery(null);
  };
  const setLink = () => {
    const href = window.prompt("Link URL (HTTP or HTTPS)");
    if (!href) return;
    try { const url = new URL(href); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(); }
    catch { return; }
    editor.chain().focus().setLink({ href }).run();
  };
  return <div className={`rich-text-editor${disabled ? " is-disabled" : ""}`}>
    <div className="rich-text__toolbar" role="toolbar" aria-label="Formatting">
      <button type="button" aria-label="Bold" aria-pressed={editor.isActive("bold")} disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></button>
      <button type="button" aria-label="Italic" aria-pressed={editor.isActive("italic")} disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></button>
      <button type="button" aria-label="Link" aria-pressed={editor.isActive("link")} disabled={disabled} onClick={setLink}>Link</button>
      <button type="button" aria-label="Bullet list" aria-pressed={editor.isActive("bulletList")} disabled={disabled} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
      <button type="button" aria-label="Ordered list" aria-pressed={editor.isActive("orderedList")} disabled={disabled} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. List</button>
    </div>
    <EditorContent editor={editor} />
    <MentionAutocomplete ref={menu} query={query} loadMentionables={loadMentionables} onSelect={selectMention} onAccessibilityChange={setMentionA11y} />
    <div className={`rich-text__counter${plainText.length > limit ? " is-over" : ""}`} aria-live="polite">{plainText.length}/{limit}</div>
  </div>;
}
