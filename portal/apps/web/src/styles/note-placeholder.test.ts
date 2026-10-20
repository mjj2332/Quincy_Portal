/**
 * The note box's placeholder (#927 frame C2: "Add a note at this frame… Use @ to mention a colleague.").
 *
 * The box floats its anchor chip before the first line of text. The app-wide placeholder rule (#491) floats the placeholder too, with
 * no height: a float takes the field's whole width when its text is longer than the room beside the chip, so it drops below the chip,
 * out of the one-line box, and the desktop box showed nothing at rest. The phone's short "Add a note…" fitted beside the chip, which is
 * why only the desktop lost it. The note preset keeps the placeholder in the text's own flow instead: it wraps beside the chip and under
 * it (as the frame's inline `:empty::before` does), the box grows to hold it, and it starts on the empty paragraph's line, so the caret
 * stays on the first line beside the chip.
 *
 * A node test over the CSS source, as `app-railed.test.ts` explains: happy-dom lays nothing out and applies no stylesheet, so a DOM test
 * cannot see a float drop. It reads the editor's source too, so a rule nothing applies cannot pass.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const editor = readFileSync(fileURLToPath(new URL("../components/QuincyRichTextEditorBase.tsx", import.meta.url)), "utf8");

const NOTE = ".rich-text__editor-content--note";
const EMPTY = ":has(> p:only-child > br.ProseMirror-trailingBreak:only-child)";

/** The declarations of the unlayered rule whose selector is exactly `selector` (an `@layer` rule would lose to the app-wide one). */
function declarations(selector: string): string | null {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").split(",").some((part) => part.trim() === selector)) return match[2] ?? "";
  }
  return null;
}

describe("the note box's placeholder (#927 C2)", () => {
  it("the note preset's text carries the note class", () => {
    const utilities = editor.match(/const NOTE_CONTENT_UTILITIES = "([^"]*)"/)?.[1] ?? "";
    expect(utilities.split(/\s+/)).toContain("rich-text__editor-content--note");
  });

  it("drops the app-wide floated placeholder in the note box", () => {
    expect(declarations(`${NOTE}${EMPTY}::before`)).toMatch(/content:\s*none/);
  });

  it("draws the placeholder in the text's flow, on the empty line, so it wraps beside the chip instead of falling under it", () => {
    const body = declarations(`${NOTE}${EMPTY}::after`);
    expect(body, "the note placeholder rule must exist, unlayered, in app.css").not.toBeNull();
    expect(body).toMatch(/content:\s*attr\(data-placeholder\)/);
    expect(body).toMatch(/display:\s*block/);
    expect(body).not.toMatch(/float:/);
    // Up by the one line the empty paragraph takes, so the placeholder starts where the caret is.
    expect(body).toMatch(/margin-block-start:\s*-1lh/);
    expect(body).toMatch(/pointer-events:\s*none/);
    expect(body).toMatch(/color:\s*var\(--foreground-secondary\)/);
  });
});
