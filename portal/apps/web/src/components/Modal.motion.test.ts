import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODAL_DURATION_CLOSE_MS, MODAL_DURATION_OPEN_MS } from "./Modal";
import { POPOVER_DURATION_CLOSE_MS, POPOVER_DURATION_OPEN_MS } from "./AnchoredPopover";

// Criterion 21: `useTransitionStatus`'s JS duration literals must match `--dur-base`/
// `--dur-fast` (tokens/spacing.css) — verified by reading the token file, not by eye. If a
// token moves, this test fails; that is the point.
const spacingCss = readFileSync(
  fileURLToPath(new URL("../styles/tokens/spacing.css", import.meta.url)),
  "utf8",
);

function tokenMs(name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)ms`).exec(spacingCss);
  if (!match) throw new Error(`Token --${name} not found in tokens/spacing.css`);
  return Number(match[1]);
}

describe("overlay exit-motion durations stay in sync with their tokens", () => {
  it("Modal's open/close durations match --dur-base / --dur-fast", () => {
    expect(MODAL_DURATION_OPEN_MS).toBe(tokenMs("dur-base"));
    expect(MODAL_DURATION_CLOSE_MS).toBe(tokenMs("dur-fast"));
  });

  it("AnchoredPopover's open/close durations match --dur-base / --dur-fast", () => {
    expect(POPOVER_DURATION_OPEN_MS).toBe(tokenMs("dur-base"));
    expect(POPOVER_DURATION_CLOSE_MS).toBe(tokenMs("dur-fast"));
  });
});
