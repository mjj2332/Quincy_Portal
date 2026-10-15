import { describe, expect, it } from "vitest";
import { fitAtWord } from "./fit-at-word";

/** A width budget in characters stands in for the measured text (#879 PR 3a). */
const within = (max: number) => (candidate: string) => candidate.length <= max;

describe("fitAtWord (#879 PR 3a, the pill's rest placeholder)", () => {
  it("keeps a text that fits as it is", () => {
    expect(fitAtWord("Add a note…", within(40))).toBe("Add a note…");
  });

  it("drops whole words from the end and ends in one ellipsis, never two", () => {
    expect(fitAtWord("Add a note with this drawing…", within(20))).toBe("Add a note with…");
    expect(fitAtWord("Add a note with this drawing…", within(12))).toBe("Add a note…");
  });

  it("adds the ellipsis to a text that had none", () => {
    expect(fitAtWord("Reply to the thread", within(14))).toBe("Reply to the…");
  });

  it("trims the space before the ellipsis, whatever the spacing was", () => {
    expect(fitAtWord("Add  a   note with", within(12))).toBe("Add  a…");
  });

  it("keeps the first word when nothing shorter fits, and a single word as it is (the CSS ellipsis clips the rest)", () => {
    expect(fitAtWord("Add a note with this drawing…", within(2))).toBe("Add…");
    expect(fitAtWord("Supercalifragilistic", within(3))).toBe("Supercalifragilistic");
  });

  it("asks about the widest candidate first, and stops at the first that fits", () => {
    const asked: string[] = [];
    fitAtWord("one two three four", (candidate) => { asked.push(candidate); return candidate.length <= 9; });
    expect(asked).toEqual(["one two three four", "one two three…", "one two…"]);
  });
});
