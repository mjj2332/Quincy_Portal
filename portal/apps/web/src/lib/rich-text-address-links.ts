import { Extension, combineTransactionSteps, flattenExtensions, getChangedRanges, type Extensions } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { findWebAddresses } from "./web-address";

/** Set on a transaction that links web addresses (pasted, #947, or typed, #948): each address linked, in text order, with the end of its text in the document after it. */
export const LINKED_ADDRESSES_META = "quincyLinkedAddresses";
export type LinkedAddress = { href: string; at: number };

/** The links pasting or typing made, from the transactions plugins appended, with their places carried through any appended after. */
export function linkedAddresses(appended: readonly Transaction[]): LinkedAddress[] {
  return appended.flatMap((transaction, index) => {
    const later = appended.slice(index + 1);
    return ((transaction.getMeta(LINKED_ADDRESSES_META) as LinkedAddress[] | undefined) ?? []).map(({ href, at }) => ({ href, at: later.reduce((pos, next) => next.mapping.map(pos), at) }));
  });
}

/**
 * Every extension's paste rules but the Link mark's (#947). Tiptap's Link runs a linkify paste rule whatever `autolink` and `linkOnPaste`
 * say, and it links emails (`mailto:`) and bare domains, which the server refuses. Where this editor links pasted addresses itself, that
 * rule is left out; the others (pasted `**bold**` and the like) stay.
 */
export const pasteRulesWithoutLink = (extensions: Extensions) => flattenExtensions(extensions).map((extension) => extension.name).filter((name) => name !== "link");

/** One textblock's text with each inline leaf (a mention) as one placeholder, so an index in it is an offset into the block's content. */
const blockText = (block: ProseMirrorNode) => {
  let text = ""; block.forEach((child) => { text += child.isText ? child.text! : "\uFFFC".repeat(child.nodeSize); }); return text;
};

/**
 * Links every `http://`, `https://` and `www.` address a paste brings in (#947): the address the pasted text overlaps, in the textblocks it
 * changed. Text already linked elsewhere keeps its link, and a place that takes no link (inline code) stays text. The links are reported on
 * the appended transaction (`LINKED_ADDRESSES_META`) so the editor can offer each its Link preview once the paste has landed.
 */
export const PastedWebAddressLinks = Extension.create<{ enabled: () => boolean }>({
  name: "pastedWebAddressLinks",
  addOptions() { return { enabled: () => false }; },
  addProseMirrorPlugins() {
    const { enabled } = this.options;
    return [new Plugin({
      key: new PluginKey("pastedWebAddressLinks"),
      appendTransaction: (transactions, oldState, newState) => {
        if (!transactions.some((transaction) => transaction.docChanged && transaction.getMeta("uiEvent") === "paste") || !enabled()) return null;
        const linkType = newState.schema.marks.link;
        if (!linkType) return null;
        const ranges = getChangedRanges(combineTransactionSteps(oldState.doc, [...transactions])).map((change) => change.newRange);
        const blocks = new Map<number, ProseMirrorNode>();
        for (const { from, to } of ranges) newState.doc.nodesBetween(from, to, (node, pos) => { if (!node.isTextblock) return true; blocks.set(pos, node); return false; });
        const tr = newState.tr;
        const linked: LinkedAddress[] = [];
        for (const [pos, block] of [...blocks].sort(([a], [b]) => a - b)) {
          const start = pos + 1;
          for (const address of findWebAddresses(blockText(block))) {
            const from = start + address.from; const to = start + address.to;
            if (!ranges.some((range) => from < range.to && to > range.from)) continue;
            const other = (node: ProseMirrorNode) => node.marks.some((mark) => mark.type === linkType && mark.attrs.href !== address.href);
            let foreign = false; tr.doc.nodesBetween(from, to, (node) => { if (node.isText && other(node)) foreign = true; });
            if (foreign) continue;
            tr.addMark(from, to, linkType.create({ href: address.href }));
            let whole = true; tr.doc.nodesBetween(from, to, (node) => { if (node.isText && !node.marks.some((mark) => mark.type === linkType && mark.attrs.href === address.href)) whole = false; });
            if (whole) linked.push({ href: address.href, at: to });
          }
        }
        return linked.length ? tr.setMeta(LINKED_ADDRESSES_META, linked) : null;
      },
    })];
  },
});

// What ends a typed address at once (#948): a space or line break, or a closing bracket or quote the address did not open. The sentence's
// `.`, `,`, `:`, `?` and the like do not, because they also continue an address being typed (`https://example.`, `…/search?q`, `…:8080`):
// they end it at the space or Enter that follows, and the link stops before them.
const TYPED_BOUNDARY = /[\s)\]}"'’”]/u;

/** One textblock's text with each inline leaf (a mention, a hard break) as spaces, so an address never runs into one and an index is an offset. */
const typedText = (block: ProseMirrorNode) => {
  let text = ""; block.forEach((child) => { text += child.isText ? child.text! : " ".repeat(child.nodeSize); }); return text;
};

/** The address that the boundary at the end of `text` ends: the last one, with nothing but its trimmed tail (`.`, `)`) between it and the boundary. */
function addressEndedBy(text: string) {
  const at = text.length - 1;
  if (at < 0 || !TYPED_BOUNDARY.test(text[at]!)) return undefined;
  const last = findWebAddresses(text).at(-1);
  return last && last.to <= at && !/[\s<>]/u.test(text.slice(last.to, at)) ? last : undefined;
}

/**
 * Links a typed `http://`, `https://` or `www.` address when the author types a boundary after it (#948): a space, Enter, a line break or a
 * closing bracket or quote. Nothing is linked, and no Link preview asked for, while the address is still being typed. Only typing counts:
 * a paste (#947), a drop, the host replacing the content (`preventUpdate`), and undo / redo are left alone, and text that already carries a
 * link (a post opened for editing) keeps it without a card. The links are reported like a paste's (`LINKED_ADDRESSES_META`).
 */
export const TypedWebAddressLinks = Extension.create<{ enabled: () => boolean }>({
  name: "typedWebAddressLinks",
  addOptions() { return { enabled: () => false }; },
  addProseMirrorPlugins() {
    const { enabled } = this.options;
    return [new Plugin({
      key: new PluginKey("typedWebAddressLinks"),
      appendTransaction: (transactions, oldState, newState) => {
        if (!transactions.some((transaction) => transaction.docChanged) || !enabled()) return null;
        if (transactions.some((transaction) => ["paste", "drop"].includes(transaction.getMeta("uiEvent")) || transaction.getMeta("preventUpdate") || transaction.getMeta("history$"))) return null;
        const linkType = newState.schema.marks.link;
        if (!linkType) return null;
        const ended: { start: number; text: string }[] = [];
        for (const { newRange: { from, to } } of getChangedRanges(combineTransactionSteps(oldState.doc, [...transactions]))) {
          if (to <= from) continue;
          // A character typed: the text up to it, in its block.
          const $to = newState.doc.resolve(to);
          if ($to.parent.isTextblock && $to.parentOffset > 0) ended.push({ start: $to.start(), text: typedText($to.parent).slice(0, $to.parentOffset) });
          // Enter: the change starts at the end of a block's text and runs on past it.
          const $from = newState.doc.resolve(from);
          if ($from.parent.isTextblock && $from.parentOffset === $from.parent.content.size && to > $from.end()) ended.push({ start: $from.start(), text: `${typedText($from.parent)}\n` });
        }
        const tr = newState.tr;
        const linked: LinkedAddress[] = [];
        for (const { start, text } of ended) {
          const address = addressEndedBy(text);
          if (!address) continue;
          const from = start + address.from; const to = start + address.to;
          let held = false; tr.doc.nodesBetween(from, to, (node) => { if (node.isText && node.marks.some((mark) => mark.type === linkType)) held = true; });
          if (held) continue;
          tr.addMark(from, to, linkType.create({ href: address.href }));
          // A place that takes no link leaves the address as text.
          let whole = true; tr.doc.nodesBetween(from, to, (node) => { if (node.isText && !node.marks.some((mark) => mark.type === linkType)) whole = false; });
          if (whole) linked.push({ href: address.href, at: to });
        }
        return linked.length ? tr.setMeta(LINKED_ADDRESSES_META, linked) : null;
      },
    })];
  },
});
