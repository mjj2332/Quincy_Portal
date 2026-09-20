/**
 * #219 PR A fix (dr-219a MEDIUM #5, the fix-219a-skin.md spec) — "dimmed when done" inverts.
 *
 * Before this fix, `data-completed` styling was an ALPHA STEP on the event's OWN per-stage hue
 * (`bg-(--gantt-event-color)/20` -> `/10` on the shell, `/40` -> `/20` on the progress-fill child)
 * - a per-hue treatment, not a hue-independent one. A 10% wash of a naturally dark/saturated stage
 * colour (e.g. `--signal-positive`, olive) can still read louder than a 20% wash of a naturally
 * light one (e.g. `--greige-400`) - the design reviewer measured a completed bar at Δ52 from paper
 * against Δ22 for an idle one, i.e. backwards: "done" must always be QUIETER than any active bar,
 * whatever its stage colour, and an alpha step derived from the hue itself cannot guarantee that
 * across arbitrary hues.
 *
 * The fix drops `--gantt-event-color` from the completed treatment entirely and uses the existing
 * `--color-border` token (`bg-border`) instead - one fixed, hue-independent value for EVERY stage,
 * proven quieter than the whole harness's stage palette by a real calculation (not eyeballed, and
 * not a browser measurement I have no way to take) - see this fix's own commit message for the
 * script and numbers. This test's job is narrower: given two bars of DIFFERENT event.color, both
 * done, does the DONE treatment actually render identically and NOT reference
 * `--gantt-event-color` at all - the literal thing "is not a per-hue alpha step" asks for.
 *
 * Real `<GanttView>` render, same infrastructure `gantt-adjust-ghost-marker.dom.test.tsx` already
 * uses (see that file's own `getAnimations` polyfill note, reused verbatim below - happy-dom does
 * not implement it, and ReUI's `ScrollArea` calls it on a delayed timer that can outlive
 * `root.unmount()`).
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttEvent, GanttResource } from "@/components/reui/gantt/gantt-types";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  host.remove();
});

const START = new Date("2026-03-02T00:00:00.000Z");
const END = new Date("2026-03-03T00:00:00.000Z");

const RESOURCES: GanttResource[] = [{ id: "r1", title: "Row 1" }];

function findBar(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar as HTMLButtonElement;
}

function findProgressFill(bar: HTMLElement): HTMLElement {
  const el = bar.querySelector<HTMLElement>('[data-testid="gantt-bar-progress"]');
  if (!el) throw new Error("no progress-fill span found");
  return el;
}

/**
 * #219 PR A fix (dr2-219a MEDIUM #3) — "a resolved border colour distinct from its fill" needs an
 * actual RESOLVED value, not a class-string check (item HIGH #1's own lesson generalised: a class
 * name proves what was WRITTEN, not what it PAINTS). This suite runs happy-dom with no CSS
 * pipeline, so there is no `getComputedStyle` to ask - the only source of truth is the real design
 * tokens the app itself ships (`styles/tokens/colors.css`/`tailwind.css`), read as text and
 * resolved the same way a browser's `var()` chain would: `--color-border` -> `--border` ->
 * `--border-hairline` -> `--greige-200` -> a literal hex. Every token in this file is a plain hex
 * literal (`styles/tokens/colors.css`'s own header: "resolutely monochrome... black ink on warm
 * paper"), so no oklch/color-space math is needed - alpha compositing over the canvas token is
 * plain linear interpolation.
 */
function loadTokenSource(): string {
  // node:path, not `new URL(relative, import.meta.url)` - happy-dom's global `URL` shim ignores a
  // `file:` base and resolves relative refs against its own fake `http://localhost:3000/` document
  // location instead, silently escaping this file entirely.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const tokensDir = join(thisDir, "..", "..", "..", "styles", "tokens");
  return (
    readFileSync(join(tokensDir, "colors.css"), "utf8") +
    readFileSync(join(tokensDir, "tailwind.css"), "utf8")
  );
}

function resolveToken(source: string, name: string): string {
  const declaration = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(source);
  if (!declaration) throw new Error(`no declaration for ${name}`);
  const value = declaration[1]!.trim();
  const varRef = /^var\((--[\w-]+)\)$/.exec(value);
  if (varRef) return resolveToken(source, varRef[1]!);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`${name} resolved to a non-hex value: ${value}`);
  }
  return value;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Alpha-composites `fgHex` at `alphaPercent`% over `bgHex` - plain source-over, sRGB channels. */
function compositeOver(fgHex: string, bgHex: string, alphaPercent: number): [number, number, number] {
  const a = alphaPercent / 100;
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  return [0, 1, 2].map((i) => Math.round(fg[i]! * a + bg[i]! * (1 - a))) as [number, number, number];
}

describe("a completed bar's fill is hue-independent, not a per-hue alpha step (#219 PR A, dr-219a MEDIUM #5)", () => {
  it("two completed events with DIFFERENT event.color render the IDENTICAL done treatment, and neither references --gantt-event-color", async () => {
    const events: GanttEvent[] = [
      {
        id: "olive-done",
        title: "Olive Done",
        start: START,
        end: END,
        resourceId: "r1",
        color: "var(--signal-positive)",
        progress: 100,
      },
      {
        id: "greige-done",
        title: "Greige Done",
        start: START,
        end: END,
        resourceId: "r1",
        color: "var(--greige-400)",
        progress: 100,
      },
    ];
    await render(
      <Gantt resources={RESOURCES} events={events} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const oliveBar = findBar("Olive Done");
    const greigeBar = findBar("Greige Done");
    expect(oliveBar.getAttribute("data-completed")).toBe("true");
    expect(greigeBar.getAttribute("data-completed")).toBe("true");

    // The literal "not a per-hue alpha step" assertion: the done variant of the shell's own
    // background must not read the event's own colour custom property at all.
    expect(oliveBar.className).not.toMatch(/data-completed:(?:hover:)?bg-\(--gantt-event-color\)/);
    expect(greigeBar.className).not.toMatch(/data-completed:(?:hover:)?bg-\(--gantt-event-color\)/);
    // Both bars carry the IDENTICAL fixed hue-independent treatment regardless of event.color.
    expect(oliveBar.className).toContain("data-completed:bg-border");
    expect(greigeBar.className).toContain("data-completed:bg-border");

    const oliveFill = findProgressFill(oliveBar);
    const greigeFill = findProgressFill(greigeBar);
    expect(oliveFill.className).not.toMatch(
      /group-data-completed\/gantt-bar-group:(?:border|bg)-\(--gantt-event-color\)/,
    );
    expect(greigeFill.className).not.toMatch(
      /group-data-completed\/gantt-bar-group:(?:border|bg)-\(--gantt-event-color\)/,
    );
    expect(oliveFill.className).toContain("group-data-completed/gantt-bar-group:border-border");
    expect(oliveFill.className).toContain("group-data-completed/gantt-bar-group:bg-border");
    expect(greigeFill.className).toBe(oliveFill.className);
  });

  it("an ACTIVE (not-done) bar keeps its per-hue fill, unaffected by this fix", async () => {
    const event: GanttEvent = {
      id: "active",
      title: "Still Going",
      start: START,
      end: END,
      resourceId: "r1",
      color: "var(--signal-positive)",
      progress: 40,
    };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );
    const bar = findBar("Still Going");
    expect(bar.hasAttribute("data-completed")).toBe(false);
    expect(bar.className).toContain("bg-(--gantt-event-color)/20");
    const fill = findProgressFill(bar);
    expect(fill.className).toContain("bg-(--gantt-event-color)/40");
  });
});

/**
 * #219 PR A fix (dr-219a r6 HIGH #1) — a completed bar SELECTED brought the stage hue back.
 *
 * Before this fix, the shell carried `data-completed:bg-border/15` and, a few classes later,
 * `data-selected:bg-(--gantt-event-color)/30` — two rules with EQUAL specificity (one
 * single-attribute selector each), so which one painted depended entirely on which Tailwind
 * emitted later in the generated stylesheet. `data-selected` happened to come after
 * `data-completed` in source order, so selecting an already-done bar re-painted it in its own
 * stage colour — the exact hue-dependence the sibling describe block above exists to rule out,
 * just reachable through an ordinary click instead of through two different event.color values.
 *
 * The fix gives the completed+selected COMBINATION its own two-attribute-selector rule
 * (`data-completed:data-selected:bg-border/15`), which Tailwind compiles to a selector of
 * strictly HIGHER specificity (0,0,2,0) than either single-attribute rule (0,0,1,0) — the neutral
 * wash wins by CSS SPECIFICITY, not by which class happens to sit later in the array, so swapping
 * the two single-attribute classes' order can never flip the outcome back. This test's job is
 * narrower than a real browser paint: given the actual className string that ships, prove (a) the
 * higher-specificity override rule is present and pins the SAME neutral value the plain
 * `data-completed` rule uses, so a completed+selected bar cannot resolve to anything else, and (b)
 * a distinct, hue-independent selection indicator exists that ONLY activates when BOTH
 * `data-completed` and `data-selected` are true (so an unselected completed bar — same background
 * rule present in its className either way, since Tailwind ships the whole utility set regardless
 * of which data-* attributes happen to be set on THIS element — never matches the compound
 * selector and stays undecorated).
 */
describe("a completed bar that is ALSO selected keeps the neutral completed background, distinguished by something other than hue (#219 PR A, dr-219a r6 HIGH #1)", () => {
  it("selecting a completed bar does not bring its stage hue back, and the selection stays visible some other way", async () => {
    const event: GanttEvent = {
      id: "done-and-selected",
      title: "Done And Selected",
      start: START,
      end: END,
      resourceId: "r1",
      color: "var(--signal-positive)",
      progress: 100,
    };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const bar = findBar("Done And Selected");
    expect(bar.getAttribute("data-completed")).toBe("true");
    expect(bar.hasAttribute("data-selected")).toBe(false);

    // A completed-but-NOT-selected bar already carries whatever selection-indicator utility the
    // fix adds — Tailwind's variant classes are static, present regardless of which data-*
    // attributes are actually set on this particular element — so the class TEXT alone can't
    // distinguish "selected" from "not". What CAN is the compound selector requiring BOTH
    // attributes: this bar has only one of them, so it can never match a
    // `data-completed:data-selected:…` rule.
    const unselectedClassName = bar.className;
    expect(unselectedClassName).toMatch(/data-completed:data-selected:bg-border\/15/);

    await act(async () => {
      bar.click();
      await Promise.resolve();
    });

    expect(bar.getAttribute("data-completed")).toBe("true");
    expect(bar.getAttribute("data-selected")).toBe("true");

    // The className itself is unchanged by selection (it's the same static Tailwind variant
    // list either way) — what matters is that the OVERRIDE rule pins the identical neutral value
    // the plain `data-completed` rule already uses, at a selector Tailwind compiles with strictly
    // higher specificity (two attribute selectors) than the single-attribute `data-selected`
    // background rule below it, so it wins regardless of which of the two was emitted last.
    expect(bar.className).toContain("data-completed:bg-border/15");
    expect(bar.className).toMatch(/data-completed:data-selected:bg-border\/15/);
    expect(bar.className).toContain("data-selected:bg-(--gantt-event-color)/30");

    // Selection must still be visible on a completed bar, by some means OTHER than the
    // background (which the fix pins to the neutral completed treatment either way) — and that
    // means must be gated on the SAME two-attribute compound, not on `data-selected` alone,
    // otherwise it would just be the plain (already-correct) non-completed selected treatment
    // and prove nothing about THIS bug. `(?:[\w-]+:)*` tolerates an extra modifier layered on
    // later (dr2-219a MEDIUM #4 below adds `not-focus-visible:` between the compound and the
    // utility) without caring WHICH extra modifier - this test's own job is narrower than that.
    const selectionIndicator = /data-completed:data-selected:(?:[\w-]+:)*(?:ring-|border-|font-)\S+/;
    expect(bar.className).toMatch(selectionIndicator);

    // Hue-independence still holds for whatever that indicator is: it must not reference the
    // event's own colour custom property.
    const [indicatorClass] = bar.className.match(selectionIndicator) ?? [];
    expect(indicatorClass).toBeDefined();
    expect(indicatorClass).not.toContain("--gantt-event-color");
  });
});

/**
 * #219 PR A fix (dr2-219a MEDIUM #3) — a completed bar had no perceivable boundary. Its fill
 * (`bg-border/15`) measured 1.18:1 against the canvas, and the shell carried no border at all -
 * MEDIUM #5 above fixed the HUE dependence but left the object at the contrast floor. Fix: an
 * explicit token hairline, `data-completed:border data-completed:border-border`, without raising
 * the fill itself (that alpha is already proven quieter than the active palette by MEDIUM #5's own
 * calculation - raising it would undo that work).
 */
describe("a completed bar gets an explicit border hairline, distinct from its own fill (#219 PR A, dr2-219a MEDIUM #3)", () => {
  it("the shell carries data-completed:border data-completed:border-border", async () => {
    const event: GanttEvent = {
      id: "bordered-done",
      title: "Bordered Done",
      start: START,
      end: END,
      resourceId: "r1",
      color: "var(--signal-positive)",
      progress: 100,
    };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const bar = findBar("Bordered Done");
    expect(bar.getAttribute("data-completed")).toBe("true");
    expect(bar.className).toContain("data-completed:border");
    expect(bar.className).toContain("data-completed:border-border");
    // MEDIUM #5's own hue-independent rule stays untouched - do not raise the fill.
    expect(bar.className).toContain("data-completed:bg-border/15");
  });

  it("the border's RESOLVED paint colour is distinct from the completed shell's own fill - not just a different class name", () => {
    // No CSS pipeline runs in this happy-dom suite, so there is nothing for getComputedStyle to
    // read - resolve the real shipped tokens instead (see loadTokenSource's own header comment).
    const tokens = loadTokenSource();
    const borderHex = resolveToken(tokens, "--color-border");
    const canvasHex = resolveToken(tokens, "--bg-canvas");

    // `border-border`: the token painted at FULL strength (an ordinary CSS border has no alpha of
    // its own here - Tailwind's `border-border` sets `border-color` directly, opaque).
    const borderRgb = hexToRgb(borderHex);
    // `bg-border/15`: the SAME token, but at 15% alpha composited over the canvas underneath -
    // the shell's own fill, unchanged by this fix.
    const fillRgb = compositeOver(borderHex, canvasHex, 15);

    expect(fillRgb).not.toEqual(borderRgb);
    // Not merely "different by the compositing algebra" - a real, perceivable object boundary,
    // not a couple of shifted least-significant bits. The delta between the opaque border and its
    // own 15%-alpha fill is exactly 85% of the delta between the border token and the canvas it is
    // composited over (algebraically: border - (border*0.15 + canvas*0.85) = 0.85*(border -
    // canvas)) - with this app's actual tokens (border `--greige-200` #cfc7b6 (207,199,182),
    // canvas `--paper-050` #faf8f2 (250,248,242)) that puts the largest per-channel delta (blue)
    // at 51 of 255. 40 is a conservative floor under that, not a coincidence tuned to pass.
    const maxChannelDelta = Math.max(
      ...[0, 1, 2].map((i) => Math.abs(borderRgb[i]! - fillRgb[i]!)),
    );
    expect(maxChannelDelta).toBeGreaterThan(40);
  });
});

/**
 * #219 PR A fix (dr2-219a MEDIUM #4, SUPERSEDED) — `data-completed:data-selected:ring-2
 * ring-ring/50` used to paint 0-2px outside the border box; the app's own unlayered
 * `:focus-visible { outline }` (`styles/tokens/base.css:25`) paints 2-4px with a 2px offset. A
 * completed bar that was selected AND keyboard-focused showed both at once, so the ring was gated
 * `not-focus-visible:` - fixing the double indicator, but trading it for a WORSE bug: a
 * completed+selected+focused bar then showed NO selection cue at all, painting identically to a
 * completed+unselected+focused one (Sol round-7 MEDIUM #2).
 *
 * #219 PR A fix (Sol round-7 MEDIUM #2a): the ring is gone. Selection on a completed bar is now a
 * colour swap on the bar's OWN existing completed-state hairline (dr2-219a MEDIUM #3 above,
 * `data-completed:border-border`) to `data-completed:data-selected:border-border-strong` - a 1px,
 * INSET, flush-to-the-edge line, geometrically the opposite of the outline's 2px, OUTSET,
 * 2px-offset ring, so the two can never double up and neither needs to suppress the other. No
 * `not-focus-visible:` gate is needed or present - the indicator is visible unfocused, focused,
 * and everywhere between.
 *
 * `hasActiveBorderColorUtility` resolves whether the completed+selected border-colour utility is
 * actually active given the element's real `data-*` attributes - not just present in the (static)
 * class string - the same reasoning `effectiveOpacity` in `gantt-adjust-ghost-marker.dom.test.tsx`
 * documents at length: a class name proves what was WRITTEN, not what paints. No focus-visible
 * modifier is modelled here (unlike the superseded ring helper above it replaces) because none
 * exists on this rule any more - that absence is itself part of what this fix proves.
 */
function hasActiveBorderColorUtility(el: Element, utility: string): boolean {
  const ATTR_PRESENT_MODIFIER = /^data-([a-z-]+)$/;
  for (const token of el.className.split(/\s+/).filter(Boolean)) {
    const parts = token.split(":");
    if (parts[parts.length - 1] !== utility) continue;
    const active = parts.slice(0, -1).every((modifier) => {
      const presentMatch = ATTR_PRESENT_MODIFIER.exec(modifier);
      if (presentMatch) return el.hasAttribute(`data-${presentMatch[1]}`);
      return false;
    });
    if (active) return true;
  }
  return false;
}

describe("a completed bar's selection cue survives :focus-visible and is exposed to ARIA (#219 PR A, Sol round-7 MEDIUM #2)", () => {
  it("completed+selected+focused is distinguishable from completed+unselected+focused - by the border-colour swap, not merely 'the ring is absent' - and both expose aria-pressed", async () => {
    const events: GanttEvent[] = [
      {
        id: "done-selected-focused",
        title: "Done Selected Focused",
        start: START,
        end: END,
        resourceId: "r1",
        color: "var(--signal-positive)",
        progress: 100,
      },
      {
        id: "done-unselected-focused",
        title: "Done Unselected Focused",
        start: START,
        end: END,
        resourceId: "r2",
        color: "var(--signal-positive)",
        progress: 100,
      },
    ];
    await render(
      <Gantt
        resources={[...RESOURCES, { id: "r2", title: "Row 2" }]}
        events={events}
        date={START}
        scale="day"
        timeZone="UTC"
      >
        <GanttView />
      </Gantt>,
    );

    const selectedBar = findBar("Done Selected Focused");
    const unselectedBar = findBar("Done Unselected Focused");

    // Select exactly one of the two - both are completed either way.
    await act(async () => {
      selectedBar.click();
      await Promise.resolve();
    });
    expect(selectedBar.getAttribute("data-completed")).toBe("true");
    expect(selectedBar.getAttribute("data-selected")).toBe("true");
    expect(unselectedBar.getAttribute("data-completed")).toBe("true");
    expect(unselectedBar.hasAttribute("data-selected")).toBe(false);

    // The rule is present at all (static class list) and carries NO not-focus-visible gate, and
    // no ring utility remains for this state - the literal mechanism that used to make the old
    // ring-based cue disappear while focused (dr2-219a MEDIUM #4) is gone, not merely suppressed.
    expect(selectedBar.className).toContain("data-completed:data-selected:border-border-strong");
    expect(selectedBar.className).not.toContain("not-focus-visible");
    expect(selectedBar.className).not.toMatch(/data-completed:data-selected:\S*ring-/);

    // Focus BOTH bars in turn (happy-dom's own `:focus-visible` match follows a real `.focus()`
    // call, the same signal a keyboard Tab produces) and prove the indicator is distinguishable
    // between them WHILE FOCUSED - not merely present in isolation.
    await act(async () => {
      selectedBar.focus();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(selectedBar);
    expect(selectedBar.matches(":focus-visible")).toBe(true);
    expect(hasActiveBorderColorUtility(selectedBar, "border-border-strong")).toBe(true);

    await act(async () => {
      unselectedBar.focus();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(unselectedBar);
    expect(unselectedBar.matches(":focus-visible")).toBe(true);
    // The unselected bar can never match the two-attribute selector - it lacks data-selected.
    expect(hasActiveBorderColorUtility(unselectedBar, "border-border-strong")).toBe(false);

    // Blurred, the same distinction still holds - the cue is not focus-dependent either way.
    await act(async () => {
      unselectedBar.blur();
      await Promise.resolve();
    });
    expect(hasActiveBorderColorUtility(selectedBar, "border-border-strong")).toBe(true);
    expect(hasActiveBorderColorUtility(unselectedBar, "border-border-strong")).toBe(false);

    // Non-visual half of the same fix: aria-pressed exposes the identical distinction to a screen
    // reader, focused or not - `aria-selected` would be invalid here (see gantt-bar.tsx's own
    // header comment on this bar's implicit `button` role).
    expect(selectedBar.getAttribute("aria-pressed")).toBe("true");
    expect(unselectedBar.getAttribute("aria-pressed")).toBe("false");
  });
});
