/**
 * #237.3 — the Adjust-mode row tint is dropped.
 *
 * While a bar is being moved (keyboard Adjust mode or a pointer drag), the row it would land on
 * used to take `bg-muted/40` for a VALID target. The design review measured that as a Δ2 change
 * from the row's own resting/hover tone — below the threshold of noticing, so it carried no
 * information. The owner chose to drop it rather than commit to a visible tint: Adjust mode is
 * already shown by the bar's own state and ghost. The warning (caution) and invalid (destructive)
 * row tints stay — those DO carry information.
 *
 * Read as text: the drop-target state lives in a store selector that needs a live drag to reach
 * in a DOM test, and this is one `cn()` branch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./gantt-view.tsx", import.meta.url)), "utf8");

/** Every `dragTarget === "<state>" && "<classes>"` branch in the file, keyed by state. */
function dragTargetTints(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of text.matchAll(/dragTarget === "(\w+)" && "([^"]*)"/g)) {
    (out[m[1]!] ??= []).push(m[2]!);
  }
  return out;
}

describe("dragTargetTints", () => {
  it("self-test: finds each state's class string, and nothing else", () => {
    const planted = `cn("a", dragTarget === "valid" && "bg-muted/40", dragTarget === "invalid" && "bg-destructive/10", other === "valid" && "x")`;
    expect(dragTargetTints(planted)).toEqual({ valid: ["bg-muted/40"], invalid: ["bg-destructive/10"] });
  });
});

describe("the drop-target row tint (#237.3)", () => {
  const tints = dragTargetTints(source);

  it("gives a VALID target no tint", () => {
    expect(tints.valid ?? []).toEqual([]);
  });

  it("keeps the warning and invalid tints", () => {
    expect(tints.warning?.join(" ")).toMatch(/bg-signal-caution\//);
    expect(tints.invalid?.join(" ")).toMatch(/bg-destructive\//);
  });
});
