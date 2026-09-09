export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    // #91: index by code point, not UTF-16 code unit. `part[0]` on a character outside the Basic
    // Multilingual Plane returns a lone surrogate half, which renders as U+FFFD.
    .map((part) => [...part][0])
    // Take the first two words' initials by *element*, not by slicing the joined string: `.slice(0, 2)`
    // on the joined form counts code units, so "Bob 𠮷" truncated mid-surrogate-pair to "B\uD842".
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
