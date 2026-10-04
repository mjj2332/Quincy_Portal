import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
const z = (css: string, name: string) => Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(css)?.[1]);

/** #463: the Calendar/Timeline item menu opens from inside the "+N more" popover (--z-popover), so a menu must stack above a popover and below a dialog. */
describe("overlay stacking contract", () => {
  const tokens = read("./tokens/spacing.css");
  it("orders popover < menu < dialog < toast", () => {
    expect(z(tokens, "menu")).toBeGreaterThan(z(tokens, "popover"));
    expect(z(tokens, "menu")).toBeLessThan(z(tokens, "dialog"));
    expect(z(tokens, "dialog")).toBeLessThan(z(tokens, "toast"));
  });
  it("the dropdown-menu positioner and popup use the menu token, not a magic number", () => {
    const src = read("../components/reui/dropdown-menu.tsx");
    const content = src.slice(src.indexOf("function DropdownMenuContent"), src.indexOf("function DropdownMenuGroup"));
    expect(content).toContain("z-[var(--z-menu)]");
    expect(content).not.toMatch(/\bz-50\b/);
  });
  it("the dialog overlay and content use the dialog token, never the registry's bare z-50 (a dialog opened from a sheet must stack above it)", () => {
    const src = read("../components/reui/dialog.tsx");
    const overlay = src.slice(src.indexOf("function DialogOverlay"), src.indexOf("function DialogContent"));
    const content = src.slice(src.indexOf("function DialogContent"), src.indexOf("function DialogHeader"));
    for (const part of [overlay, content]) {
      expect(part).toContain("z-[var(--z-dialog)]");
      expect(part).not.toMatch(/\bz-50\b/);
    }
  });
});
