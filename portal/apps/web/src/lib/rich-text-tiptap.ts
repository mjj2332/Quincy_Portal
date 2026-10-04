import { Extension } from "@tiptap/core";
import { setBlockType } from "@tiptap/pm/commands";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import HardBreak from "@tiptap/extension-hard-break";
import Mention from "@tiptap/extension-mention";
import { ListItem, TaskItem, TaskList } from "@tiptap/extension-list";
import { RICH_TEXT_MAX_NESTING, type RichTextDoc } from "@quincy/shared";

// The Tiptap <-> stored RichTextDoc contract, shared by the legacy `RichTextEditor` (still serving
// the Notice board until #492) and `QuincyRichTextEditor` (Project discussion, #491). Relocated
// verbatim from `components/RichTextEditor.tsx`: the schema here is the one `parseRichTextDoc`
// accepts, so both editors must build on it and never on a vendor extension set.

export function toTiptap(doc: RichTextDoc): Record<string, unknown> {
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

export function mentionQuery(editor: NonNullable<ReturnType<typeof useEditor>>): string | null {
  const { from } = editor.state.selection;
  const before = editor.state.doc.textBetween(Math.max(0, from - 160), from, "\n", (node) => node.type.name === "hardBreak" ? "\n" : "\0");
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? match[1]! : null;
}
