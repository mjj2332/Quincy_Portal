/**
 * Danger text on the guest viewer's inverse surface (#879 PR 2 fix round 4). `styles/tokens/inverse.css` re-points the tone TEXT roles for ink and deliberately leaves the fill roles
 * alone, so `text-destructive` there is oxblood on ink (about 1.8:1). Danger text in the guest tree reads `text-destructive-wash-foreground`, which is the same oxblood on paper and
 * the on-inverse rose on ink. A file that only ever renders on the light page may keep the fill role, and says why below.
 *
 * Per docs/lessons.md ("a grep gate that cannot fail is not a gate") the detector is a pure function, falsified with planted fixtures beside the real scan.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const guestDir = dirname(fileURLToPath(import.meta.url));

/** Files that never render inside the inverse scope. */
const LIGHT_ONLY: Readonly<Record<string, string>> = {
  "GuestVerifyDialog.tsx": "a ReUI AlertDialog mounted beside the screens in GuestApp; it portals to body, the light page",
  "GuestDecisionDialog.tsx": "a ReUI AlertDialog; AlertDialog does not read OverlayContainerContext, so it portals to body, the light page",
  "GuestUnsubscribe.tsx": "the /d/unsubscribe page, which has no inverse surface",
};

/** Blanks comments so prose cannot trip the detector. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/** `text-destructive` as a class of its own (any variant prefix), not `text-destructive-wash-foreground` or `text-destructive/…`'s neighbours. */
function bareDestructiveText(source: string): number {
  return [...stripComments(source).matchAll(/(?:^|[\s"'`:])text-destructive(?![\w-])/g)].length;
}

describe("guest danger text on the inverse surface", () => {
  it("the detector sees the bare fill role and nothing else", () => {
    expect(bareDestructiveText('const P = "m-0 text-destructive [font:var(--type-body-sm)]";')).toBe(1);
    expect(bareDestructiveText('cn(MENU_ITEM, "text-destructive")')).toBe(1);
    expect(bareDestructiveText('className="hover:text-destructive"')).toBe(1);
    expect(bareDestructiveText('cn(MENU_ITEM, "text-destructive-wash-foreground")')).toBe(0);
    expect(bareDestructiveText('className="bg-destructive text-destructive-foreground"')).toBe(0);
    expect(bareDestructiveText("// once used text-destructive here\nconst a = 1;")).toBe(0);
    expect(bareDestructiveText("/* `text-destructive` is wrong on ink */")).toBe(0);
  });

  it("no guest file that can render on the inverse surface uses `text-destructive` for text", () => {
    const files = readdirSync(guestDir).filter((name) => name.endsWith(".tsx") && !name.includes(".test."));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((name) => !(name in LIGHT_ONLY) && bareDestructiveText(readFileSync(join(guestDir, name), "utf8")) > 0);
    expect(offenders).toEqual([]);
    for (const name of Object.keys(LIGHT_ONLY)) expect(files).toContain(name);
  });
});
