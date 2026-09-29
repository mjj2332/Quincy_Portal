/** A stored DST fold (0 = first occurrence, 1 = second) as the Sydney-occurrence choice a range endpoint carries. */
export function foldToDisambiguation(fold: unknown): "earlier" | "later" | undefined {
  return fold === 0 ? "earlier" : fold === 1 ? "later" : undefined;
}
