import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

// A card's address is the typed one, and the server may hand it back normalised (a trailing slash): compare them as URLs.
const addressKey = (value: unknown) => { const text = String(value ?? ""); try { return new URL(text).href; } catch { return text; } };

/**
 * Where a Link preview for `href` goes (#947): among the cards right after the block its link was in, in the order that block's links
 * first appear, so a card that arrives early never ends up after the card of a later link. `at` is the place recorded for the card when it
 * was asked for (the end of the link's top-level block, carried through the edits since); a card whose link is not in that block goes last.
 */
export function linkPreviewSlot(doc: ProseMirrorNode, at: number, href: string): number {
  const size = doc.content.size;
  const $at = doc.resolve(Math.min(at, size));
  const boundary = $at.depth >= 1 ? $at.after(1) : $at.pos;
  const children: Array<{ node: ProseMirrorNode; offset: number }> = [];
  doc.forEach((node, offset) => children.push({ node, offset }));
  const isCard = (index: number) => children[index]?.node.type.name === "linkPreview";
  let start = children.findIndex((child) => child.offset >= boundary);
  if (start < 0) start = children.length;
  // The place may have been carried past cards already inserted there: the block the run of cards follows is the link's.
  while (start > 0 && isCard(start - 1)) start -= 1;
  const order: string[] = [];
  children[start - 1]?.node.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === "link" && !order.includes(addressKey(mark.attrs.href))) order.push(addressKey(mark.attrs.href));
  });
  const rank = (url: unknown) => order.indexOf(addressKey(url));
  const mine = rank(href) < 0 ? Infinity : rank(href);
  let index = start;
  while (isCard(index) && rank(children[index]!.node.attrs.url) <= mine) index += 1;
  return children[index]?.offset ?? size;
}
