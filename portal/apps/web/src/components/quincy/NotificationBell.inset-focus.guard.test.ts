/**
 * Inset-focus guard — pins the `!` on the notification row's dismiss control's `focus-visible`
 * utilities as SOURCE TEXT, not as a DOM query.
 *
 * #114 extracted the row markup (and its dismiss control) out of `NotificationBell.tsx` into
 * `NotificationList.tsx`, so this guard now reads that file's `DISMISS` initialiser rather than
 * `NotificationBell.tsx`'s retired `HIGHLIGHT_STATE` — the invariant it pins moved with the code,
 * it did not go away: dismiss sits flush inside a bordered, `overflow-y-auto` panel, so its focus
 * ring must render INWARD or it clips against the panel edge. (The row's own ring is drawn a
 * different way — a `has-[[data-notification-title]:focus-visible]:` variant on the `<li>`, which the
 * unlayered global rule below never contests, because the `<li>` itself is never the focused,
 * `:focus-visible`-matching element — so it carries no `!` and is out of this guard's scope.)
 *
 * The inset can be written correctly and still not paint. `tokens/base.css:25` declares an
 * unlayered `:focus-visible { outline: … ; outline-offset: 2px }`, imported at `index.css:13`
 * outside any cascade layer, and unlayered author CSS beats Tailwind's `@layer utilities`
 * regardless of selector specificity. Without `!` on these utilities the global rule wins and the
 * ring renders OUTWARD at +2px — measured in a real Chrome, the exact defect this guard exists to
 * prevent, with the whole DOM suite green either way: happy-dom resolves no cascade, so nothing in
 * `NotificationList.dom.test.tsx` can see an offset flip. Same mechanism and same fix as
 * `AnchoredPopover.tsx`'s `RING_IN`, whose doc comment carries the full reasoning.
 *
 * This is a `.test.ts` that reads component source as text and never touches the DOM, so it sits
 * outside issue #50 guard A's scope by construction — the technique
 * `ProductionCalendarChrome.guard.test.ts`, `test-seam.guard.test.ts` and
 * `config/reui-registry.guard.test.ts` already use for their own source-text checks.
 *
 * Ported from `Topbar.inset-focus.guard.test.ts` (#113) when the Topbar's own dropdown-menu rows
 * — and the `HIGHLIGHT_STATE` constant they shared this exact class string with — were retired in
 * favour of `NotificationBell`'s own dialog rows and dismiss controls, colocated here rather than
 * at the top level of `components/`. Re-pointed at `NotificationList.tsx`'s `DISMISS` in #114.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const componentsDir = fileURLToPath(new URL(".", import.meta.url));
const notificationListSourcePath = join(componentsDir, "NotificationList.tsx");

function notificationListSource(): string {
  return readFileSync(notificationListSourcePath, "utf8");
}

/**
 * Extracts the `DISMISS` initialiser — everything from the `const` through the terminating
 * semicolon, concatenation operators and all. Scoped deliberately: an assertion over the whole file
 * would pass on a stray `!outline` anywhere in `NotificationList.tsx`.
 *
 * Exported so the fixtures below can exercise it directly, per this repo's rule (lessons.md,
 * "A grep gate that cannot fail is not a gate — twice in two releases").
 */
export function highlightStateInitialiser(source: string): string | null {
  const match = /const DISMISS\s*=[\s\S]*?;/.exec(source);
  return match ? match[0] : null;
}

/** Every `focus-visible:` utility in a class string, with its `!` (if any) preserved. */
export function focusUtilities(initialiser: string): string[] {
  return initialiser.match(/focus-visible:!?[^\s"'`]+/g) ?? [];
}

describe("NotificationList DISMISS inset focus ring", () => {
  it("declares an inward offset", () => {
    const initialiser = highlightStateInitialiser(notificationListSource());
    expect(initialiser, "DISMISS initialiser not found").not.toBeNull();
    expect(focusUtilities(initialiser!)).toContain("focus-visible:!outline-offset-[-2px]");
  });

  it("marks EVERY focus utility important, so none of them loses to the unlayered global rule", () => {
    const initialiser = highlightStateInitialiser(notificationListSource());
    const unimportant = focusUtilities(initialiser!).filter((utility) => !utility.startsWith("focus-visible:!"));
    expect(unimportant, `these lose to tokens/base.css:25's unlayered :focus-visible: ${unimportant.join(", ")}`)
      .toEqual([]);
  });

  // Proving the gate can fail. Both fixtures are real class strings: the first is the exact text
  // that shipped the outward-ring defect, the second the corrected one.
  describe("matcher fixtures", () => {
    const BROKEN = 'const DISMISS = "active:bg-surface-sunken outline-none " +\n' +
      '  "focus-visible:outline-solid focus-visible:outline-ring focus-visible:-outline-offset-2";';
    const FIXED = 'const DISMISS = "active:bg-surface-sunken outline-none " +\n' +
      '  "focus-visible:!outline-solid focus-visible:!outline-ring focus-visible:!outline-offset-[-2px]";';

    it("flags the unimportant form that actually shipped", () => {
      const utilities = focusUtilities(highlightStateInitialiser(BROKEN)!);
      expect(utilities.filter((u) => !u.startsWith("focus-visible:!"))).not.toEqual([]);
      expect(utilities).not.toContain("focus-visible:!outline-offset-[-2px]");
    });

    it("accepts the corrected form", () => {
      const utilities = focusUtilities(highlightStateInitialiser(FIXED)!);
      expect(utilities.filter((u) => !u.startsWith("focus-visible:!"))).toEqual([]);
      expect(utilities).toContain("focus-visible:!outline-offset-[-2px]");
    });

    it("returns null when the constant is gone, so a rename cannot silently pass the guard", () => {
      expect(highlightStateInitialiser("const SOMETHING_ELSE = \"x\";")).toBeNull();
    });
  });
});
