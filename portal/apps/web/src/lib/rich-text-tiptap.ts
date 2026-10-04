import { Extension } from "@tiptap/core";
import { setBlockType } from "@tiptap/pm/commands";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import HardBreak from "@tiptap/extension-hard-break";
import Mention from "@tiptap/extension-mention";
import { Highlight } from "@tiptap/extension-highlight";
import { ListItem, TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { RICH_TEXT_HIGHLIGHT_COLORS, RICH_TEXT_MAX_NESTING, type RichTextDoc } from "@quincy/shared";

// The Tiptap <-> stored RichTextDoc contract for `QuincyRichTextEditor`, in its two presets:
// `"composer"` (Project discussion, #491) and `"document"` (Notice board, #492). The schema here is
// the one `parseRichTextDoc` accepts (comment profile for the composer, notice profile for the
// document), so the editor builds on it and never on a vendor extension set. Every attribute that
// is stored has an explicit mapping in BOTH directions below: a mark or attribute with no mapping
// collapses to `{ type }` and silently loses its value (docs/lessons.md, 2026-08-18).
export type RichTextEditorPreset = "composer" | "document";

const DEFAULT_HIGHLIGHT = RICH_TEXT_HIGHLIGHT_COLORS[0];

/** Stored alignment is omitted for left; Tiptap's own default is the string "left". */
function tiptapTextAlign(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
  return typeof attrs?.textAlign === "string" ? { textAlign: attrs.textAlign } : {};
}

export function toTiptap(doc: RichTextDoc): Record<string, unknown> {
  const copy = (node: unknown): unknown => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const valueNode = node as Record<string, unknown>;
    if (valueNode.type === "text") return {
      type: "text",
      text: valueNode.text,
      ...(Array.isArray(valueNode.marks) ? { marks: valueNode.marks.map((mark) => {
        const current = mark as Record<string, unknown>;
        if (current.type === "link") return { type: "link", attrs: { href: current.href } };
        if (current.type === "highlight") return { type: "highlight", attrs: { color: current.color } };
        return { ...current };
      }) } : {}),
    };
    if (valueNode.type === "mention") return { type: "mention", attrs: { ...(valueNode.attrs as Record<string, unknown>) } };
    if (valueNode.type === "heading" || valueNode.type === "taskItem") return { type: valueNode.type, attrs: { ...(valueNode.attrs as Record<string, unknown>) }, ...(Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {}) };
    if (valueNode.type === "paragraph" && valueNode.attrs) return { type: "paragraph", attrs: tiptapTextAlign(valueNode.attrs as Record<string, unknown>), ...(Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {}) };
    if (valueNode.type === "tableCell" || valueNode.type === "tableHeader") {
      const attrs = valueNode.attrs as { colspan?: number; rowspan?: number } | undefined;
      return { type: valueNode.type, attrs: { colspan: attrs?.colspan ?? 1, rowspan: attrs?.rowspan ?? 1 }, ...(Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {}) };
    }
    return { type: valueNode.type, ...(Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {}) };
  };
  return copy(doc) as Record<string, unknown>;
}

export const ListItemHardBreak = HardBreak.extend({
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
export const ListItemHeadingCommandBoundary = Extension.create({
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
export const RICH_TEXT_MAX_ITEM_CONTAINER_LEVELS = Math.floor((RICH_TEXT_MAX_NESTING + 1) / 2);

function isListNestingContainer(node: ProseMirrorNode): boolean {
  return LIST_NESTING_CONTAINERS.has(node.type.name);
}

export function exceedsListNestingLimit(doc: ProseMirrorNode): boolean {
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

export function itemContainerDepth($from: { depth: number; node: (depth: number) => { type: { name: string } } }): number {
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
export const ListNestingBoundary = Extension.create({
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

/**
 * Highlight stores the colour id, never inline CSS (the vendor's `rich-text-highlight.tsx` defined
 * this; it lives here so the schema module has no UI import). A bare `setHighlight()` has no colour,
 * which the server would reject, so `tiptapToRichTextDoc` maps it to the default.
 */
export const RichTextHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-color"),
        renderHTML: (attributes) => attributes.color ? { "data-color": attributes.color } : {},
      },
    };
  },
});

// Cells hold paragraphs only (the stored contract); TableKit's default `block+` would let the
// editor build a list in a cell that the server then rejects.
const CELL_CONTENT = "paragraph+";

/** Document-only nodes and attributes: tables, alignment and highlight (#492). */
function documentExtensions() {
  return [
    // Not resizable (no stored `colwidth`); the wrapper scrolls a wide table sideways on a phone, and
    // `cellMinWidth` sets the table's inline `min-width` (cells x 96px) that makes it overflow there.
    Table.configure({ resizable: false, renderWrapper: true, cellMinWidth: 96 }),
    TableRow,
    TableHeader.extend({ content: CELL_CONTENT }),
    TableCell.extend({ content: CELL_CONTENT }),
    TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right", "justify"] }),
    RichTextHighlight.configure({ multicolor: true }),
  ];
}

/** The editor schema for a preset, shared with direct schema regression tests. */
export function createRichTextEditorExtensions(preset: RichTextEditorPreset = "composer") {
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
    ...(preset === "document" ? documentExtensions() : []),
  ];
}

/** Removes TipTap-only attributes before data leaves the browser. */
export function tiptapToRichTextDoc(value: unknown): RichTextDoc {
  const alignAttrs = (attrs: Record<string, unknown> | undefined) => {
    const align = attrs?.textAlign;
    return typeof align === "string" && align !== "left" ? { textAlign: align } : {};
  };
  const copy = (node: unknown): unknown => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const valueNode = node as Record<string, unknown>;
    const children = Array.isArray(valueNode.content) ? { content: valueNode.content.map(copy) } : {};
    if (valueNode.type === "text") return { type: "text", text: valueNode.text, ...(Array.isArray(valueNode.marks) ? { marks: valueNode.marks.map((mark) => {
      const current = mark as Record<string, unknown>;
      const attrs = current.attrs && typeof current.attrs === "object" ? current.attrs as Record<string, unknown> : undefined;
      if (current.type === "link") return { type: "link", href: attrs?.href };
      if (current.type === "highlight") return { type: "highlight", color: typeof attrs?.color === "string" ? attrs.color : DEFAULT_HIGHLIGHT };
      return { type: current.type };
    }) } : {}) };
    if (valueNode.type === "mention") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "mention", attrs: { id: attrs?.id, label: attrs?.label } };
    }
    if (valueNode.type === "heading") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "heading", attrs: { level: attrs?.level, ...alignAttrs(attrs) }, ...children };
    }
    if (valueNode.type === "paragraph") {
      const attrs = alignAttrs(valueNode.attrs as Record<string, unknown> | undefined);
      return { type: "paragraph", ...(Object.keys(attrs).length ? { attrs } : {}), ...children };
    }
    if (valueNode.type === "taskItem") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "taskItem", attrs: { checked: attrs?.checked }, ...children };
    }
    if (valueNode.type === "tableCell" || valueNode.type === "tableHeader") {
      const attrs = valueNode.attrs as { colspan?: number; rowspan?: number } | undefined;
      const colspan = attrs?.colspan ?? 1; const rowspan = attrs?.rowspan ?? 1;
      return { type: valueNode.type, ...(colspan !== 1 || rowspan !== 1 ? { attrs: { colspan, rowspan } } : {}), ...children };
    }
    return { type: valueNode.type, ...children };
  };
  return copy(value) as RichTextDoc;
}

export function mentionQuery(editor: NonNullable<ReturnType<typeof useEditor>>): string | null {
  const { from } = editor.state.selection;
  const before = editor.state.doc.textBetween(Math.max(0, from - 160), from, "\n", (node) => node.type.name === "hardBreak" ? "\n" : "\0");
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? match[1]! : null;
}
