import { Extension, Node as TiptapNode, mergeAttributes } from "@tiptap/core";
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
import { TableMap } from "@tiptap/pm/tables";
import { TextAlign } from "@tiptap/extension-text-align";
import { embeddedMediaPosterUrl, embeddedMediaUrl } from "./embedded-media-core";
import { isHttpUrl, RICH_TEXT_HIGHLIGHT_COLORS, RICH_TEXT_MAX_NESTING, RICH_TEXT_TABLE_MAX_COLUMNS, RICH_TEXT_TABLE_MAX_ROWS, type RichTextDoc } from "@quincy/shared";

// The Tiptap <-> stored RichTextDoc contract for `QuincyRichTextEditor`, in its two presets:
// `"composer"` (Project discussion, #491), `"document"` (Notice board, #492) and `"note"` (a note or reply on a Video, #927). The schema here is
// the one `parseRichTextDoc` accepts (comment profile for the composer, notice profile for the
// document), so the editor builds on it and never on a vendor extension set. Every attribute that
// is stored has an explicit mapping in BOTH directions below: a mark or attribute with no mapping
// collapses to `{ type }` and silently loses its value (docs/lessons.md, 2026-08-18).
export type RichTextEditorPreset = "composer" | "document" | "note";

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
    if (valueNode.type === "image") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "image", attrs: { mediaId: attrs?.mediaId, ...(typeof attrs?.alt === "string" && attrs.alt ? { alt: attrs.alt } : {}) } };
    }
    if (valueNode.type === "video") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "video", attrs: { mediaId: attrs?.mediaId, ...(typeof attrs?.hasPoster === "boolean" ? { hasPoster: attrs.hasPoster } : {}) } };
    }
    if (valueNode.type === "linkPreview") return { type: "linkPreview", attrs: { ...(valueNode.attrs as Record<string, unknown>) } };
    if (valueNode.type === "attachment") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "attachment", attrs: { attachmentId: attrs?.attachmentId, ...(typeof attrs?.name === "string" ? { name: attrs.name } : {}), ...(typeof attrs?.bytes === "number" ? { bytes: attrs.bytes } : {}) } };
    }
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

function normaliseHighlightColor(value: unknown): string | null {
  return typeof value === "string" && (RICH_TEXT_HIGHLIGHT_COLORS as readonly string[]).includes(value) ? value : null;
}

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
        // Pasted HTML can carry any colour (`#faf594`); only the stored ids survive, the rest become the
        // bare mark that `tiptapToRichTextDoc` maps to the default.
        parseHTML: (element) => normaliseHighlightColor(element.getAttribute("data-color")),
        renderHTML: (attributes) => attributes.color ? { "data-color": attributes.color } : {},
      },
    };
  },
});

// Cells hold paragraphs only (the stored contract); TableKit's default `block+` would let the
// editor build a list in a cell that the server then rejects.
const CELL_CONTENT = "paragraph+";

/**
 * An embedded image (#493): an atom that names stored media by id. It deliberately has no `parseHTML`
 * rule, so pasted or dropped HTML (a foreign `<img>`, a base64 `data:` URL) never becomes a node; the
 * only way in is the editor's own upload, which inserts one after the server accepts the file.
 */
export const EmbeddedImage = TiptapNode.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  // `alt` (#553) is the author's description, defaulting to the cleaned file name; absent on older images, which fall back to "Embedded image".
  /** `mediaUrl` (#835) is where a medium's bytes are read from: the staff route by default, a Review link's own for a guest. */
  addOptions() { return { mediaUrl: embeddedMediaUrl as (mediaId: string) => string }; },
  addAttributes() { return { mediaId: { default: null }, alt: { default: null, rendered: false } }; },
  parseHTML() { return []; },
  renderHTML({ node, HTMLAttributes }) {
    const mediaId = String(node.attrs.mediaId ?? "");
    return ["img", mergeAttributes(HTMLAttributes, { src: this.options.mediaUrl(mediaId), alt: typeof node.attrs.alt === "string" && node.attrs.alt ? node.attrs.alt : "Embedded image", "data-media-id": mediaId, class: "rich-text__embedded-image" })];
  },
});

/**
 * An embedded video (#494): an atom that names stored media by id, exactly like the image. No `parseHTML` rule, so a pasted `<video>`
 * never becomes a node. In the editor it is a muted, inline preview with its poster and no controls (playing happens in the posted
 * comment); it only preloads metadata, so a comment with several videos does not pull them all down.
 */
export const EmbeddedVideo = TiptapNode.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  // `hasPoster` (#556) is whether the server kept a poster frame; `null` (an older node, a draft) means unknown, which asks for the poster as before. Never stored.
  addOptions() { return { mediaUrl: embeddedMediaUrl as (mediaId: string) => string, posterUrl: embeddedMediaPosterUrl as (mediaId: string) => string }; },
  addAttributes() { return { mediaId: { default: null }, hasPoster: { default: null, rendered: false } }; },
  parseHTML() { return []; },
  renderHTML({ node, HTMLAttributes }) {
    const mediaId = String(node.attrs.mediaId ?? "");
    return ["video", mergeAttributes(HTMLAttributes, { src: this.options.mediaUrl(mediaId), ...(node.attrs.hasPoster === false ? {} : { poster: this.options.posterUrl(mediaId) }), preload: "metadata", muted: "", playsinline: "", "data-media-id": mediaId, class: "rich-text__embedded-video" })];
  },
});

/**
 * A link preview card (#497): an atom that names a server-held preview by id. The display fields (address, title, description, site,
 * image) are served by the server and live on the editor node only so the card can draw; `tiptapToRichTextDoc` strips them back to the
 * id. No `parseHTML` rule, so pasted HTML never becomes a card: the only way in is the editor's own request after a link is applied.
 */
export const LinkPreview = TiptapNode.create({
  name: "linkPreview",
  group: "block",
  atom: true,
  draggable: false,
  selectable: true,
  addAttributes() { return { previewId: { default: null }, url: { default: null }, title: { default: null }, description: { default: null }, siteName: { default: null }, imageMediaId: { default: null } }; },
  parseHTML() { return []; },
  renderHTML({ node }) { return ["div", { "data-link-preview": String(node.attrs.previewId ?? ""), class: "rich-text__link-preview" }, String(node.attrs.title ?? node.attrs.url ?? "")]; },
});

/**
 * An Attachment (#952): an atom that names a stored file by id, at the top level only. `name` and `bytes` are what the server serves for the
 * chip and live on the editor node only so it can draw; `tiptapToRichTextDoc` strips them back to the id. No `parseHTML` rule, so pasted
 * HTML never becomes one: the only way in is the editor's own upload. In the note preset (a Project discussion comment) and the document
 * preset (a notice, #954), where the box's strip draws it; it renders nothing in the text.
 */
export const Attachment = TiptapNode.create({
  name: "attachment",
  group: "block",
  atom: true,
  draggable: false,
  // Like a note's photo or video: an invisible atom the caret steps over, removed by its chip's x, a selection deleted over it, Backspace or Delete.
  selectable: false,
  addAttributes() { return { attachmentId: { default: null }, name: { default: null, rendered: false }, bytes: { default: null, rendered: false } }; },
  parseHTML() { return []; },
  renderHTML({ node }) { return ["div", { "data-attachment-id": String(node.attrs.attachmentId ?? ""), class: "rich-text__attachment", hidden: "" }]; },
  addNodeView() {
    return () => {
      const dom = document.createElement("div");
      dom.hidden = true; dom.contentEditable = "false"; dom.dataset.noteMedia = "attachment";
      return { dom, ignoreMutation: () => true };
    };
  },
});

/** The address a link or card names, as the server normalises it (a card's `url` is the normalised form of the link it was fetched for). */
function previewAddress(href: unknown): string {
  const raw = String(href ?? "");
  try { return new URL(raw).href; } catch { return raw; }
}
function linkAddresses(doc: ProseMirrorNode): Set<string> {
  const found = new Set<string>();
  doc.descendants((child) => { for (const mark of child.marks) if (mark.type.name === "link") found.add(previewAddress(mark.attrs.href)); });
  return found;
}

/**
 * A link preview goes with its link (#949): a change that removes the last link to an address removes that address's card in an
 * appended transaction, which the undo history folds into the same step, so one undo brings back both. A card stays while any link to
 * its address remains, and a card whose link was never in the editor (an older post) is left alone. Nothing here touches the host
 * replacing the content (`preventUpdate`) or an undo / redo, so history stays an exact inverse.
 */
export const LinkPreviewFollowsLink = Extension.create({
  name: "linkPreviewFollowsLink",
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, oldState, newState) {
        if (!transactions.some((tr) => tr.docChanged)) return null;
        if (transactions.some((tr) => tr.getMeta("preventUpdate") || tr.getMeta("history$"))) return null;
        const carded: { node: ProseMirrorNode; pos: number; address: string }[] = [];
        newState.doc.forEach((child, offset) => { if (child.type.name === "linkPreview") carded.push({ node: child, pos: offset, address: previewAddress(child.attrs.url) }); });
        if (carded.length === 0) return null;
        const before = linkAddresses(oldState.doc); const after = linkAddresses(newState.doc);
        const orphaned = carded.filter(({ address }) => before.has(address) && !after.has(address));
        if (orphaned.length === 0) return null;
        const tr = newState.tr;
        for (const { node, pos } of orphaned.reverse()) tr.delete(pos, pos + node.nodeSize);
        return tr;
      },
    })];
  },
});

/** Rows x columns of a table node, spans included (what the server's limits count). */
export function tableDimensions(table: ProseMirrorNode): { rows: number; columns: number } {
  const map = TableMap.get(table);
  return { rows: map.height, columns: map.width };
}

export function exceedsTableLimit(doc: ProseMirrorNode): boolean {
  let exceeded = false;
  doc.descendants((node) => {
    if (exceeded) return false;
    if (node.type.name !== "table") return true;
    const { rows, columns } = tableDimensions(node);
    exceeded = rows > RICH_TEXT_TABLE_MAX_ROWS || columns > RICH_TEXT_TABLE_MAX_COLUMNS;
    return false;
  });
  return exceeded;
}

/** Rejects a transaction (a command, Tab in the last cell, a paste) that grows a table past the server's limits. */
export const TableSizeBoundary = Extension.create({
  name: "tableSizeBoundary",
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction: (transaction) => !transaction.docChanged || !exceedsTableLimit(transaction.doc),
    })];
  },
});

/** Document-only nodes and attributes: tables, alignment and highlight (#492). */
function documentExtensions() {
  return [
    // Not resizable (no stored `colwidth`); the wrapper scrolls a wide table sideways on a phone, and
    // `cellMinWidth` sets the table's inline `min-width` (cells x 96px) that makes it overflow there.
    Table.configure({ resizable: false, renderWrapper: true, cellMinWidth: 96 }),
    TableRow,
    TableSizeBoundary,
    TableHeader.extend({ content: CELL_CONTENT }),
    TableCell.extend({ content: CELL_CONTENT }),
    TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right", "justify"] }),
    RichTextHighlight.configure({ multicolor: true }),
  ];
}

/**
 * A note (#927) cannot make a heading or a checklist, yet an old note keeps the ones it has: the nodes stay in the schema so it loads
 * and round-trips unchanged (`parseRichTextDoc` still accepts them), but nothing new can be made. No input rule (`## `, `[ ] `), no
 * shortcut (Mod-Alt-2, Mod-Shift-9), and the commands are kept but refuse (so `can()` answers false rather than throwing, which the
 * shared `useRichTextState` selector would). No paste rule either: a pasted `<h2>` lands as a paragraph and a pasted checklist as a
 * bulleted list, since the parser falls back to the paragraph and the bullet list's own `ul` / `li` rules.
 */
const refuse = () => () => false;
const NoteHeading = TiptapNode.create({
  name: "heading",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() { return { level: { default: 2, rendered: false } }; },
  parseHTML() { return []; },
  renderHTML({ node, HTMLAttributes }) { return [`h${node.attrs.level === 3 ? 3 : 2}`, mergeAttributes(HTMLAttributes), 0]; },
  addCommands() { return { setHeading: refuse, toggleHeading: refuse }; },
});
const NoteTaskList = TaskList.extend({
  parseHTML() { return []; },
  addInputRules() { return []; },
  addKeyboardShortcuts() { return {}; },
  addCommands() { return { toggleTaskList: refuse }; },
});
const noteTaskItem = (content: string) => TaskItem.extend({ content, parseHTML() { return []; }, addInputRules() { return []; } }).configure({ nested: true });

// An Attachment (#952) is drawn by the same strip, so it is part of the same tail.
const isMediaNode = (node: ProseMirrorNode) => node.type.name === "image" || node.type.name === "video" || node.type.name === "attachment";
const mediaIdOf = (node: ProseMirrorNode) => String(node.attrs.mediaId ?? node.attrs.attachmentId ?? "");
/** Where the run of `isTailNode` nodes that ends the document starts (its size when it does not end with one). */
function tailStartOf(doc: ProseMirrorNode, isTailNode: (node: ProseMirrorNode) => boolean): number {
  let start = doc.content.size;
  for (let index = doc.childCount - 1; index >= 0; index -= 1) {
    const child = doc.child(index);
    if (!isTailNode(child)) break;
    start -= child.nodeSize;
  }
  return start;
}
/** Where the run of media that ends the note starts (the document's size when it does not end with media). */
export const noteMediaTailStart = (doc: ProseMirrorNode): number => tailStartOf(doc, isMediaNode);

/**
 * A note's photos and videos are a strip after its text (#927, frame C4), drawn outside the text (`QuincyRichTextEditorBase`), so the
 * text holds them as invisible atoms. A photo or video new to the note that is not in the run that ends it is moved to the end: the
 * editor's own upload already lands it there, and this is the backstop for anything else that inserts one (a paste, a drop).
 * Removing one is the author's call (owner decision 2026-10-20, "Allow delete"): its chip's ×, a selection deleted over it, Backspace
 * or Delete all remove it, and undo brings it back. Nothing here touches the host replacing the content (`preventUpdate`) or an undo /
 * redo, and a photo an old note holds between paragraphs stays where it is: the stored order is never rewritten.
 */
function mediaTail(name: string, isTailNode: (node: ProseMirrorNode) => boolean) {
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [new Plugin({
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (transactions.some((tr) => tr.getMeta("preventUpdate") || tr.getMeta("history$"))) return null;
          const known = new Set<string>();
          oldState.doc.forEach((child) => { if (isTailNode(child)) known.add(mediaIdOf(child)); });
          // What is new to the post and landed before the run that ends it, in document order.
          const tail = tailStartOf(newState.doc, isTailNode);
          const stray: { node: ProseMirrorNode; pos: number }[] = [];
          newState.doc.forEach((child, offset) => { if (isTailNode(child) && offset < tail && !known.has(mediaIdOf(child))) stray.push({ node: child, pos: offset }); });
          if (stray.length === 0) return null;
          const tr = newState.tr;
          for (const { node, pos } of [...stray].reverse()) tr.delete(pos, pos + node.nodeSize);
          tr.insert(tr.doc.content.size, stray.map(({ node }) => node));
          return tr;
        },
      })];
    },
  });
}
export const NoteMediaTail = mediaTail("noteMediaTail", isMediaNode);
/**
 * A notice's Attachments (#954) are the same kind of tail: the box's strip draws them under the page, and the posted notice shows them as one
 * list of chips after its text. Its photos stay inline where they were put, so only an Attachment is moved.
 */
export const DocumentAttachmentTail = mediaTail("documentAttachmentTail", (node) => node.type.name === "attachment");

/** The editor schema for a preset, shared with direct schema regression tests. */
export function createRichTextEditorExtensions(preset: RichTextEditorPreset = "composer") {
  const itemContent = "paragraph (paragraph|bulletList|orderedList|taskList)*";
  const note = preset === "note";
  return [
    StarterKit.configure({
      heading: note ? false : { levels: [2, 3] },
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
      // No composer links on its own what the server refuses (A5, after #947). Tiptap's Link runs a linkify paste rule whatever `autolink` and
      // `linkOnPaste` say, linking an email as `mailto:` and a bare domain as `http://`; `shouldAutoLink` is what that rule asks, so it links
      // nothing. A pasted page's anchor, and the Link popover's address, keep their link only when it is http(s), the one kind the server takes.
      // Where Link previews are on, the editor links pasted and typed http, https and www. addresses itself (`rich-text-address-links.ts`).
      link: { openOnClick: false, autolink: false, linkOnPaste: false, shouldAutoLink: () => false, isAllowedUri: (url) => isHttpUrl(url) },
    }),
    ListItem.extend({ content: itemContent }),
    ListItemHardBreak,
    ...(note ? [NoteHeading, NoteTaskList, noteTaskItem(itemContent)] : [TaskList.configure({}), TaskItem.extend({ content: itemContent }).configure({ nested: true })]),
    Mention.configure({ HTMLAttributes: { class: "rich-text__mention" }, suggestion: { items: () => [] } }),
    ListItemHeadingCommandBoundary,
    ListNestingBoundary,
    EmbeddedImage,
    LinkPreview,
    LinkPreviewFollowsLink,
    ...(preset === "composer" || note ? [EmbeddedVideo] : []),
    ...(note ? [Attachment, NoteMediaTail] : []),
    ...(preset === "document" ? [...documentExtensions(), Attachment, DocumentAttachmentTail] : []),
  ];
}

/** Removes TipTap-only attributes before data leaves the browser. */
export function tiptapToRichTextDoc(value: unknown, options: { keepPreviewDisplay?: boolean } = {}): RichTextDoc {
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
      if (current.type === "highlight") return { type: "highlight", color: normaliseHighlightColor(attrs?.color) ?? DEFAULT_HIGHLIGHT };
      return { type: current.type };
    }) } : {}) };
    if (valueNode.type === "mention") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "mention", attrs: { id: attrs?.id, label: attrs?.label } };
    }
    if (valueNode.type === "image") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      return { type: "image", attrs: { mediaId: attrs?.mediaId, ...(typeof attrs?.alt === "string" && attrs.alt.trim() ? { alt: attrs.alt.trim() } : {}) } };
    }
    if (valueNode.type === "video") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      // The stored form is the id alone; a local draft (`keepPreviewDisplay`) also keeps the poster flag so a reopened composer does not ask for a poster that is not there.
      return { type: "video", attrs: { mediaId: attrs?.mediaId, ...(options.keepPreviewDisplay && typeof attrs?.hasPoster === "boolean" ? { hasPoster: attrs.hasPoster } : {}) } };
    }
    if (valueNode.type === "linkPreview") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      // The stored form is the id alone. A local draft (`keepPreviewDisplay`) also keeps what the card shows, so reopening the composer can draw it.
      if (options.keepPreviewDisplay) return { type: "linkPreview", attrs: { previewId: attrs?.previewId, url: attrs?.url, title: attrs?.title ?? null, description: attrs?.description ?? null, siteName: attrs?.siteName ?? null, imageMediaId: attrs?.imageMediaId ?? null } };
      return { type: "linkPreview", attrs: { previewId: attrs?.previewId } };
    }
    if (valueNode.type === "attachment") {
      const attrs = valueNode.attrs as Record<string, unknown> | undefined;
      // The stored form is the id alone. A local draft (`keepPreviewDisplay`) also keeps the name and size the chip shows.
      return { type: "attachment", attrs: { attachmentId: attrs?.attachmentId, ...(options.keepPreviewDisplay && typeof attrs?.name === "string" ? { name: attrs.name } : {}), ...(options.keepPreviewDisplay && typeof attrs?.bytes === "number" ? { bytes: attrs.bytes } : {}) } };
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
    // A row fully covered by rowspans has no cells and Tiptap omits `content`; the stored form is `[]`.
    if (valueNode.type === "tableRow") return { type: "tableRow", content: children.content ?? [] };
    return { type: valueNode.type, ...children };
  };
  return copy(value) as RichTextDoc;
}

/** The form a post is sent in: every link card is its preview id alone, every video its media id alone and every Attachment its id alone, whatever a local draft or the server's served form kept for drawing them (a link card's text and image, a video's `hasPoster`, a file's name and size), and an image its id and alt without the served `width` and `height` (#611). */
export function stripEmbeddedDisplay(doc: RichTextDoc): RichTextDoc {
  const needsStrip = (block: RichTextDoc["content"][number]) => (block.type === "linkPreview" && Object.keys(block.attrs).length > 1) || (block.type === "video" && "hasPoster" in block.attrs) || (block.type === "image" && ("width" in block.attrs || "height" in block.attrs)) || (block.type === "attachment" && ("name" in block.attrs || "bytes" in block.attrs));
  if (!doc.content.some(needsStrip)) return doc;
  const strip = (block: RichTextDoc["content"][number]): RichTextDoc["content"][number] => {
    if (!needsStrip(block)) return block;
    if (block.type === "linkPreview") return { type: "linkPreview", attrs: { previewId: block.attrs.previewId } };
    if (block.type === "image") return { type: "image", attrs: { mediaId: block.attrs.mediaId, ...(block.attrs.alt ? { alt: block.attrs.alt } : {}) } };
    if (block.type === "attachment") return { type: "attachment", attrs: { attachmentId: block.attrs.attachmentId } };
    return { type: "video", attrs: { mediaId: (block as Extract<typeof block, { type: "video" }>).attrs.mediaId } };
  };
  return { ...doc, content: doc.content.map(strip) };
}

export function mentionQuery(editor: NonNullable<ReturnType<typeof useEditor>>): string | null {
  const { from } = editor.state.selection;
  const before = editor.state.doc.textBetween(Math.max(0, from - 160), from, "\n", (node) => node.type.name === "hardBreak" ? "\n" : "\0");
  const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? match[1]! : null;
}
