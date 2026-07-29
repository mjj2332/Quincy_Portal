const streetCollator = new Intl.Collator("en-AU", { sensitivity: "accent" });

/** Byte-for-byte reproduction of packages/db's orderDashboardStreetTies tie-break (street name via
 * an en-AU Unicode collator, then id) for client code that can't import packages/db. */
export function compareByStreetThenId(left: { street: string; id: string }, right: { street: string; id: string }): number {
  const byStreet = streetCollator.compare(left.street, right.street);
  if (byStreet !== 0) return byStreet;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
