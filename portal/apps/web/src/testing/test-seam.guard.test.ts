/**
 * Test-seam guards — the DOM suite must assert behaviour, not styling.
 *
 * Issue #50. The re-skin (#53/#54/#55) replaces Quincy markup with ReUI/shadcn components. Every
 * DOM test that reaches for an element by Quincy class name breaks when that happens, and a test
 * edited to match the new markup can no longer certify that the markup change was safe. #50
 * converts those queries to stable identifiers; these guards stop the coupling coming back.
 *
 * Six guards, and one rule that governs all of them: **prove a gate can fail before trusting it**
 * (lessons.md, "A grep gate that cannot fail is not a gate — twice in two releases"). Guard D
 * asserts a floor on what was actually scanned, so a glob that silently matches nothing is itself
 * a failure. Guard E tests the matchers against fixtures, so a later "simplification" of a regex
 * cannot quietly stop matching.
 *
 * Baselines shrink, never grow. Guard B's and Guard C's are {} and must stay there. Guard A's does
 * NOT reach {}: #50 emptied it down to the two `<DragOverlay>` sites, which cannot carry an
 * identifier at all — see the note on the baseline itself. Guard F (issue #92) is baseline-free —
 * it must stay at zero forever, not shrink toward it.
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
  /\.(?:querySelectorAll|querySelector|closest|matches)\s*(?:<[^>]*>)?\s*\(\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*?)\1/g;

/** Any DOM selector call at all — the denominator Guard D asserts a floor on. */
const ANY_QUERY = /\.(?:querySelectorAll|querySelector|closest|matches)\s*(?:<[^>]*>)?\s*\(/g;

/** A DOM selector call whose first argument is NOT a string literal. */
const NON_LITERAL_QUERY =
  /\.(?:querySelectorAll|querySelector|closest|matches)\s*(?:<[^>]*>)?\s*\(\s*[^"'`\s)]/g;

/**
 * A DOM selector call whose argument STARTS with a literal but does not END there —
 * `querySelector("button" + ".kcard")`, `querySelector("" + SEL)`.
 *
 * `NON_LITERAL_QUERY` looks only at the first character after the paren, so a leading quote made
 * these invisible to it; `LITERAL_QUERY` captures only the first literal, so guard A read `button`
 * and shrugged. Between them a concatenated selector escaped every gate. The lookahead demands the
 * literal be followed by the end of the argument list, nothing else.
 */
const CONCATENATED_QUERY =
  /\.(?:querySelectorAll|querySelector|closest|matches)\s*(?:<[^>]*>)?\s*\(\s*(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1\s*(?![),])/g;

/** A template literal that is nothing but interpolation — `` querySelector(`${SEL}`) ``. */
export function isFullyComputedTemplate(quote: string, body: string): boolean {
  return quote === "`" && body.replace(/\$\{[^}]*\}/g, "").trim() === "";
}

/**
 * Every `[data-slot="X"]` attribute selector inside a selector literal — guard F's matcher.
 *
 * A single selector can carry more than one, either combined with an element/attribute
 * selector (`form[data-slot="notice-board-composer"] [contenteditable="true"]`) or with a second
 * slot in a descendant combinator (`[data-slot="a"] [data-slot="b"]`), so this returns every
 * occurrence rather than the first. It deliberately does NOT match `data-slot` sitting inside the
 * VALUE of a different attribute — `[data-testid="data-slot-legacy"]` has no `[data-slot=`
 * substring, because the text before "data-slot" there is `"data-slot-legacy"`'s own quote, not an
 * attribute-selector open bracket.
 */
const DATA_SLOT_SELECTOR = /\[data-slot=(["'])((?:\\[\s\S]|(?!\1)[^\\])*?)\1\]/g;

export function dataSlotsIn(selector: string): string[] {
  return [...selector.matchAll(DATA_SLOT_SELECTOR)].map((match) => match[2]!);
}

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
 * ProjectTeamCombobox.dom.test.tsx (formerly ProjectTeamControl.dom.test.tsx, retired in #204),
 * not a hypothetical. Holes first leaves the empty string.
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
const PREDICATE_SINKS = [
  /\.classList\s*\.\s*contains\s*\(\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*?)\1\s*\)/g,
  /\bclassName\b[^;\n]{0,120}?\.\s*includes\s*\(\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*?)\1\s*\)/g,
];

/** `expect(el.className).not.toContain("x")` — the token is the MATCHER's argument, not a predicate. */
const MATCHER_ARG_SINK =
  /\bclassName\b[^;\n]{0,120}?\)\s*(?:\.\s*(?<negated>not)\b\s*)?\.\s*(?:toContain|toMatch)\s*\(\s*(?<quote>["'`])(?<token>(?:\\[\s\S]|(?!\k<quote>)[^\\])*?)\k<quote>/g;

/**
 * The matcher that consumes a boolean predicate, read FORWARD from the predicate's closing paren.
 *
 * Forward-only is the whole point. The previous version sniffed a 40-character window on BOTH
 * sides, so an unrelated `.not.` on the same line — `expect(x).not.toBeNull(); expect(card.classList
 * .contains("kcard")).toBe(true)` — suppressed a genuine presence assertion, and `.not.toBe(false)`
 * (which asserts the class IS present) was read as an absence. Both were silent: the finding simply
 * never appeared. Polarity belongs to the assertion, so it is parsed from the assertion.
 */
const PREDICATE_MATCHER =
  /^\s*\)*\s*(?:\.\s*(?<negated>not)\b\s*)?\.\s*(?<matcher>toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy)\s*\(\s*(?<arg>true|false)?\s*\)/;

/**
 * Does the assertion consuming this predicate claim the class is PRESENT?
 *
 * Unrecognised shapes return `true` — report it. A guard that cannot read an assertion must not
 * assume the assertion is harmless.
 */
export function predicateAssertsPresence(after: string): boolean {
  const match = PREDICATE_MATCHER.exec(after);
  if (!match?.groups) return true;
  const { negated, matcher, arg } = match.groups;
  const value =
    matcher === "toBeTruthy" ? true
    : matcher === "toBeFalsy" ? false
    : arg === "true" ? true
    : arg === "false" ? false
    : null;
  if (value === null) return true;
  return negated ? !value : value;
}

/**
 * Tailwind utilities that stand alone, with no scale after them. These must be matched EXACTLY.
 *
 * An earlier version listed them as unbounded prefixes, which quietly swallowed real Quincy class
 * names: `filter` as a prefix makes `filter-chips` (PhotoGrid.tsx:198) a "utility", so any
 * assertion on it was skipped by guard C and never counted. That is the "a gate that cannot fail"
 * failure again, wearing a regex. Exact tokens here; anything with a scale goes in the prefix list
 * below, where the trailing `-` does the disambiguating.
 */
const UTILITY_EXACT = new Set([
  "flex", "grid", "block", "inline", "inline-block", "inline-flex", "hidden", "contents", "isolate",
  "absolute", "relative", "fixed", "sticky", "static", "border", "rounded", "shrink", "grow",
  "transition", "shadow", "ring", "outline", "truncate", "filter", "blur", "peer", "group",
  "italic", "underline", "uppercase", "lowercase", "capitalize", "normal-case", "antialiased",
  "invisible", "visible", "sr-only", "not-sr-only",
]);

/**
 * Tailwind families that always carry a scale. The trailing `-` is load-bearing: `border-` matches
 * `border-border` but not `borderless-rail`.
 *
 * `group-` and `peer-` are deliberately absent — their real forms (`group-hover:…`) carry a `:`,
 * which the punctuation test already catches, so listing them here would only re-open the hole.
 */
const UTILITY_PREFIX =
  /^(?:min-|max-|w-|h-|p[xytblr]?-|m[xytblr]?-|gap-|text-|bg-|border-|rounded-|font-|leading-|tracking-|opacity-|z-|overflow-|items-|justify-|self-|order-|shrink-|grow-|basis-|cursor-|select-|pointer-|transition-|duration-|ease-|scale-|translate-|rotate-|shadow-|ring-|outline-|whitespace-|aspect-|col-|row-|place-|content-|space-|divide-|backdrop-|blur-|object-|top-|bottom-|left-|right-|inset-|size-|flex-|grid-)/;

/**
 * A Tailwind utility carries punctuation a Quincy BEM/state name never does, or a well-known
 * exact name or family prefix. Utility assertions are design-system contracts (`min-h-[44px]` is a
 * WCAG 2.5.5 touch target, not styling trivia) and must survive; Quincy BEM names are the coupling.
 */
export function isUtilityClass(token: string): boolean {
  return /[[\]:/!]/.test(token) || UTILITY_EXACT.has(token) || UTILITY_PREFIX.test(token);
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
    const add = (index: number, detail: string) =>
      out.push({ file: rel(file), line: lineOf(source, index), detail: detail.trim() });
    for (const match of source.matchAll(NON_LITERAL_QUERY)) add(match.index!, match[0]!);
    for (const match of source.matchAll(CONCATENATED_QUERY)) add(match.index!, match[0]!);
    for (const match of source.matchAll(LITERAL_QUERY)) {
      if (isFullyComputedTemplate(match[1]!, match[2]!)) add(match.index!, match[0]!);
    }
  }
  return out;
}

/**
 * An assertion that a class is ABSENT is not coupling: replacing the markup can only make it MORE
 * true, never break it. Those are retirement guards (the shell suite pins that the brand link no longer
 * wears `button--text`) and must survive untouched.
 */
function classAssertionFindings(): Finding[] {
  const out: Finding[] = [];
  for (const file of domTestFiles()) {
    const source = stripComments(readFileSync(file, "utf8"));
    const add = (index: number, token: string) =>
      out.push({ file: rel(file), line: lineOf(source, index), detail: token });

    for (const sink of PREDICATE_SINKS) {
      for (const match of source.matchAll(sink)) {
        const token = match[2]!;
        if (!token || isUtilityClass(token)) continue;
        const end = match.index! + match[0]!.length;
        // `expect(!el.classList.contains("x")).toBe(true)` inverts the predicate before the matcher
        // ever sees it. Read the leading `!` rather than mis-scoring the polarity.
        const before = source.slice(Math.max(0, match.index! - 200), match.index!);
        const openIndex = before.lastIndexOf("expect(");
        const inverted = openIndex !== -1 && /^\s*!/.test(before.slice(openIndex + "expect(".length));
        const present = predicateAssertsPresence(source.slice(end, end + 80));
        if (!(inverted ? !present : present)) continue;
        add(match.index!, token);
      }
    }

    for (const match of source.matchAll(MATCHER_ARG_SINK)) {
      const token = match.groups?.token;
      if (!token || isUtilityClass(token)) continue;
      if (match.groups?.negated) continue; // `.not.toContain(…)` is an absence assertion
      add(match.index!, token);
    }
  }
  return out;
}

/**
 * Non-test `.tsx` source files under `src/` — everything the app SHIPS, as opposed to what tests
 * it. `domTestFiles()` can't be reused here: it walks the same tree looking for the opposite
 * suffix.
 */
function sourceTsxFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(full);
    }
  };
  walk(srcDir);
  return out.sort();
}

/**
 * A `data-slot` attribute AUTHORED on an element — JSX (`data-slot="x"`) or a spread-prop object
 * literal (`"data-slot": "x"`, the shape `components/reui/kanban.tsx` and `badge.tsx` use).
 *
 * This is deliberately narrower than "the string data-slot appears". `components/reui/field.tsx`
 * and `icon-button.tsx` both READ a sibling's `data-slot` in a Tailwind arbitrary-variant selector
 * — `has-[>[data-slot=field]]:…`, `[&>[data-slot=status-pill]]:…` — with no quotes around the
 * value. Matching those would wrongly credit a file with authoring a slot it only styles off of.
 */
const DATA_SLOT_AUTHOR = /(?:"data-slot"\s*:|data-slot\s*=)\s*(["'])([\w-]+)\1/g;

/** slot value -> the (repo-relative) source files that author it. */
function dataSlotAuthors(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of sourceTsxFiles()) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(DATA_SLOT_AUTHOR)) {
      const slot = match[2]!;
      const files = out.get(slot) ?? [];
      const relFile = rel(file);
      if (!files.includes(relFile)) files.push(relFile);
      out.set(slot, files);
    }
  }
  return out;
}

/**
 * Guard F's findings: every `[data-slot="X"]` in a DOM-test selector literal where every source
 * file authoring `X` lives under `components/reui/` — or no source file authors it at all.
 */
function vendorSlotFindings(): Finding[] {
  const authors = dataSlotAuthors();
  const out: Finding[] = [];
  for (const file of domTestFiles()) {
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(LITERAL_QUERY)) {
      for (const slot of dataSlotsIn(match[2]!)) {
        const authoredBy = authors.get(slot) ?? [];
        const quincyAuthored = authoredBy.some((authorFile) => !authorFile.startsWith("components/reui/"));
        if (quincyAuthored) continue;
        out.push({ file: rel(file), line: lineOf(source, match.index!), detail: slot });
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

/**
 * A count-only baseline lets a file trade one debt for another: remove `.kcard`, add `.ktile`, and
 * both the ceiling and the honesty check still pass. Where a baseline is durable rather than a
 * countdown, baseline the exact findings so an exchange is an addition.
 *
 * Guard A keeps counts on purpose — its baseline is a countdown that reaches {} inside #50, and
 * spelling out 172 selectors that are all deleted within the ticket buys nothing. Guard C's does
 * NOT reach {}, so it gets the exact form.
 */
function multiset(details: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const detail of details) out.set(detail, (out.get(detail) ?? 0) + 1);
  return out;
}

function detailsByFile(findings: Finding[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { file, detail } of findings) out.set(file, [...(out.get(file) ?? []), detail]);
  return out;
}

function assertWithinExactBaseline(findings: Finding[], baseline: Record<string, string[]>, message: string[]) {
  const actual = detailsByFile(findings);
  const over: string[] = [];
  for (const [file, details] of actual) {
    const allowed = multiset(baseline[file] ?? []);
    for (const [detail, count] of multiset(details)) {
      const budget = allowed.get(detail) ?? 0;
      if (count > budget) over.push(`  ${file}: "${detail}" ×${count} (baseline ${budget})`);
    }
  }
  expect(over.sort(), [...message, "", ...over.sort()].join("\n")).toEqual([]);
}

function assertExactBaselineHonest(findings: Finding[], baseline: Record<string, string[]>) {
  const actual = detailsByFile(findings);
  const stale: string[] = [];
  for (const [file, details] of Object.entries(baseline)) {
    const found = multiset(actual.get(file) ?? []);
    for (const [detail, count] of multiset(details)) {
      const seen = found.get(detail) ?? 0;
      if (seen < count) stale.push(`${file} "${detail}" (baseline ${count}, actual ${seen})`);
    }
  }
  expect(stale.sort(), `Improved — lower or delete these baseline entries: ${stale.sort().join(", ")}`).toEqual([]);
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
 * #50 drove this map down batch by batch, and #83 emptied it. NOTHING may be added: a new
 * class-based selector in a DOM test is a build failure, not a baseline entry.
 */
// The last entry was 2 `.kanban-overlay` selectors in `screens/Dashboard-stage-interactions.dom.test.tsx`.
// It was recorded as permanent because the old Board's overlay was dnd-kit's own <DragOverlay>,
// which accepts a fixed prop list and spreads nothing, so a data-testid on it never reached the DOM
// and a class was the only identifier that element could carry. #83 deleted that Board: the
// replacement's overlay is a Quincy component (`kanban2/card.tsx`'s `kanban2-card-overlay`), the
// suite selects that test id instead, and the entry went away with the selectors rather than being
// waived. Permanent meant "while that overlay exists", not "forever".
const CLASS_SELECTOR_BASELINE: Record<string, number> = {};

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
      "values, this repo already selects on them for styling (reui/card.tsx), and a component",
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
 * **This baseline reached {} in Batch B and must stay there.** It gets there because two kinds of
 * class assertion are legitimate and are excluded by the matcher rather than baselined:
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
// Emptied by Batch B (#50). Every remaining class-presence assertion was converted to a stable
// identifier; keep this at zero — a new entry means a test started asserting on styling again.
const CLASS_ASSERTION_BASELINE: Record<string, string[]> = {};

describe("guard C: no DOM test asserts an element carries a Quincy class name", () => {
  it("adds no class-presence assertion beyond the #50 baseline", () => {
    assertWithinExactBaseline(classAssertionFindings(), CLASS_ASSERTION_BASELINE, [
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
    assertExactBaselineHonest(classAssertionFindings(), CLASS_ASSERTION_BASELINE);
  });
});

// ---------------------------------------------------------------------------
// Guard F — no DOM test selects on a vendor-authored `data-slot`
// ---------------------------------------------------------------------------

/**
 * Issue #92. Guard A already tells you not to reach for `data-slot`, but its own baseline note
 * shows why a blanket ban is the wrong shape for the rule: across the DOM suite there are ~70
 * `[data-slot="…"]` selector call sites in 9 files, and all but one of them select a slot a
 * Quincy component authors — `notice-board-post` on `NoticeBoard.tsx`, `avatar` on
 * `NavigationRail.tsx`, `checkbox` on `quincy/Checkbox.tsx`, and so on. A Quincy-authored
 * `data-slot` is exactly as
 * stable as a `data-testid`: same file, same repo, same blast radius on rename. Banning those
 * would cost ~60 baseline entries in a file whose law is "baselines shrink, never grow", for zero
 * safety gain.
 *
 * The actual hazard guard A names is narrower: "a component swap silently replaces yours with the
 * vendor's." That is only possible for a slot ONLY a vendor file under `components/reui/` writes
 * — nothing Quincy-owned exists to keep the value stable if ReUI renames or removes it. This guard
 * is authorship-based rather than a blanket ban, and it is baseline-free: there is exactly one
 * violation today (`kanban2/board.dom.test.tsx` selecting `components/reui/kanban.tsx`'s
 * `kanban-column`), and it is fixed alongside this guard landing.
 */
describe("guard F: no DOM test selects on a vendor-authored data-slot", () => {
  it("selects only data-slot values a Quincy-owned source file also authors", () => {
    const findings = vendorSlotFindings();
    expect(
      findings.map(({ file, line, detail }) => `  ${file}:${line} — [data-slot="${detail}"]`),
      [
        'A DOM test selects `[data-slot="X"]` where no Quincy-owned source file writes that',
        "attribute — either nothing authors it (the selector matches nothing, which is worse than",
        "coupling to it — a silently vacuous test) or only a vendor file under `components/reui/`",
        "does.",
        "",
        "A `data-slot` your OWN component authors is fine — it is exactly as stable as a",
        "`data-testid`. A `data-slot` only ReUI authors is not: a component swap or a version bump",
        "can rename or drop it with no Quincy file to keep it stable, leaving the test green while",
        "pointing at nothing or at a different element.",
        "",
        "Add a `data-testid` to the Quincy component that composes the vendor primitive, and select",
        "on that instead of the vendor's own `data-slot`.",
      ].join("\n"),
    ).toEqual([]);
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

  it("resolves a non-trivial number of distinct data-slot values (guard F)", () => {
    const slots = new Set<string>();
    for (const file of domTestFiles()) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(LITERAL_QUERY)) {
        for (const slot of dataSlotsIn(match[2]!)) slots.add(slot);
      }
    }
    // ~12 distinct values are selected across the DOM suite today (comfortably above this floor;
    // #113 retired `Topbar.dom.test.tsx`, whose own `[data-slot="avatar"]` query was one of the
    // ~13 this used to count) — if the slot extractor or the source-authorship scan breaks, guard
    // F would silently pass over an empty set — this makes that a failure instead.
    expect(slots.size, "far fewer distinct data-slot values than expected — is guard F's matcher still matching?").toBeGreaterThanOrEqual(11);
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

  // The prefix-vs-exact split. `filter-chips` is a real Quincy class (PhotoGrid.tsx:198) that an
  // unbounded `filter` prefix classified as a utility, silently exempting it from guard C.
  it.each([
    ["filter-chips", false],
    ["filter", true],
    ["grid", true],
    ["grid-cols-2", true],
    ["borderless-rail", false],
    ["border", true],
    ["border-border", true],
    ["group-header", false],
    ["group", true],
    ["contents-panel", false],
    // `normal-case` (#217 design-fix round 2, item 4) is exact, not a prefix: the query span's
    // own `normal-case` class must classify as a utility, but a lookalike Quincy BEM name sharing
    // its stem must not silently ride along as one.
    ["normal-case", true],
    ["normal-case-foo", false],
  ])("isUtilityClass(%j) === %s — prefixes are bounded", (token, expected) => {
    expect(isUtilityClass(token)).toBe(expected);
  });

  // Polarity is read from the assertion, never from surrounding text.
  it.each([
    [")).toBe(true);", true],
    [")).toBeTruthy();", true],
    [")).toBe(false);", false],
    [")).toBeFalsy();", false],
    [")).not.toBe(true);", false],
    [")).not.toBe(false);", true],
    [")).not.toBeFalsy();", true],
    [")).toBe(expected);", true],
    [")).someUnknownMatcher();", true],
  ])("predicateAssertsPresence(%j) === %s", (after, expected) => {
    expect(predicateAssertsPresence(after)).toBe(expected);
  });

  it.each([
    ["`", "${SEL}", true],
    ["`", "  ${A}${B} ", true],
    ["`", '[data-testid="row-${id}"]', false],
    ["`", ".kcard", false],
    ['"', "", false],
  ])("isFullyComputedTemplate(%j, %j) === %s", (quote, body, expected) => {
    expect(isFullyComputedTemplate(quote, body)).toBe(expected);
  });

  // The three shapes that escaped both A and B: a literal is present, so NON_LITERAL_QUERY sees a
  // quote and stops, while LITERAL_QUERY reads only the first fragment.
  it.each([
    ['host.querySelector("button" + ".kcard")', true],
    ['host.querySelector("" + SEL)', true],
    ["host.querySelector(`${SEL}`)", true],
    ['host.querySelector(\'[data-testid="x"]\')', false],
    ["host.querySelector(`[data-testid=\"row-${id}\"]`)", false],
    ['host.querySelector("[data-testid=\\"presentation-anchor\\"]")', false],
    ['host.closest("[role=\\"dialog\\"]")', false],
  ])("computed-selector detection on %j === %s", (code, expected) => {
    const concatenated = new RegExp(CONCATENATED_QUERY.source).test(code);
    const literals = [...code.matchAll(new RegExp(LITERAL_QUERY.source, "g"))];
    const computedTemplate = literals.some((m) => isFullyComputedTemplate(m[1]!, m[2]!));
    const nonLiteral = new RegExp(NON_LITERAL_QUERY.source).test(code);
    expect(concatenated || computedTemplate || nonLiteral).toBe(expected);
  });

  // Guard F's matcher (issue #92). A later "simplification" that stops extracting a second slot,
  // or that starts matching `data-slot` text sitting inside an unrelated attribute's VALUE, would
  // make guard F silently vacuous or silently noisy — these pin both directions.
  it.each([
    ['[data-slot="kanban-column"]', ["kanban-column"]],
    ['[data-slot="notice-board-post"] [data-slot="notice-board-edit"]', ["notice-board-post", "notice-board-edit"]],
    ['form[data-slot="notice-board-composer"]', ["notice-board-composer"]],
    ['[data-slot="field"][data-disabled]', ["field"]],
    ['[data-testid="kanban2-column"]', []],
    ['[data-testid="data-slot-legacy"]', []],
  ])("dataSlotsIn(%j) === %j", (selector, expected) => {
    expect(dataSlotsIn(selector)).toEqual(expected);
  });
});
