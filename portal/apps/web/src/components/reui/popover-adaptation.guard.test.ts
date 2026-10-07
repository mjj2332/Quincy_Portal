/**
 * #669 — `reui/popover.tsx` also returns focus to its trigger inside a modal surface (`parkedFocusReturnTarget`).
 * #625 — `reui/popover.tsx` and `reui/combobox.tsx` carry a declared Quincy adaptation: a popup
 * beneath an alert dialog stays open behind it (`keepOpenBehindAlertDialog`). A plain
 * `shadcn add popover` / `add combobox` overwrites vendored files; this fails until it is restored.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

describe("guard: vendored popups keep their alert-dialog adaptation", () => {
  it.each(["popover.tsx", "combobox.tsx"])("%s imports the shared helper, calls it from onOpenChange, and declares the adaptation", (name) => {
    const source = read(name);
    expect(source).toContain('from "@/lib/alert-dialog-press"');
    expect(source).toContain("InsideAlertDialogContext");
    expect(source).toMatch(/onOpenChange=\{[\s\S]*keepOpenBehindAlertDialog\(/);
    expect(source).toMatch(/QUINCY ADAPTATION[^\n]*#625/);
  });

  it("the helper cancels outside-press, escape-key and focus-out dismissals", () => {
    const helper = readFileSync(fileURLToPath(new URL("../../lib/alert-dialog-press.ts", import.meta.url)), "utf8");
    for (const token of ["outside-press", "escape-key", "focus-out", "details.cancel()"]) expect(helper).toContain(token);
  });

  it("popover.tsx declares the #669 return-focus adaptation and uses the shared helper", () => {
    const source = read("popover.tsx");
    expect(source).toMatch(/QUINCY ADAPTATION[^\n]*#669/);
    expect(source).toContain('from "@/lib/return-focus-before-close"');
    expect(source).toContain("parkedFocusReturnTarget(");
  });
});
