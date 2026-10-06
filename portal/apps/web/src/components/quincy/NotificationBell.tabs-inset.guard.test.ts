/**
 * Tabs-inset guard (#609) — the All/Unread tab labels must start on the same x as the panel
 * heading. Pinned as SOURCE TEXT (happy-dom does no layout, and `.dom.test.tsx` files may not
 * assert classes — see `test-seam.guard.test.ts`).
 *
 * `TabStrip`'s tabs are `px-0`, so the label's left edge IS the strip's content edge: the strip's
 * horizontal padding must equal `HEAD`'s. The focus ring (`::after`, `-inset-x-[var(--space-1)]`)
 * reaches 4px past the label, which lands inside that padding, so nothing clips as long as the
 * padding is at least `--space-1`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "NotificationBell.tsx"), "utf8");

function initialiser(name: string): string {
  const match = src.match(new RegExp(`const ${name} =([\\s\\S]*?);\\n`));
  if (!match?.[1]) throw new Error(`${name} initialiser not found`);
  return match[1];
}
const px = (s: string) => s.match(/(?<![\w-])px-\[var\((--space-\d+)\)\]/)?.[1];

describe("NotificationBell tab strip inset", () => {
  it("TABS_ROW's horizontal padding equals HEAD's, so labels align with the heading", () => {
    expect(px(initialiser("HEAD"))).toBeDefined();
    expect(px(initialiser("TABS_ROW"))).toBe(px(initialiser("HEAD")));
  });

  it("leaves at least --space-1 for the TabStrip focus ring to extend into", () => {
    const n = Number(px(initialiser("TABS_ROW"))?.replace("--space-", ""));
    expect(n).toBeGreaterThanOrEqual(1);
  });
});
