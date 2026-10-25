/**
 * #945: a posted comment's Attachments are a list (`quincy/AttachmentChip`'s `AttachmentList`) inside `.rich-text`. `app.css` is
 * unlayered, so its `.rich-text ul { list-style: disc; padding-left }` beats the list's `list-none p-0` utilities whatever their
 * specificity, and every chip drew a bullet. The list carries its own class and an unlayered rule takes the bullet and the indent off,
 * as the task list's does. A node test over the CSS source: happy-dom applies no stylesheet (see `note-placeholder.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const chip = readFileSync(fileURLToPath(new URL("../components/quincy/AttachmentChip.tsx", import.meta.url)), "utf8");

/** The declarations of the unlayered rule whose selector list includes exactly `selector`. */
function declarations(selector: string): string | null {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").split(",").some((part) => part.trim() === selector)) return match[2] ?? "";
  }
  return null;
}

describe("the posted Attachment list inside .rich-text (#945)", () => {
  it("the list carries the class the rule targets", () => {
    expect(chip).toMatch(/className="[^"]*\brich-text__attachment-list\b/);
  });

  it("takes the body's bullet and indent off the list, unlayered so it outranks `.rich-text ul`", () => {
    const body = declarations(".rich-text ul.rich-text__attachment-list");
    expect(body, "the attachment list rule must exist, unlayered, in app.css").not.toBeNull();
    expect(body).toMatch(/list-style:\s*none/);
    expect(body).toMatch(/padding-left:\s*0/);
  });
});
