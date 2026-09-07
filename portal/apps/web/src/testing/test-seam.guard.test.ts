/**
 * Test-seam guards — the DOM suite must assert behaviour, not styling.
 *
 * Issue #50. The re-skin (#53/#54/#55) replaces Quincy markup with ReUI/shadcn components. Every
 * DOM test that reaches for an element by Quincy class name breaks when that happens, and a test
 * edited to match the new markup can no longer certify that the markup change was safe. #50
 * converts those queries to stable identifiers; these guards stop the coupling coming back.
 *
 * Four guards, and one rule that governs all of them: **prove a gate can fail before trusting it**
 * (lessons.md, "A grep gate that cannot fail is not a gate — twice in two releases"). Guard D
 * asserts a floor on what was actually scanned, so a glob that silently matches nothing is itself
 * a failure. Guard E tests the matchers against fixtures, so a later "simplification" of a regex
 * cannot quietly stop matching.
 *
 * Baselines shrink, never grow. Guard A's reaches {} when #50 lands; Guard B's is already {} and
 * must stay there. Guard C's does NOT reach {} — see its own note.
 *
 * This file is `.test.ts`, so it runs in the NODE suite (`vitest.config.ts`), not the happy-dom
 * one. It reads test sources as text; it renders nothing.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const srcDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function domTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".dom.test.tsx")) out.push(full);
    }
  };
  walk(srcDir);
  return out.sort();
}

const rel = (file: string) => relative(srcDir, file).split(sep).join("/");

/**
 * Line-preserving, because every finding reports the line it was found on. Blanking a block
 * comment to "" would shift every line number after it.
 *
 * Stripping comments FIRST is not tidiness — it is the difference between a guard that can be
 * documented and one that punishes you for documenting it. TB8-05 shipped two grep gates that
 * matched their own explanatory comments, and TB8-10A had to reword the comment describing a fix
 * because the guard flagged the prose as an instance of the thing it described.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat((match.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

// ---------------------------------------------------------------------------
// The matchers
// ---------------------------------------------------------------------------

/** A DOM selector call whose first argument is a string literal, capturing that literal. */
const LITERAL_QUERY =
  /\.(?:querySelectorAll|querySelector|closest|matches)\s*(?:<[^>]*>)?\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

/** Any DOM selector call at all — the denominator Guard D asserts a floor on. */
const ANY_QUERY = /\.(?:querySelectorAll|querySelector|closest|matches)\s*(?:<[^>]*>)?\s*\(/g;

/** A DOM selector call whose first argument is NOT a string literal. */
const NON_LITERAL_QUERY =
  /\.(?:querySelectorAll|querySelector|closest|matches)\s*(?:<[^>]*>)?\s*\(\s*[^"'`\s)]/g;

/**
 * Does this CSS selector select on a class?
 *
 * Two forms, and the second is easy to miss: `[class*="admin-table__action"]` is a class selector
 * with no leading dot, and every dot-anchored grep walks straight past it. It is real — Admin's
 * suite used exactly that shape.
 *
 * The stripping ORDER is load-bearing. `${…}` holes must go before `[…]` attribute values,
 * because a template hole can itself contain a `]`:
 *
 *   `[data-testid="project-member-editor:${members[0]!.userId}"]`
 *
 * Stripping brackets first stops at the `]` inside `members[0]`, leaving `!.userId}"]` behind,
 * and the guard then flags `userId` as a class. That is a real line in
 * ProjectTeamControl.dom.test.tsx, not a hypothetical. Holes first leaves the empty string.
 */
export function hasClassSelector(selector: string): boolean {
  if (/\[\s*class\b/.test(selector)) return true;
  const bare = selector.replace(/\$\{[^}]*\}/g, "").replace(/\[[^\]]*\]/g, "");
  return /\.[-_A-Za-z]/.test(bare);
}

/**
 * Sinks that test a class token against an element's class list, rather than selecting by it.
 * `expect(card.className.split(" ").includes("kanban")).toBe(true)` breaks on a re-skin exactly
 * like a selector does, but the word "selects" in #50's acceptance criteria does not cover it.
 */
const ASSERTION_SINKS = [
  /\.classList\s*\.\s*contains\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g,
  /\bclassName\b[^;\n]{0,120}?\.\s*includes\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g,
  /\bclassName\b[^;\n]{0,120}?\)\s*\.\s*(?:not\s*\.\s*)?(?:toContain|toMatch)\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g,
];

/**
 * A Tailwind utility carries punctuation a Quincy BEM/state name never does, or a well-known
 * prefix. Utility assertions are design-system contracts (`min-h-[44px]` is a WCAG 2.5.5 touch
 * target, not styling trivia) and must survive; Quincy BEM names are the coupling.
 */
export function isUtilityClass(token: string): boolean {
  return (
    /[[\]:/!]/.test(token) ||
    /^(?:flex|grid|block|inline|hidden|absolute|relative|fixed|sticky|static|min-|max-|w-|h-|p[xytblr]?-|m[xytblr]?-|gap-|text-|bg-|border|rounded|font-|leading-|tracking-|opacity-|z-|overflow-|items-|justify-|self-|order-|shrink|grow|basis-|cursor-|select-|pointer-|transition|duration-|ease-|scale-|translate-|rotate-|shadow|ring|outline|whitespace-|truncate|sr-only|not-sr-only|aspect-|col-|row-|place-|content-|space-|divide-|backdrop-|filter|blur|object-|top-|bottom-|left-|right-|inset-|size-|peer|group)/.test(
      token,
    )
  );
}

type Finding = { file: string; line: number; detail: string };

function classSelectorFindings(): Finding[] {
  const out: Finding[] = [];
  for (const file of domTestFiles()) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(LITERAL_QUERY)) {
      if (!hasClassSelector(match[2]!)) continue;
      out.push({ file: rel(file), line: lineOf(source, match.index!), detail: match[2]! });
    }
  }
  return out;
}

function nonLiteralFindings(): Finding[] {
  const out: Finding[] = [];
  for (const file of domTestFiles()) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(NON_LITERAL_QUERY)) {
      out.push({ file: rel(file), line: lineOf(source, match.index!), detail: match[0]!.trim() });
    }
  }
  return out;
}

function classAssertionFindings(): Finding[] {
  const out: Finding[] = [];
  for (const file of domTestFiles()) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const sink of ASSERTION_SINKS) {
      for (const match of source.matchAll(sink)) {
        const token = match[2]!;
        if (!token || isUtilityClass(token)) continue;
        // An assertion that a class is ABSENT is not coupling: replacing the markup can only make
        // it MORE true, never break it. Those are retirement guards (Topbar pins that the brand
        // link no longer wears `button--text`) and must survive untouched.
        const tail = source.slice(match.index!, match.index! + match[0]!.length + 40);
        const head = source.slice(Math.max(0, match.index! - 40), match.index! + match[0]!.length);
        if (/\.\s*toBe\s*\(\s*false\s*\)/.test(tail) || /\.\s*not\s*\./.test(head)) continue;
        out.push({ file: rel(file), line: lineOf(source, match.index!), detail: token });
      }
    }
  }
  return out;
}

function countByFile(findings: Finding[]): Map<string, number> {
  const byFile = new Map<string, number>();
  for (const { file } of findings) byFile.set(file, (byFile.get(file) ?? 0) + 1);
  return byFile;
}

/** Shared shape for a baselined guard: nothing above baseline, and no stale baseline entry. */
function assertWithinBaseline(findings: Finding[], baseline: Record<string, number>, message: string[]) {
  const byFile = countByFile(findings);
  const over = [...byFile.entries()]
    .filter(([file, count]) => count > (baseline[file] ?? 0))
    .map(([file, count]) => `  ${file}: ${count} (baseline ${baseline[file] ?? 0})`)
    .sort();
  expect(over, [...message, "", ...over].join("\n")).toEqual([]);
}

function assertBaselineHonest(findings: Finding[], baseline: Record<string, number>) {
  const byFile = countByFile(findings);
  const stale = Object.entries(baseline)
    .filter(([file, count]) => (byFile.get(file) ?? 0) < count)
    .map(([file, count]) => `${file} (baseline ${count}, actual ${byFile.get(file) ?? 0})`)
    .sort();
  expect(stale, `Improved — lower or delete these baseline entries: ${stale.join(", ")}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// Guard A — no DOM test selects an element by a class name
// ---------------------------------------------------------------------------

/**
 * #50 drives every one of these to zero, batch by batch. Delete each entry as its file is
 * converted; the whole map goes when the ticket closes. NOTHING may be added.
 */
const CLASS_SELECTOR_BASELINE: Record<string, number> = {
  "screens/ProjectWorkspace.dom.test.tsx": 98,
  "screens/Dashboard-stage-interactions.dom.test.tsx": 70,
  "components/ProjectCollaborationPanel.dom.test.tsx": 37,
  "components/Topbar.dom.test.tsx": 35,
  "components/CollectionPanel.dom.test.tsx": 29,
  "components/PhotoGrid.dom.test.tsx": 18,
  "components/Lightbox.dom.test.tsx": 17,
  "components/ProjectTeamControl.dom.test.tsx": 16,
  "screens/Admin.dom.test.tsx": 15,
  "screens/Dashboard-kanban-sort.dom.test.tsx": 13,
  "screens/Dashboard-calendar.dom.test.tsx": 12,
  "components/Lightbox.a11y.dom.test.tsx": 5,
  "components/ProductionCalendar-phone.dom.test.tsx": 5,
  "components/ProjectOverviewRail.dom.test.tsx": 5,
  "components/ProductionCalendar-unscheduled.dom.test.tsx": 4,
  "components/SubtaskChecklist.dom.test.tsx": 4,
  "components/ConfirmDialog.dom.test.tsx": 3,
  "components/ProjectKanbanBoard.dom.test.tsx": 3,
  "components/RichTextEditor.dom.test.tsx": 3,
  "components/NoticeBoard.dom.test.tsx": 2,
  "components/ProductionCalendar-reconciliation.dom.test.tsx": 2,
  "components/ProductionCalendar.dom.test.tsx": 2,
  "components/ProductionCalendarEvent.dom.test.tsx": 2,
  "components/ProjectActivityView.dom.test.tsx": 2,
  "components/ProjectFields.dom.test.tsx": 2,
  "screens/CreateProject.dom.test.tsx": 2,
  "components/ImpersonationBanner.dom.test.tsx": 1,
  "components/KanbanCardPreview.dom.test.tsx": 1,
  "components/ProductionCalendar-checklist.dom.test.tsx": 1,
  "components/ProductionCalendarUnscheduledPanel.dom.test.tsx": 1,
  "components/ProjectDeadlineControl.dom.test.tsx": 1,
  "components/ProjectTeamControl.confirm.dom.test.tsx": 1,
  "screens/Dashboard-kanban-sort-priority-guard.dom.test.tsx": 1,
  "screens/Dashboard-kanban-sort-priority-render-gate.dom.test.tsx": 1,
};

describe("guard A: no DOM test selects an element by a Quincy class name", () => {
  it("adds no class-based selector beyond the #50 baseline", () => {
    assertWithinBaseline(classSelectorFindings(), CLASS_SELECTOR_BASELINE, [
      "A DOM test selects an element by CSS class.",
      "",
      "The re-skin replaces this markup with ReUI/shadcn components, and every class-based query",
      "breaks when it does — forcing a test edit during the slice, which is exactly what destroys",
      "the migration's safety argument (issue #47). Query a stable identifier instead:",
      "",
      "  - an existing role/ARIA contract, if the element already has one",
      "    ([role=\"alert\"], [aria-expanded], a real `disabled` prop) — preferred, no source edit;",
      "  - otherwise a `data-testid` added to the source component.",
      "",
      "Do NOT use `data-slot` as a test hook. ReUI/shadcn components ship their own data-slot",
      "values, this repo already selects on them for styling (ui/icon-button.tsx), and a component",
      "swap silently replaces yours with the vendor's — leaving the test green while pointing at a",
      "different element.",
    ]);
  });

  it("keeps the baseline honest — no file is listed above its real count", () => {
    assertBaselineHonest(classSelectorFindings(), CLASS_SELECTOR_BASELINE);
  });
});

// ---------------------------------------------------------------------------
// Guard B — every DOM query takes a string literal
// ---------------------------------------------------------------------------

/**
 * Guard A can only read selectors it can see. `const SEL = ".kcard"; host.querySelector(SEL)`
 * evades it completely, and so does a helper that takes a selector string. Rather than chase
 * those with dataflow analysis, close the hole structurally: in a DOM test, the selector is
 * always written at the call site.
 *
 * The baseline is {} and must stay {}. Three sites were fixed to land it there.
 */
describe("guard B: every DOM query in a DOM test takes a literal selector", () => {
  it("passes no computed selector to querySelector/querySelectorAll/closest/matches", () => {
    const findings = nonLiteralFindings();
    expect(
      findings.map(({ file, line, detail }) => `  ${file}:${line} — ${detail}`),
      [
        "A DOM query was passed a computed selector rather than a string literal.",
        "",
        "Guard A reads selector literals at the call site, so a variable, a helper parameter or a",
        "ternary hides the selector from it entirely — `const SEL = \".kcard\"` would sail through.",
        "Write the selector at the call site. If a helper needs a target, have it take an Element:",
        "",
        "  - async function click(element: HTMLElement) { … }",
        "  + await click(host.querySelector<HTMLElement>('[data-testid=\"x\"]')!);",
        "",
        "A template literal IS a literal and is fine — `[data-testid=\"row-${id}\"]` is allowed.",
      ].join("\n"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard C — no DOM test asserts on a Quincy class name
// ---------------------------------------------------------------------------

/**
 * The same coupling wearing a different shape: `expect(tile.classList.contains("is-selected"))`
 * breaks on a re-skin just as a selector does. #50's acceptance criteria say "selects", which
 * would let all of these through, so the owner widened it to "selects or asserts on".
 *
 * Unlike A and B, **this baseline does not reach {}**. Two kinds of class assertion are
 * legitimate and are already excluded by the matcher rather than baselined:
 *
 *   - assertions that a class is ABSENT (`.toBe(false)`, `.not.toContain`) — a re-skin can only
 *     make those more true;
 *   - assertions on Tailwind utilities — `min-h-[44px]` is a WCAG 2.5.5 touch target and
 *     `hover:not-disabled:!text-on-inverse` is an inverse-surface contract. Those are design-system
 *     assertions and must survive.
 *
 * What remains below is real coupling on Quincy BEM/state names, and #50 converts it to the state
 * attributes those elements gain (`data-open`, `data-active`, `data-multi-selected`).
 */
const CLASS_ASSERTION_BASELINE: Record<string, number> = {
  "components/ProjectKanbanBoard.dom.test.tsx": 6,
  "screens/Dashboard-calendar.dom.test.tsx": 6,
  "components/CollectionPanel.dom.test.tsx": 3,
  "screens/ProjectWorkspace.dom.test.tsx": 2,
  "components/PhotoGrid.dom.test.tsx": 1,
  "components/ProjectCollaborationPanel.dom.test.tsx": 1,
};

describe("guard C: no DOM test asserts an element carries a Quincy class name", () => {
  it("adds no class-presence assertion beyond the #50 baseline", () => {
    assertWithinBaseline(classAssertionFindings(), CLASS_ASSERTION_BASELINE, [
      "A DOM test asserts that an element carries a Quincy class name.",
      "",
      "This breaks on a re-skin exactly like a class-based selector does. Assert the behaviour the",
      "class stands for instead — a state attribute (`data-open`, `data-active`), an ARIA state, or",
      "the rendered text.",
      "",
      "Asserting a class is ABSENT is fine and is not counted; so is asserting a Tailwind utility",
      "that encodes a real design contract.",
    ]);
  });

  it("keeps the baseline honest — no file is listed above its real count", () => {
    assertBaselineHonest(classAssertionFindings(), CLASS_ASSERTION_BASELINE);
  });
});

// ---------------------------------------------------------------------------
// Guard D — the gates above actually scanned something
// ---------------------------------------------------------------------------

/**
 * "A grep gate that cannot fail is not a gate." Every guard here is an emptiness assertion, and
 * an emptiness assertion over an empty set passes for free. If the glob stops matching — a
 * renamed suffix, a moved directory, a walk that throws and is swallowed — A, B and C all go
 * green while checking nothing. These floors are what make that a failure instead.
 */
describe("guard D: the seam guards actually scanned the DOM suite", () => {
  it("finds the DOM test files and their queries", () => {
    const files = domTestFiles();
    expect(files.length, "the *.dom.test.tsx glob matched (almost) nothing — the guards above are vacuous").toBeGreaterThanOrEqual(60);

    const totalQueries = files.reduce(
      (sum, file) => sum + (stripComments(readFileSync(file, "utf8")).match(ANY_QUERY) ?? []).length,
      0,
    );
    expect(totalQueries, "far fewer DOM queries than expected — is the matcher still matching?").toBeGreaterThanOrEqual(1_400);
  });
});

// ---------------------------------------------------------------------------
// Guard E — the matchers are themselves tested
// ---------------------------------------------------------------------------

/**
 * The matcher IS the guard. A later tidy-up of either regex could stop matching without any test
 * noticing, and every guard above would go green. These fixtures make that a failure — and they
 * pin the two cases that were got wrong while writing this file.
 */
describe("guard E: the seam matchers classify selectors correctly", () => {
  it.each([
    // Coupling — must be caught.
    [".kcard", true],
    [".tile.is-selected", true],
    ["button.topbar__notification-item", true],
    [".rail, .workmain", true],
    ['[class*="admin-table__action"] button:last-child', true],
    [".collection-link-form:not(.collection-link-editor) input", true],
    ['[data-unscheduled-id="project:unscheduled"].is-disabled', true],
    [".rich-text__task-content .sr-only", true],
    // Not coupling — must NOT be caught.
    ['input[type="checkbox"], [role="checkbox"]', false],
    ['[data-testid="project-member-editor:${members[0]!.userId}"]', false],
    ['[aria-label="Notifications"]', false],
    ['[href="/projects/a.b"]', false],
    ["#subtask-add-1", false],
    ['[data-testid="asset.jpg"]', false],
    ["[aria-live]", false],
    ['[title="Export .csv"]', false],
  ])("hasClassSelector(%j) === %s", (selector, expected) => {
    expect(hasClassSelector(selector)).toBe(expected);
  });

  it.each([
    ["is-selected", false],
    ["kcard", false],
    ["collection-links--video", false],
    ["min-h-[44px]", true],
    ["hover:not-disabled:!text-on-inverse", true],
    ["sr-only", true],
    ["flex", true],
    ["text-foreground", true],
  ])("isUtilityClass(%j) === %s", (token, expected) => {
    expect(isUtilityClass(token)).toBe(expected);
  });
});
