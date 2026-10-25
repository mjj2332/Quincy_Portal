import { Extension, combineTransactionSteps, flattenExtensions, getChangedRanges, type Extensions } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { findWebAddresses } from "./web-address";

/** Set on the transaction that links a paste's web addresses: each address linked, in text order, with the end of its text in the document after it. */
export const PASTED_LINKS_META = "quincyPastedLinks";
export type PastedLink = { href: string; at: number };

/** The links a paste made, from the transactions a plugin appended to it, with their places carried through any appended after. */
export function pastedLinks(appended: readonly Transaction[]): PastedLink[] {
  const index = appended.findIndex((transaction) => transaction.getMeta(PASTED_LINKS_META));
  if (index < 0) return [];
  const later = appended.slice(index + 1);
  return (appended[index]!.getMeta(PASTED_LINKS_META) as PastedLink[]).map(({ href, at }) => ({ href, at: later.reduce((pos, transaction) => transaction.mapping.map(pos), at) }));
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
 * the appended transaction (`PASTED_LINKS_META`) so the editor can offer each its Link preview once the paste has landed.
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
        const linked: PastedLink[] = [];
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
        return linked.length ? tr.setMeta(PASTED_LINKS_META, linked) : null;
      },
    })];
  },
});
