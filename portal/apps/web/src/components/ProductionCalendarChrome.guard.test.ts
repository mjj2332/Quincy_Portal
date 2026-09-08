/**
 * Focus-hook guard — pins the two class tokens the surviving `production-calendar.css`
 * `:focus-visible` block (and both reduced-motion blocks) select through, as SOURCE TEXT, not a
 * DOM query.
 *
 * The #61 re-skin deleted every paint rule keyed to `.qc-cal-event-card` and `.qc-calendar-screen`,
 * but two selectors in `production-calendar.css` still reference them:
 *
 * ```
 * .qc-calendar-screen :where(button, [role="button"], input, select, textarea, [tabindex]):focus-visible,
 * ...
 * .qc-cal-event-card:focus-visible { outline: 2px solid var(--focus-ring, ...); outline-offset: 2px; }
 * ```
 *
 * and both `@media (prefers-reduced-motion: reduce)` / `[data-reduced-motion="true"]` blocks key off
 * `.qc-calendar-screen` too. Neither class carries any paint of its own anymore — they exist purely
 * as CSS hooks. Every `.dom.test.tsx` in this suite locates these elements by `aria-label`,
 * `data-testid` or `data-focus-key` (issue #50's guard A forbids DOM tests from selecting by Quincy
 * class name, and that baseline is permanent and shrink-only), so a re-skin that drops either class
 * token leaves the whole DOM suite green while silently killing the calendar's focus indicators —
 * for every focusable control inside `.qc-calendar-screen`, and for every event card. No error, no
 * console warning.
 *
 * This is a `.test.ts` that reads component source as text and never touches the DOM, so it is
 * outside guard A's scope by construction — the same technique `test-seam.guard.test.ts`,
 * `src/config/reui-registry.guard.test.ts` and
 * `ProjectKanbanBoard.scroll-selector.guard.test.ts` already use for their own source-text checks.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const componentsDir = fileURLToPath(new URL(".", import.meta.url));
const eventSourcePath = join(componentsDir, "ProductionCalendarEvent.tsx");
const calendarSourcePath = join(componentsDir, "ProductionCalendar.tsx");

function eventSource(): string {
  return readFileSync(eventSourcePath, "utf8");
}

function calendarSource(): string {
  return readFileSync(calendarSourcePath, "utf8");
}

/**
 * A `cn(...)` call whose first argument is the string literal `"qc-cal-event-card"` (any quote
 * style). Anchoring the closing quote directly after the token — rather than doing a plain
 * substring search — is what keeps a sibling class like `qc-cal-event-card-compact` from falsely
 * satisfying this guard (the same substring trap `tagHasKanbanClass` guards against for `kanban`
 * vs. `kanban-column`).
 */
const CN_EVENT_CARD_CALL = /\bcn\(\s*(["'`])qc-cal-event-card\1/g;

/**
 * Counts `cn("qc-cal-event-card", ...)` call sites in the given source text.
 *
 * Exported so the "prove a gate can fail before trusting it" fixtures below (and any future
 * consumer) can exercise it directly, per this repo's rule (lessons.md, "A grep gate that cannot
 * fail is not a gate — twice in two releases").
 */
export function countEventCardClassCalls(source: string): number {
  return [...source.matchAll(CN_EVENT_CARD_CALL)].length;
}

/**
 * Extracts the full JSX opening tag that contains `marker` in its source text — scanning from the
 * nearest preceding `<` to the matching `>`, tracking `{…}` depth so a JSX expression container
 * holding a stray `>` (a generic, a comparison) cannot end the tag early. Does NOT hard-code a line
 * number: a line number in an assertion is a guard that breaks on reformatting rather than on the
 * defect it exists to catch. Copied from `ProjectKanbanBoard.scroll-selector.guard.test.ts`.
 */
function findTagContaining(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) throw new Error(`marker not found in component source: ${marker}`);
  const tagStart = source.lastIndexOf("<", markerIndex);
  if (tagStart === -1) throw new Error(`no opening \`<\` found before marker: ${marker}`);

  let depth = 0;
  for (let index = tagStart; index < source.length; index++) {
    const char = source[index];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0) return source.slice(tagStart, index + 1);
  }
  throw new Error(`no matching \`>\` found for tag starting at index ${tagStart} (marker: ${marker})`);
}

/**
 * Does this JSX opening tag's `className` carry `qc-calendar-screen` as a standalone,
 * whitespace-delimited token? A substring match would pass on a hypothetical
 * `qc-calendar-screen-alt`, so the token is split on whitespace first.
 */
export function tagHasCalendarScreenClass(tagSource: string): boolean {
  const match = tagSource.match(/\bclassName\s*=\s*"([^"]*)"/);
  if (!match) return false;
  return match[1]!.split(/\s+/).includes("qc-calendar-screen");
}

describe("guard: the `qc-cal-event-card` focus hook still has something to select", () => {
  it("finds at least one `cn(\"qc-cal-event-card\", ...)` call in ProductionCalendarEvent.tsx", () => {
    const count = countEventCardClassCalls(eventSource());
    expect(
      count,
      [
        "No `cn(\"qc-cal-event-card\", ...)` call sites remain in ProductionCalendarEvent.tsx.",
        "",
        "`production-calendar.css`'s surviving `:focus-visible` block selects",
        "`.qc-cal-event-card:focus-visible` directly — it is the only thing giving portaled/inline",
        "event cards a focus ring. If every call site has been rewritten to use a different stable",
        "hook, this guard has nothing left to protect and should be DELETED, not weakened — do not",
        "lower this assertion to `>= 0`.",
      ].join("\n"),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("guard: the `qc-calendar-screen` focus hook is still on the calendar's root section", () => {
  it("keeps `qc-calendar-screen` as a standalone class token on the element carrying aria-label=\"Production Calendar\"", () => {
    const tag = findTagContaining(calendarSource(), 'aria-label="Production Calendar"');
    expect(
      tagHasCalendarScreenClass(tag),
      [
        "The calendar root (the <section> with aria-label=\"Production Calendar\") no longer carries",
        "the literal `qc-calendar-screen` class token.",
        "",
        "`production-calendar.css`'s surviving `:focus-visible` block and BOTH reduced-motion blocks",
        "select through `.qc-calendar-screen` — it is the only thing covering the portaled Calendar",
        "dialogs, which render outside `.production-calendar`. Every DOM test in this suite finds the",
        "root by aria-label or data-focus-key instead (issue #50), so dropping the token here leaves",
        "the entire DOM suite green while silently breaking every focus indicator inside the calendar",
        "screen. Put `qc-calendar-screen` back on the root section's className, or — if the CSS hook",
        "itself has moved off `.qc-calendar-screen` — update BOTH the stylesheet and this guard",
        "together.",
        "",
        `Tag inspected: ${tag}`,
      ].join("\n"),
    ).toBe(true);
  });
});

describe("guard: countEventCardClassCalls can fail — proof against fixtures", () => {
  const SOURCE_WITH_CALL = 'const className = cn("qc-cal-event-card", EVENT_CARD, EVENT_CARD_KIND[event.kind]);';
  const SOURCE_WITHOUT_CALL = 'const className = cn(EVENT_CARD, EVENT_CARD_KIND[event.kind]);';
  const SOURCE_WITH_SUBSTRING_ONLY = 'const className = cn("qc-cal-event-card-compact", EVENT_CARD);';

  it("counts a `cn(\"qc-cal-event-card\", ...)` call", () => {
    expect(countEventCardClassCalls(SOURCE_WITH_CALL)).toBe(1);
  });

  it("returns 0 once the `qc-cal-event-card` call site is removed", () => {
    expect(countEventCardClassCalls(SOURCE_WITHOUT_CALL)).toBe(0);
  });

  it("does not count `cn(\"qc-cal-event-card-compact\", ...)` — the substring trap", () => {
    expect(countEventCardClassCalls(SOURCE_WITH_SUBSTRING_ONLY)).toBe(0);
  });

  it("counts two independent call sites in the same source text", () => {
    expect(countEventCardClassCalls(`${SOURCE_WITH_CALL}\n${SOURCE_WITH_CALL}`)).toBe(2);
  });
});

describe("guard: tagHasCalendarScreenClass can fail — proof against fixtures", () => {
  const TAG_WITH_TOKEN =
    '<section className="qc-calendar-screen min-w-0" aria-label="Production Calendar" tabIndex={-1}>';
  const TAG_WITHOUT_TOKEN = '<section className="min-w-0" aria-label="Production Calendar" tabIndex={-1}>';
  const TAG_WITH_SUBSTRING_ONLY =
    '<section className="qc-calendar-screen-alt min-w-0" aria-label="Production Calendar" tabIndex={-1}>';

  it("returns true for a tag whose className carries the bare `qc-calendar-screen` token", () => {
    expect(tagHasCalendarScreenClass(TAG_WITH_TOKEN)).toBe(true);
  });

  it("returns false once the `qc-calendar-screen` token is removed from the same tag", () => {
    expect(tagHasCalendarScreenClass(TAG_WITHOUT_TOKEN)).toBe(false);
  });

  it("returns false for a className that contains `qc-calendar-screen-alt` but not the bare token (the substring trap)", () => {
    expect(tagHasCalendarScreenClass(TAG_WITH_SUBSTRING_ONLY)).toBe(false);
  });
});
