/**
 * #625 — `reui/popover.tsx` carries a declared Quincy adaptation (a press on an alert dialog is
 * never an outside press). A plain `shadcn add popover` overwrites vendored files; this fails
 * until the adaptation is restored.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("guard: reui/popover.tsx keeps its alert-dialog press adaptation", () => {
  const source = readFileSync(fileURLToPath(new URL("./popover.tsx", import.meta.url)), "utf8");
  it("imports the press helper, cancels outside-press dismissals with it, and declares the adaptation", () => {
    expect(source).toContain('from "@/lib/alert-dialog-press"');
    expect(source).toContain("InsideAlertDialogContext");
    expect(source).toContain("hasOpenAlertDialog");
    expect(source).toContain("hasMountedAlertDialog");
    expect(source).toMatch(/outside-press[\s\S]*isAlertDialogPress[\s\S]*details\.cancel\(\)/);
    expect(source).toContain("QUINCY ADAPTATION (#625)");
  });
});
