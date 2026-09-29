/**
 * #324 — a highlighted option row must not recolour an avatar's initials.
 *
 * The registry's combobox and cascader items paint a highlighted row ink (`bg-accent`) and push
 * `text-accent-foreground` (paper) onto EVERY descendant with Tailwind's `**:` variant, so the
 * secondary text and icons stay legible on ink. That rule compiles to specificity (0,3,0), which
 * beats any avatar's own single-class text colour: the vendored `Avatar`'s initials turned paper
 * on its paper-100 circle and vanished (`qa-evidence/239-reui-reskin/screens/
 * desktop-project-team-combobox-open-crop.png`). An avatar owns its own colours, so the row's
 * descendant recolour skips any `[data-slot=avatar]` subtree.
 *
 * Read as text: Base UI only sets `data-highlighted` under real pointer/keyboard interaction.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FILES = ["./combobox.tsx", "./cascader/cascader-item.tsx"] as const;
// Whole-line `//` comments are dropped so a comment naming the registry class is not an instance of it.
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

/** Classes that recolour a highlighted row's descendants, and whether each exempts avatars. */
function highlightedDescendantRecolours(text: string): { cls: string; exemptsAvatar: boolean }[] {
  return [...text.matchAll(/[^\s"]*data-highlighted:(?:\*\*|\[&_[^\s"]*\]):text-accent-foreground/g)].map(([cls]) => ({
    cls,
    exemptsAvatar: cls.includes(":not([data-slot=avatar])") && cls.includes(":not([data-slot=avatar]_*)"),
  }));
}

describe("highlightedDescendantRecolours", () => {
  it("self-test: flags the registry's bare `**:` form, passes the avatar-exempt form", () => {
    expect(highlightedDescendantRecolours(`"a data-highlighted:**:text-accent-foreground b"`)).toEqual([
      { cls: "data-highlighted:**:text-accent-foreground", exemptsAvatar: false },
    ]);
    const exempt = "data-highlighted:[&_*:not([data-slot=avatar]):not([data-slot=avatar]_*)]:text-accent-foreground";
    expect(highlightedDescendantRecolours(`"${exempt}"`)).toEqual([{ cls: exempt, exemptsAvatar: true }]);
  });
});

describe.each(FILES)("%s", (rel) => {
  const found = highlightedDescendantRecolours(read(rel));

  it("still recolours a highlighted row's descendants (icons and secondary text stay legible on ink)", () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it("exempts avatar subtrees from that recolour", () => {
    expect(found.filter((f) => !f.exemptsAvatar)).toEqual([]);
  });
});
