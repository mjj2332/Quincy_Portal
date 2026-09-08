/**
 * Design-system guards — the repeat offenders, mechanised.
 *
 * Every rule enforced here has already shipped a real defect **more than once**, and in at least
 * one case the trap was documented in a comment in the very file that then violated it
 * (`ui/button.tsx` describes the `font-size` collision; TB8-09 shipped it anyway, shrinking the
 * rating stars from 22px to 18px). That is the whole argument for this file: prose in a comment,
 * a lessons doc, or a plan does not stop the next instance. A failing test does.
 *
 * ## How these guards are meant to be used
 *
 * Each guard carries a `BASELINE` of instances that already existed when the guard was written.
 * They are **not** approved — each one is a real defect with an owner recorded beside it. The
 * baseline exists so the guard can be switched on *today*, failing on anything new, instead of
 * waiting for a sweep that keeps being deferred. **Shrink these lists; never grow them.** Adding
 * an entry to a baseline to make a build pass is precisely the failure this file exists to catch.
 *
 * These are source-level assertions on purpose. Two of the three defects are invisible in a
 * rendered DOM test — a dead `text-[length:]` renders *a* size, just not the one the author asked
 * for — so a computed-style assertion would have to know the intent to spot the bug. The source
 * knows the intent.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const stylesDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(stylesDir, "..");

function cssFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".css")) out.push(full);
    }
  };
  walk(stylesDir);
  return out.sort();
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(srcDir);
  return out.sort();
}

/** Comments describe these traps; they must not be mistaken for instances of them. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The same, for CSS — but line-preserving, because guard 3 reports the line it found. Blanking a
 * comment to "" would shift every line number after it.
 *
 * This is not hypothetical tidiness. TB8-10A's builder had to reword the comment *documenting*
 * the `.tile` focus fix, because that comment quotes `outline: 0` while explaining why the
 * declaration was removed — and the guard flagged the prose as an instance of the very thing it
 * described. A guard that punishes you for documenting its own subject teaches people to stop
 * writing the comment.
 */
function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat((match.match(/\n/g) ?? []).length));
}

const rel = (file: string) => relative(srcDir, file);

// ---------------------------------------------------------------------------
// Guard 1 — a custom property that is used but never defined
// ---------------------------------------------------------------------------
/**
 * `var(--x, fallback)` where `--x` is defined nowhere is silent: the fallback renders, so the
 * page looks plausible and the token system quietly does not own that value. Without a fallback
 * it is worse — an invalid value in an *inherited* property resolves to `inherit`, not to the
 * declaration above it, which is how `--signal-warning` rendered a "someone else edited this"
 * warning as ordinary ink for its entire life (TB8-07).
 *
 * Three instances were found by hand across TB8-07 and TB8-09 (`--signal-warning`,
 * `--signal-warm`, `--panel`). Writing this guard immediately found five more, all cleared by
 * TB8-10A (D-04, D-10): `--dur-reveal` was defined at `tokens/spacing.css`; `--scrim-bottom` and
 * `--scrim-full` were inlined at their single use sites; `--font-body`/`--font-serif` in
 * `production-calendar.css` were replaced with the real tokens `--font-sans`/`--font-body-serif`.
 */
const PHANTOM_TOKEN_BASELINE: Record<string, string> = {};

describe("guard: every custom property used in CSS is defined in CSS", () => {
  it("has no phantom tokens beyond the recorded baseline", () => {
    const defined = new Set<string>();
    const used = new Map<string, Set<string>>();

    for (const file of cssFiles()) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) if (match[1]) defined.add(match[1]);
      for (const match of text.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
        const token = match[1];
        if (!token) continue;
        const set = used.get(token) ?? new Set<string>();
        set.add(rel(file));
        used.set(token, set);
      }
    }

    const phantom = [...used.keys()].filter((token) => !defined.has(token)).sort();
    const unexpected = phantom.filter((token) => !(token in PHANTOM_TOKEN_BASELINE));

    expect(unexpected, [
      "A custom property is used but defined nowhere. It will render its fallback (or, with no",
      "fallback and an inherited property, resolve to `inherit`) — silently, and forever.",
      "Define the token, or use the one that already exists. Do NOT add it to the baseline.",
      ...unexpected.map((token) => `  ${token} — used in ${[...(used.get(token) ?? [])].join(", ")}`),
    ].join("\n")).toEqual([]);
  });

  it("keeps the baseline honest — every entry is still a real phantom", () => {
    // If an entry has been fixed, this fails and the entry must be deleted. That is what keeps
    // the list shrinking rather than accumulating.
    const defined = new Set<string>();
    for (const file of cssFiles()) {
      for (const match of readFileSync(file, "utf8").matchAll(/(--[A-Za-z0-9-]+)\s*:/g))
        if (match[1]) defined.add(match[1]);
    }
    const fixed = Object.keys(PHANTOM_TOKEN_BASELINE).filter((token) => defined.has(token));
    expect(fixed, `Fixed — delete from PHANTOM_TOKEN_BASELINE: ${fixed.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard 2 — a `text-[length:…]` that can never win against a `[font:…]` shorthand
// ---------------------------------------------------------------------------
/**
 * Tailwind emits arbitrary-property rules (`.[font:…]`) **after** `text-[length:…]` utilities, and
 * both have the same specificity — so the `font` shorthand, which sets `font-size` as part of its
 * expansion, always wins regardless of the order the classes appear in the class string. Verified
 * against the built stylesheet: the first `text-[length:…]` rule is emitted at ~char 28k, the
 * first `[font:…]` rule at ~char 40k.
 *
 * The failure is silent and directional: the element renders the *shorthand's* size, so it looks
 * fine, and only a reader who knows the intended size can see it is wrong. TB8-09's rating stars
 * rendered 18px where the code asked for 22px, through 1,763 tests and two review rounds.
 *
 * The fix is always the same: express the size inside one merged shorthand,
 * `[font:var(--weight-regular)_var(--text-2xs)/1.4_var(--font-mono)]`. An `!`-prefixed
 * `!text-[length:…]` also wins reliably (important beats non-important) and is not flagged.
 */
const FONT_SIZE_COLLISION_BASELINE: Record<string, number> = {};

describe("guard: no dead `text-[length:…]` beside a `[font:…]` shorthand", () => {
  /**
   * Constants whose value carries a `[font:…]` shorthand. A collision most often spans a
   * reference rather than sitting inside one string literal — TB8-09's own bug was
   * `ICON_BUTTON_BASE + " … text-[length:var(--text-lg)]"`, with the shorthand in a different
   * file entirely. A guard that only reads single literals misses exactly the case that bites,
   * which is how the first draft of this guard passed while the real defect was reintroduced.
   */
  const fontCarryingConstants = () => {
    const names = new Set<string>();
    for (const file of sourceFiles()) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const match of text.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*((?:[^;]|\n)*?);/g)) {
        const [, name, value] = match;
        if (name && value?.includes("[font:")) names.add(name);
      }
    }
    return names;
  };

  /**
   * Ranges of source text within which a `font-size` is already set — either a literal that
   * carries `[font:…]` itself, or a `CONST + "…"` / `cn(CONST, "…")` expression that pulls one
   * in by reference. Whole expressions, not lines: splitting by line would pair a `[font:…]` on
   * one element with a `text-[length:…]` on its sibling, which Lightbox's single-line JSX does.
   */
  const fontBearingRanges = (text: string, carriers: Set<string>) => {
    const ranges: [number, number][] = [];
    // A `before:`/`after:` shorthand styles the pseudo-element, not the box that carries the
    // `text-[length:…]`, so the two never collide. Only an unprefixed `[font:…]` (or one behind a
    // state/breakpoint variant, which collides whenever that state is active) can win the size.
    const setsOwnFontSize = (value: string) =>
      value
        .split(/\s+/)
        .some((token) => token.includes("[font:") && !/(?:^|:)(?:before|after|first-letter|first-line|placeholder|marker|selection|file|backdrop):/.test(token));

    const bearsFont = (value: string) =>
      setsOwnFontSize(value) || [...carriers].some((name) => new RegExp(`\\b${name}\\b`).test(value));

    for (const literal of text.matchAll(/"[^"\n]{0,800}?"/g)) {
      if (setsOwnFontSize(literal[0])) ranges.push([literal.index, literal.index + literal[0].length]);
    }

    // `NAME + "…"` / `"…" + NAME` chains.
    for (const chain of text.matchAll(
      /(?:[A-Z][A-Z0-9_]*|"[^"\n]*")(?:\s*\+\s*(?:[A-Z][A-Z0-9_]*|"[^"\n]*"))+/g,
    )) {
      if (bearsFont(chain[0])) ranges.push([chain.index, chain.index + chain[0].length]);
    }

    // `cn(...)` arguments, paren-balanced so a nested call stays its own expression.
    for (const call of text.matchAll(/\bcn\(/g)) {
      let depth = 1;
      let index = call.index + call[0].length;
      const from = index;
      while (index < text.length && depth > 0) {
        const char = text[index];
        if (char === '"') {
          index = text.indexOf('"', index + 1);
          if (index < 0) break;
        } else if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
        index += 1;
      }
      if (depth === 0 && bearsFont(text.slice(from, index - 1))) ranges.push([from, index - 1]);
    }
    return ranges;
  };

  const findCollisions = () => {
    const found: { file: string; snippet: string }[] = [];
    const carriers = fontCarryingConstants();

    for (const file of sourceFiles()) {
      const text = stripComments(readFileSync(file, "utf8"));
      const ranges = fontBearingRanges(text, carriers);
      // One finding per dead `text-[length:…]`, so a site inside both a literal and the
      // concatenation around it is not counted twice. `!text-[length:…]` is the reliable
      // form and is deliberately allowed.
      for (const token of text.matchAll(/(?<!!)\btext-\[length:/g)) {
        if (!ranges.some(([from, to]) => token.index >= from && token.index < to)) continue;
        found.push({ file: rel(file), snippet: text.slice(token.index, token.index + 60) });
      }
    }
    return found;
  };

  it("has no collisions beyond the recorded baseline", () => {
    const byFile = new Map<string, number>();
    for (const { file } of findCollisions()) byFile.set(file, (byFile.get(file) ?? 0) + 1);

    const over = [...byFile.entries()]
      .filter(([file, count]) => count > (FONT_SIZE_COLLISION_BASELINE[file] ?? 0))
      .map(([file, count]) => `  ${file}: ${count} (baseline ${FONT_SIZE_COLLISION_BASELINE[file] ?? 0})`);

    expect(over, [
      "A `text-[length:…]` sits beside a `[font:…]` shorthand in the same class string.",
      "The shorthand is emitted later and always wins, so the `text-[length:]` is dead and the",
      "element renders a size nobody asked for. Merge the size into one `[font:…]` shorthand.",
      ...over,
    ].join("\n")).toEqual([]);
  });

  it("keeps the baseline honest — no file is listed above its real count", () => {
    const byFile = new Map<string, number>();
    for (const { file } of findCollisions()) byFile.set(file, (byFile.get(file) ?? 0) + 1);
    const stale = Object.entries(FONT_SIZE_COLLISION_BASELINE)
      .filter(([file, count]) => (byFile.get(file) ?? 0) < count)
      .map(([file, count]) => `${file} (baseline ${count}, actual ${byFile.get(file) ?? 0})`);
    expect(stale, `Improved — lower or delete these baseline entries: ${stale.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard 3 — a suppressed focus ring in unlayered CSS
// ---------------------------------------------------------------------------
/**
 * `index.css` imports `app.css` outside any cascade layer, and `production-calendar.css` is
 * imported the same way from JS at `ProductionCalendarSurface.tsx:8`, so a rule in either beats an
 * ordinary Tailwind utility regardless of specificity — and on an equal specificity tie it also
 * beats the global `:focus-visible` in `tokens/base.css`, because that is imported first. An
 * `outline: none | 0 | transparent` there is therefore not a suggestion; it removes the focus
 * indicator and no utility can put it back.
 *
 * That is exactly how the Lightbox filmstrip stayed ringless (TB8-09): `.strip__button` set
 * `outline: 2px solid transparent`, tying `:focus-visible` on specificity and winning on source
 * order. Its two prior siblings were TB8-02 round 3 and TB8-05's B4. Third time is a pattern.
 *
 * The guard deliberately does not try to decide whether an alternative indicator exists — that
 * needs judgement. It flags the suppression and requires a human to record why.
 *
 * Cleared by TB8-10B. `.tile` was fixed by TB8-10A (it was a live WCAG 2.4.7 failure — the photo
 * grid gave keyboard users no indicator at all). The other two, `.search input:focus` and
 * `.copyinput:focus`, turned out not to need a focus treatment designed for them: both selectors
 * were unreachable, and the dead-CSS sweep deleted them. **All three baselines in this file now
 * read `{}` — that is the steady state, not an invitation to add entries.**
 */
const SUPPRESSED_FOCUS_BASELINE: Record<string, string> = {};

describe("guard: no focus ring is suppressed in unlayered CSS", () => {
  const findSuppressions = () => {
    const found: { selector: string; file: string; line: number }[] = [];
    // Only the unlayered files can win this fight; the token files are imported into layers.
    const unlayered = cssFiles().filter((file) => /(?:app|production-calendar)\.css$/.test(file));
    for (const file of unlayered) {
      const lines = stripCssComments(readFileSync(file, "utf8")).split("\n");
      // Track the selector of the rule currently open. A declaration-only line carries no `{`,
      // so it belongs to the last selector seen — getting this wrong makes a multi-line rule
      // report its own declaration text as the selector.
      let current = "";
      lines.forEach((line, index) => {
        const brace = line.indexOf("{");
        if (brace >= 0) {
          const head = line.slice(0, brace).trim();
          // `@media`/`@supports` open a block without being a selector; keep looking inside.
          if (head && !head.startsWith("@")) current = head;
        }
        if (!/outline:\s*(?:none|0)\b|outline-color:\s*transparent|outline:[^;]*\btransparent\b/.test(line)) return;
        found.push({ selector: current, file: rel(file), line: index + 1 });
      });
    }
    return found;
  };

  it("has no suppressed focus rings beyond the recorded baseline", () => {
    const unexpected = findSuppressions()
      .filter(({ selector }) => !(selector in SUPPRESSED_FOCUS_BASELINE))
      .map(({ selector, file, line }) => `  ${selector} — ${file}:${line}`);

    expect(unexpected, [
      "An unlayered rule suppresses a focus indicator. Unlayered CSS beats both Tailwind utilities",
      "and the global `:focus-visible` in tokens/base.css, so no utility can restore it.",
      "Delete the suppression — do not try to out-specify it from a later file.",
      ...unexpected,
    ].join("\n")).toEqual([]);
  });

  it("keeps the baseline honest — every entry is still a real suppression", () => {
    const live = new Set(findSuppressions().map(({ selector }) => selector));
    const fixed = Object.keys(SUPPRESSED_FOCUS_BASELINE).filter((selector) => !live.has(selector));
    expect(fixed, `Fixed — delete from SUPPRESSED_FOCUS_BASELINE: ${fixed.join(", ")}`).toEqual([]);
  });
});
