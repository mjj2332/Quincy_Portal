import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * cmdk marks every item `data-selected="true|false"`, so ReUI's bare `data-selected:` variant (present =
 * true) highlights every row. The vendored copy keys the selected styling on `=true` (a Quincy divergence,
 * see the header of command.tsx).
 */
describe("command item selected styling", () => {
  const source = readFileSync(new URL("./command.tsx", import.meta.url), "utf8");
  it("never uses a bare data-selected variant", () => {
    expect(source).not.toMatch(/(^|[\s"'`:])(group-)?data-selected[:/]/);
    expect(source).toContain("data-[selected=true]:bg-muted");
    expect(source).toContain("group-data-[selected=true]/command-item:text-foreground");
  });
});
