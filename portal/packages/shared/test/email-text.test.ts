import { describe, expect, it } from "vitest";
import { MENTION_EMAIL_EXCERPT_MAX_LENGTH, truncateForEmail } from "../src/email-text";

describe("truncateForEmail", () => {
  it("returns under-limit and exactly-limit text unchanged", () => {
    expect(truncateForEmail("A short comment")).toBe("A short comment");
    const exact = "a".repeat(MENTION_EMAIL_EXCERPT_MAX_LENGTH);
    expect(truncateForEmail(exact)).toBe(exact);
  });

  it("caps longer text at 400 UTF-16 code units including its ellipsis", () => {
    const excerpt = truncateForEmail("a".repeat(MENTION_EMAIL_EXCERPT_MAX_LENGTH + 1));
    expect(excerpt).toBe(`${"a".repeat(MENTION_EMAIL_EXCERPT_MAX_LENGTH - 1)}…`);
    expect(excerpt).toHaveLength(MENTION_EMAIL_EXCERPT_MAX_LENGTH);
  });

  it("does not leave a lone high surrogate at the truncation boundary", () => {
    const excerpt = truncateForEmail(`${"a".repeat(398)}😀x`);
    expect(excerpt).toBe(`${"a".repeat(398)}…`);
    expect(excerpt.length).toBeLessThanOrEqual(MENTION_EMAIL_EXCERPT_MAX_LENGTH);
    expect(excerpt.charCodeAt(excerpt.length - 2)).not.toBeGreaterThanOrEqual(0xD800);
  });

  it("does not promise to preserve an entire grapheme cluster", () => {
    expect(truncateForEmail(`${"a".repeat(397)}👩‍👩‍👧‍👧x`)).toBe(`${"a".repeat(397)}👩…`);
  });
});
