import { Extension, combineTransactionSteps, getChangedRanges } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
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

/** Where the boundary that ends `address` sits in `text`: the first boundary after it with only its trimmed tail (`.`, `)`) between, or `ends` at the text's end. */
function boundaryAfter(text: string, address: { to: number }, ends: boolean) {
  for (let at = address.to; at < text.length; at += 1) {
    if (TYPED_BOUNDARY.test(text[at]!)) return at;
    if (/[<>]/u.test(text[at]!)) return undefined;
  }
  return ends ? text.length : undefined;
}

type Range = { from: number; to: number };

/** Whether a transaction is the author's own text input: a paste (#947), a drop, the host replacing the content and undo / redo are not. */
const typed = (transaction: Transaction) => transaction.docChanged && !["paste", "drop"].includes(transaction.getMeta("uiEvent")) && !transaction.getMeta("preventUpdate") && !transaction.getMeta("history$");

/** The ranges `transactions` inserted or replaced text in, in the document after them, with `carried` (ranges from before them) mapped along. */
function inputRanges(transactions: readonly Transaction[], carried: readonly Range[]): Range[] {
  let ranges = [...carried];
  for (const transaction of transactions) {
    ranges = ranges.map(({ from, to }) => ({ from: transaction.mapping.map(from, -1), to: transaction.mapping.map(to, 1) }));
    if (typed(transaction)) ranges.push(...getChangedRanges(transaction).map(({ newRange }) => newRange));
  }
  // Adjacent pieces of one input (an IME's composition arrives in several) are one range.
  const merged: Range[] = [];
  for (const range of ranges.filter(({ from, to }) => to > from).sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to); else merged.push({ ...range });
  }
  return merged;
}

/**
 * The links the text input over `ranges` completes, as a transaction on `state`: every address with a boundary typed after it, or brought in
 * whole by the input (a word predictive text or dictation replaced, before a space already there). Enter counts as a boundary at the end of
 * the block it splits. An address still being typed, or one the author edits a character at a time before a boundary already there, is not.
 */
function linkTyped(state: EditorState, ranges: readonly Range[]) {
  const linkType = state.schema.marks.link;
  if (!linkType || !ranges.length) return null;
  const tr = state.tr;
  const linked: LinkedAddress[] = [];
  const seen = new Set<number>();
  // The input typed this boundary, or brought in this whole address.
  const typedAt = (at: number) => ranges.some((range) => range.from <= at && at < range.to);
  const broughtIn = (from: number, to: number) => ranges.some((range) => range.from <= from && to <= range.to);
  for (const range of ranges) {
    state.doc.nodesBetween(range.from, range.to, (block, pos) => {
      if (!block.isTextblock) return true;
      const start = pos + 1; const end = start + block.content.size;
      const text = typedText(block);
      // Enter: the input runs on past the end of this block's text.
      const split = ranges.some((other) => other.from <= end && other.to > end);
      for (const address of findWebAddresses(text)) {
        const boundary = boundaryAfter(text, address, split);
        if (boundary === undefined) continue;
        const from = start + address.from; const to = start + address.to;
        if (seen.has(from) || !((boundary === text.length ? split : typedAt(start + boundary)) || broughtIn(from, to))) continue;
        seen.add(from);
        let held = false; tr.doc.nodesBetween(from, to, (node) => { if (node.isText && node.marks.some((mark) => mark.type === linkType)) held = true; });
        if (held) continue;
        tr.addMark(from, to, linkType.create({ href: address.href }));
        // A place that takes no link leaves the address as text.
        let whole = true; tr.doc.nodesBetween(from, to, (node) => { if (node.isText && !node.marks.some((mark) => mark.type === linkType)) whole = false; });
        if (whole) linked.push({ href: address.href, at: to });
      }
      return false;
    });
  }
  linked.sort((a, b) => a.at - b.at);
  return linked.length ? tr.setMeta(LINKED_ADDRESSES_META, linked) : null;
}

/**
 * Links a typed `http://`, `https://` or `www.` address when the author types a boundary after it (#948): a space, Enter, a line break or a
 * closing bracket or quote. An input may hand over many characters at once (predictive text, autocorrect, dictation, an IME's commit): every
 * address it completes is linked, wherever its boundary falls. Nothing is linked, and no Link preview asked for, while the address is still
 * being typed, and nothing while an IME composes: its input is held until the composition ends. Only typing counts: a paste (#947), a drop,
 * the host replacing the content (`preventUpdate`), and undo / redo are left alone, and text that already carries a link (a post opened for
 * editing) keeps it without a card. The links are reported like a paste's (`LINKED_ADDRESSES_META`).
 */
export const TypedWebAddressLinks = Extension.create<{ enabled: () => boolean }>({
  name: "typedWebAddressLinks",
  addOptions() { return { enabled: () => false }; },
  addProseMirrorPlugins() {
    const { enabled } = this.options;
    // What an IME's composition has typed so far, in the document it was last seen in.
    let held: { doc: ProseMirrorNode; ranges: Range[] } | null = null;
    let composing = () => false;
    const carried = (doc: ProseMirrorNode) => (held?.doc === doc ? held.ranges : []);
    return [new Plugin({
      key: new PluginKey("typedWebAddressLinks"),
      view: (view) => { composing = () => view.composing; return { destroy: () => { composing = () => false; held = null; } }; },
      appendTransaction: (transactions, oldState, newState) => {
        const ranges = inputRanges(transactions, carried(oldState.doc));
        held = null;
        if (!ranges.length || !enabled()) return null;
        if (composing()) { held = { doc: newState.doc, ranges }; return null; }
        return linkTyped(newState, ranges);
      },
      props: {
        handleDOMEvents: {
          // The composition's last text is read before this runs (a microtask after compositionend); if that changed nothing, the held input is linked here.
          compositionend: (view) => {
            setTimeout(() => {
              if (view.isDestroyed || view.composing || !enabled()) return;
              const tr = linkTyped(view.state, carried(view.state.doc));
              held = null;
              if (tr) view.dispatch(tr);
            });
            return false;
          },
        },
      },
    })];
  },
});
