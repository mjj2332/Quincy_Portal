/** Names visible before "and N others" in a spoken list. */
const NAMED_LIMIT = 3;

/**
 * "Ada" / "Ada and Bo" / "Ada, Bo and Cy" / "Ada, Bo, Cy and 2 others" (#370). `hidden` counts people the viewer
 * may not see; they join the "others". Empty when nobody is assigned.
 */
export function formatAssigneeNames(people: ReadonlyArray<{ name: string }>, hidden: number): string {
  const named = people.slice(0, NAMED_LIMIT).map((person) => person.name);
  const rest = people.length - named.length + hidden;
  const others = rest > 0 ? `${rest} ${rest === 1 ? "other" : "others"}` : null;
  if (others === null) return named.length <= 1 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return named.length === 0 ? others : `${named.join(", ")} and ${others}`;
}
