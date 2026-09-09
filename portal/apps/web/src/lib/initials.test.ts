import { describe, expect, it } from "vitest";
import { initials } from "./initials";

describe("initials", () => {
  it("takes the first character of each of the first two words, uppercased", () => {
    expect(initials("Ana Maria Lopes")).toBe("AM");
  });

  it("handles existing BMP scripts unchanged", () => {
    expect(initials("李 明")).toBe("李明");
    expect(initials("Олена")).toBe("О");
  });

  // #91: `part[0]` indexes the first UTF-16 *code unit*. A character outside the Basic
  // Multilingual Plane (CJK Extension B, or a leading emoji) is encoded as a surrogate pair, so
  // `part[0]` yields a lone surrogate that renders as U+FFFD. Spreading the string iterates by
  // code point instead, so the whole character survives.
  it("yields the whole astral-plane character, not a lone surrogate half", () => {
    const astral = "\u{20BB7}"; // a CJK Extension B character, outside the BMP
    expect(initials(astral)).toBe(astral.toUpperCase());
  });
});
