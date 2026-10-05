import { describe, expect, it } from "vitest";
import { iconTileVariants } from "./icon-tile";

describe("IconTile elevated variant", () => {
  it("does not paint the glyph with accent-foreground (paper-050 on paper-100 is ~1.05:1)", () => {
    const classes = iconTileVariants({ variant: "elevated" }).split(/\s+/);
    expect(classes).not.toContain("text-accent-foreground");
    expect(classes).toContain("text-muted-foreground");
  });
});
