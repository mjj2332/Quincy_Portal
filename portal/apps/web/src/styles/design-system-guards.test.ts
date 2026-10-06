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
      // `[^;]` already matches a newline, so the old `(?:[^;]|\n)*?` gave the engine two ways to
      // consume every newline it crossed — catastrophic backtracking, doubling with each line, on any
      // SCREAMING_CASE const not followed by a semicolon within reach. A vendored 950-line file in
      // Prettier's semicolon-free style (components/reui/kanban.tsx, 8 semicolons) hung this guard
      // forever: not slow, non-terminating, and immune to --testTimeout because the work is synchronous.
      // `[^;]*?` is exactly equivalent and unambiguous. Do not "restore" the alternation.
      for (const match of text.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*([^;]*?);/g)) {
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
 * `index.css` imports `app.css` outside any cascade layer, so a rule there beats an
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
    const unlayered = cssFiles().filter((file) => /app\.css$/.test(file));
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

// ---------------------------------------------------------------------------
// Guard 3b/3c — the two global rules every surface's focus ring and reduced motion rest on
// ---------------------------------------------------------------------------
/**
 * #224 retired `production-calendar.css` and, with it, the Calendar's own `:focus-visible` and
 * reduced-motion blocks (and `ProductionCalendarChrome.guard.test.ts`, which pinned their hooks).
 * The ReUI Calendar, the Gantt and their dialogs carry no focus or motion CSS of their own: their
 * focus ring IS `tokens/base.css`'s `:focus-visible { outline: … solid var(--focus-ring) }`, and
 * their reduced motion IS `app.css`'s `@media (prefers-reduced-motion: reduce) { * { … } }`.
 *
 * Both only work because they are UNLAYERED — `index.css` imports both files without `layer()` —
 * so a Tailwind utility (`outline-none`, `transition-*`, `duration-*`, all in `@layer utilities`)
 * cannot beat them. Nothing pinned either rule before this. Moving one into `@layer base`, or
 * deleting it as dead-looking, would leave every DOM test green (happy-dom resolves neither cascade
 * layers nor media queries) while silently removing the focus indicator from, or restoring motion
 * to, every screen at once.
 *
 * The complement — a calendar-scoped `!important` utility that WOULD beat these rules — is pinned
 * by `components/ProductionEventCalendar.focus-motion.guard.test.ts`.
 */

/** Top-level (depth-0) blocks of a stylesheet: `{ prelude, body }`, by brace matching. */
function topLevelBlocks(css: string): { prelude: string; body: string }[] {
  const blocks: { prelude: string; body: string }[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  for (let index = 0; index < css.length; index++) {
    const char = css[index];
    if (char === "{") {
      if (depth === 0) bodyStart = index + 1;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        const head = css.slice(preludeStart, bodyStart - 1);
        // A preceding `@import …;` / `@layer a, b;` statement shares the stretch before the brace.
        blocks.push({ prelude: head.slice(head.lastIndexOf(";") + 1).trim(), body: css.slice(bodyStart, index) });
        preludeStart = index + 1;
      }
    }
  }
  return blocks;
}

const GLOBAL_FOCUS_OUTLINE = /(?:^|;)\s*outline\s*:[^;]*\bsolid\b[^;]*var\(--focus-ring\)/;

function hasUnlayeredFocusVisible(css: string): boolean {
  return topLevelBlocks(stripComments(css)).some(({ prelude, body }) => prelude === ":focus-visible" && GLOBAL_FOCUS_OUTLINE.test(body));
}

const REDUCED_MOTION_MEDIA = /^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/;

function hasUnlayeredReducedMotion(css: string): boolean {
  return topLevelBlocks(stripComments(css)).some(({ prelude, body }) => {
    if (!REDUCED_MOTION_MEDIA.test(prelude)) return false;
    return topLevelBlocks(body).some(({ prelude: selector, body: declarations }) =>
      selector === "*"
      && /animation-duration\s*:[^;]*!important/.test(declarations)
      && /transition-duration\s*:[^;]*!important/.test(declarations));
  });
}

describe("guard: the global focus ring and reduced-motion rule stay unlayered", () => {
  it("tokens/base.css keeps an unlayered `:focus-visible { outline: … solid var(--focus-ring) }`", () => {
    expect(
      hasUnlayeredFocusVisible(readFileSync(join(stylesDir, "tokens", "base.css"), "utf8")),
      [
        "tokens/base.css no longer carries a top-level (unlayered) `:focus-visible` rule painting",
        "`outline: <width> solid var(--focus-ring)`. It is the only focus indicator the Calendar, the",
        "Gantt and their dialogs have. Restore it OUTSIDE any @layer — inside `@layer base` every",
        "`outline-none` utility would beat it.",
      ].join("\n"),
    ).toBe(true);
  });

  it("app.css keeps an unlayered `@media (prefers-reduced-motion: reduce) { * { …!important } }`", () => {
    expect(
      hasUnlayeredReducedMotion(readFileSync(join(stylesDir, "app.css"), "utf8")),
      [
        "app.css no longer carries a top-level `@media (prefers-reduced-motion: reduce)` block with a",
        "`*` rule forcing `animation-duration` and `transition-duration` `!important`. It is the only",
        "reduced-motion rule the Calendar, the Gantt and their dialogs have.",
      ].join("\n"),
    ).toBe(true);
  });

  it("proves both detectors on planted fixtures", () => {
    expect(hasUnlayeredFocusVisible(":focus-visible {\n  outline: var(--border-width-bold) solid var(--focus-ring);\n}")).toBe(true);
    expect(hasUnlayeredFocusVisible("@import \"./x.css\";\n:focus-visible { outline: 2px solid var(--focus-ring); }")).toBe(true);
    // moved into a layer: utilities would beat it
    expect(hasUnlayeredFocusVisible("@layer base { :focus-visible { outline: 2px solid var(--focus-ring); } }")).toBe(false);
    // a literal colour, or no longer a visible outline
    expect(hasUnlayeredFocusVisible(":focus-visible { outline: 2px solid #2f3b4d; }")).toBe(false);
    expect(hasUnlayeredFocusVisible(":focus-visible { outline: 2px solid transparent; outline-color: var(--focus-ring); }")).toBe(false);
    // scoped to one surface instead of global
    expect(hasUnlayeredFocusVisible(".page :focus-visible { outline: 2px solid var(--focus-ring); }")).toBe(false);
    // quoted in a comment only
    expect(hasUnlayeredFocusVisible("/* :focus-visible { outline: 2px solid var(--focus-ring); } */")).toBe(false);

    const motion = "@media (prefers-reduced-motion: reduce) { * { animation-duration: .001ms !important; transition-duration: .001ms !important; } }";
    expect(hasUnlayeredReducedMotion(motion)).toBe(true);
    expect(hasUnlayeredReducedMotion(`@layer base { ${motion} }`)).toBe(false);
    expect(hasUnlayeredReducedMotion("@media (prefers-reduced-motion: reduce) { * { animation-duration: .001ms !important; transition-duration: .001ms; } }")).toBe(false);
    expect(hasUnlayeredReducedMotion("@media (prefers-reduced-motion: reduce) { .tile { animation-duration: .001ms !important; transition-duration: .001ms !important; } }")).toBe(false);
    expect(hasUnlayeredReducedMotion(`/* ${motion} */`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard 4 — a star painted from a literal instead of its token
// ---------------------------------------------------------------------------
/**
 * Two independent 1–5 scales render as stars: Asset rating, and Project priority from #81.
 * They are different concepts that deliberately share a glyph, so the one thing that must not
 * happen is the two drifting into two different yellows — which is exactly what a second
 * hardcoded `#f0a020` at a new star site produces. Nothing about that is visible in review: the
 * stars render, in a yellow, and only someone holding both screens side by side sees it.
 *
 * This guard exists because #77 found the drift had *already* started: Asset rating painted
 * `#f0a020` over photo tiles and `--signal-caution-text` in the Lightbox panel. Both were right
 * — they sit on different grounds — but neither was written down, so the ticket that set out to
 * "replace the raw hex" was written believing there was one.
 *
 * The grounds are why this is a token pair rather than a token: `--star-on` resolves to ochre on
 * paper, amber on ink (tokens/inverse.css) and amber over media (app.css `.tstars`). A star site
 * names the role and is handed the value its ground needs. Naming a value instead is the defect.
 *
 * No baseline: the sweep it would record was done in the same change that added the guard.
 */
describe("guard: star colour comes from a token, never a literal", () => {
  const STAR_PALETTE = ["#f0a020", "rgba(255,255,255,.28)"];

  it("declares the star palette only at its definition in tokens/colors.css", () => {
    for (const value of STAR_PALETTE) {
      const files = cssFiles()
        .filter((file) => stripCssComments(readFileSync(file, "utf8")).includes(value))
        .map(rel);
      // `rgba(255,255,255,.28)` is also the .wmark--lg watermark ink — same value, unrelated
      // concept, and it stays where it is. The star half of it must live in the token file.
      expect(files, `${value} escaped tokens/colors.css`).toContain("styles/tokens/colors.css");
    }
  });

  it("paints every star-named rule from a --star-* role", () => {
    const offenders: string[] = [];
    for (const file of cssFiles()) {
      const css = stripCssComments(readFileSync(file, "utf8"));
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = rule[1] ?? "";
        const body = rule[2] ?? "";
        if (!/star/i.test(selector) || selector.includes("@")) continue;
        for (const declaration of body.matchAll(/(?:^|;)\s*color\s*:\s*([^;]+)/g)) {
          const value = declaration[1] ?? "";
          if (!/var\(--star-(?:on|off)\)/.test(value)) {
            offenders.push(`${rel(file)} — ${selector.trim()} { color: ${value.trim()} }`);
          }
        }
      }
    }
    expect(offenders, [
      "A star rule must read var(--star-on) / var(--star-off), not a value.",
      "The role resolves per ground; a literal picks one ground and is wrong on the others.",
      ...offenders,
    ].join("\n")).toEqual([]);
  });

  // #306: the unlit star read heavier than the lit one — greige-600 at 8.7:1 against ochre at
  // 5.9:1 on paper, and greige-200 at 11.8:1 against amber at 9.2:1 on ink — so an unset row
  // looked "on". The owner's rule: unlit recedes. On every ground a star lands on, the unlit star
  // sits closer to the ground than the lit one, and both still clear the 3:1 non-text floor.
  it("keeps the unlit star quieter than the lit one, and both at 3:1, on every star ground", () => {
    const declarations = (css: string) => new Map(
      [...stripCssComments(css).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
    );
    const colorsCss = readFileSync(join(stylesDir, "tokens/colors.css"), "utf8");
    const inverseCss = readFileSync(join(stylesDir, "tokens/inverse.css"), "utf8");
    const inverseBlock = /\[data-surface="inverse"\]\s*\{([^}]*)\}/.exec(stripCssComments(inverseCss))?.[1] ?? "";
    const paper = declarations(colorsCss);
    const ink = new Map([...paper, ...declarations(inverseBlock)]);
    const resolve = (scope: Map<string, string>, name: string): string => {
      const value = scope.get(name) ?? "";
      const ref = /^var\((--[\w-]+)\)$/.exec(value);
      return ref ? resolve(scope, ref[1]!) : value;
    };
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    // Paper: the Board card and the Lightbox panel are --paper-000, the canvas is --paper-050,
    // a raised row is --paper-100. Ink: the Lightbox stage and its popovers.
    const grounds: [Map<string, string>, string][] = [
      [paper, "--paper-000"], [paper, "--paper-050"], [paper, "--paper-100"],
      [ink, "--ink-900"], [ink, "--ink-800"],
    ];
    const failures: string[] = [];
    const hex = (scope: Map<string, string>, name: string) => {
      const value = resolve(scope, name);
      // An unresolved or non-hex value measures as NaN, and every NaN comparison below is false —
      // the guard would pass without measuring anything. Fail loudly instead.
      expect(value, `${name} must resolve to a #rrggbb palette value`).toMatch(/^#[0-9a-f]{6}$/i);
      return value;
    };
    expect(inverseBlock, "tokens/inverse.css has no [data-surface=\"inverse\"] block").toContain("--star-off");
    for (const [scope, groundName] of grounds) {
      const ground = hex(scope, groundName);
      const on = contrast(hex(scope, "--star-on"), ground);
      const off = contrast(hex(scope, "--star-off"), ground);
      const at = `${groundName} (on ${on.toFixed(2)}:1, off ${off.toFixed(2)}:1)`;
      if (off >= on) failures.push(`unlit reads as heavy as lit on ${at}`);
      if (off < 3 || on < 3) failures.push(`under the 3:1 non-text floor on ${at}`);
    }
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard 5 — caution text uses the caution TEXT token, never the brand value
// ---------------------------------------------------------------------------
/**
 * `--signal-caution` is the brand value (a border/wash/icon colour); `--signal-caution-text` is
 * the one contrast-checked for text (`tokens/colors.css`'s own comment: "Text only:
 * --signal-caution stays the brand value for borders, washes and [ground X]; ... use
 * --signal-caution-text"). Painting TEXT from `text-signal-caution` reaches for the wrong one —
 * the brand value has no contrast guarantee on any particular ground.
 *
 * `--warning` is ReUI's alias into the same caution family, and it resolves to the TEXT token,
 * not the brand value (`tokens/reui.css`: `--warning: var(--signal-caution-text)`,
 * `--color-warning: var(--warning)`). So `text-warning` is fine — it is `--signal-caution-text`
 * by another name — but `bg-warning` paints a *background* from a value chosen for text
 * contrast, the inverse of the `--signal-caution` mistake above: right family, wrong role.
 *
 * `text-signal-caution` matched with a lookahead rather than a plain substring check, since
 * `text-signal-caution-text` (the correct form) contains `text-signal-caution` as a prefix.
 *
 * `apps/web/src/components/reui/badge.tsx`'s `warning` variant is base-nova's own vendored
 * naming for a badge appearance, not a Quincy caution-colour call site — recorded in the baseline
 * below rather than treated as new. Do not add a second entry beside it.
 */
const CAUTION_TOKEN_BASELINE: Record<string, number> = {
  // Three `bg-warning` hits: the plain `warning` variant, plus `bg-warning/10` and its
  // `dark:bg-warning/15` sibling in the `warningOutline`-shaped variant beside it.
  "components/reui/badge.tsx": 2,
};

describe("guard: caution text uses the caution TEXT token, never the brand value", () => {
  function scannableFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(?:tsx?|css)$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        if (rel(full).startsWith("styles/tokens/")) continue;
        out.push(full);
      }
    };
    walk(srcDir);
    return out.sort();
  }

  const BARE_SIGNAL_CAUTION = /text-signal-caution(?!-text)/;
  const BG_WARNING = /bg-warning\b/;

  function findCautionTokenOffences(text: string): { bareSignalCaution: boolean; bgWarning: boolean } {
    return { bareSignalCaution: BARE_SIGNAL_CAUTION.test(text), bgWarning: BG_WARNING.test(text) };
  }

  function scan() {
    const byFile = new Map<string, number>();
    for (const file of scannableFiles()) {
      const raw = readFileSync(file, "utf8");
      const stripped = file.endsWith(".css") ? stripCssComments(raw) : stripComments(raw);
      const { bareSignalCaution, bgWarning } = findCautionTokenOffences(stripped);
      const count = (bareSignalCaution ? (stripped.match(new RegExp(BARE_SIGNAL_CAUTION, "g")) ?? []).length : 0)
        + (bgWarning ? (stripped.match(new RegExp(BG_WARNING, "g")) ?? []).length : 0);
      if (count > 0) byFile.set(rel(file), count);
    }
    return byFile;
  }

  it("has no bare --signal-caution text usage or bg-warning beyond the recorded baseline", () => {
    const byFile = scan();
    const over = [...byFile.entries()]
      .filter(([file, count]) => count > (CAUTION_TOKEN_BASELINE[file] ?? 0))
      .map(([file, count]) => `  ${file}: ${count} (baseline ${CAUTION_TOKEN_BASELINE[file] ?? 0})`);
    expect(over, [
      "Caution TEXT must read --signal-caution-text (`text-signal-caution-text`) or the",
      "`text-warning` utility, never the bare `text-signal-caution` brand value or `bg-warning`.",
      ...over,
    ].join("\n")).toEqual([]);
  });

  it("keeps the baseline honest — no file is listed above its real count", () => {
    const byFile = scan();
    const stale = Object.entries(CAUTION_TOKEN_BASELINE)
      .filter(([file, count]) => (byFile.get(file) ?? 0) < count)
      .map(([file, count]) => `${file} (baseline ${count}, actual ${byFile.get(file) ?? 0})`);
    expect(stale, `Improved — lower or delete these baseline entries: ${stale.join(", ")}`).toEqual([]);
  });

  it("proves the matcher on planted fixtures", () => {
    expect(findCautionTokenOffences('className="text-signal-caution"').bareSignalCaution).toBe(true);
    expect(findCautionTokenOffences('className="text-signal-caution-text"').bareSignalCaution).toBe(false);
    expect(findCautionTokenOffences('className="text-warning"').bareSignalCaution).toBe(false);
    expect(findCautionTokenOffences('className="bg-warning"').bgWarning).toBe(true);
    expect(findCautionTokenOffences('className="border-warning/15"').bgWarning).toBe(false);
  });
});

/**
 * Guard 4 — the bare-`border` compat rule must exist, and must stay layered.
 *
 * Tailwind v4's preflight leaves a bare `border` / `border-b` / `border-e` at `currentColor`,
 * which in this palette is near-black — a defect that shipped in #219 PR A (dr-219a HIGH #3) and
 * would have shipped ~48 more times in PR B's vendored calendar tree, which contains zero
 * `border-border` classes.
 *
 * #219 PR B fixed it at the cause with one rule in `tokens/base.css` and DELETED the call-site
 * detector that had been policing it in `gantt-skin.guard.test.ts`. That deletion is only safe
 * while the rule exists. Nothing asserted that it does: both skin guards described it in prose in
 * their headers, and prose is exactly what this file exists to replace. Deleting one line of
 * `base.css` would silently re-arm an app-wide defect with both guards still green.
 *
 * This guard is the replacement invariant, pinned. It checks four things, because three of them
 * can each break the rule while leaving it present:
 *
 *   1. the declaration exists and reads `var(--border)` — not a literal, not `currentColor`;
 *   2. it covers `*`, `*::before` AND `*::after` — preflight sets all three;
 *   3. it is INSIDE `@layer base` — unlayered it would beat `@layer utilities` and break every
 *      intentional border colour in the app (`border-primary/40`, `border-(--ec-event-color)/50`);
 *   4. it is NOT inside `@layer utilities` or any other layer, for the same reason inverted.
 *
 * If you are deleting this guard, you are deleting the compat rule — which means reinstating a
 * bare-`border` detector in BOTH `gantt-skin.guard.test.ts` and
 * `event-calendar-skin.guard.test.ts`, and sweeping ~48 sites in the calendar tree by hand.
 */
describe("guard: the bare-border compat rule", () => {
  const baseCss = readFileSync(join(stylesDir, "tokens", "base.css"), "utf-8");

  /** Strip CSS comments so a rule quoted in prose cannot satisfy — or break — any assertion. */
  const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

  /** The `@layer base { ... }` blocks, by brace matching (the file has several layers). */
  function layerBodies(css: string, layer: string): string[] {
    const bodies: string[] = [];
    const opener = new RegExp(`@layer\\s+${layer}\\s*\\{`, "g");
    let m: RegExpExecArray | null;
    while ((m = opener.exec(css))) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        i++;
      }
      bodies.push(css.slice(start, i - 1));
    }
    return bodies;
  }

  const BORDER_COMPAT = /\*\s*,\s*\*::before\s*,\s*\*::after\s*\{[^}]*border-color:\s*var\(--border\)/;

  it("exists in tokens/base.css, covering *, *::before and *::after, and reads var(--border)", () => {
    expect(
      BORDER_COMPAT.test(stripCssComments(baseCss)),
      [
        "tokens/base.css must carry the bare-border compat rule:",
        "",
        "  @layer base {",
        "    *, *::before, *::after { border-color: var(--border); }",
        "  }",
        "",
        "Without it, Tailwind v4 preflight leaves every bare `border*` class at currentColor —",
        "near-black in this palette. The call-site detector that used to catch this was deleted",
        "in #219 PR B precisely because this rule replaced it.",
      ].join("\n")
    ).toBe(true);
  });

  it("is inside @layer base, so colour utilities still win", () => {
    const inBase = layerBodies(stripCssComments(baseCss), "base").some((b) => BORDER_COMPAT.test(b));
    expect(
      inBase,
      [
        "The compat rule must sit INSIDE `@layer base`. Unlayered — like the `:focus-visible`",
        "rule above it, which is unlayered on purpose — it would beat `@layer utilities` and",
        "override every intentional border colour in the app: border-border, border-primary/40,",
        "border-(--ec-event-color)/50, border-destructive/40.",
      ].join("\n")
    ).toBe(true);
  });

  it("is not duplicated into another layer, where it would outrank utilities", () => {
    const stripped = stripCssComments(baseCss);
    const elsewhere = ["utilities", "components", "theme"].filter((layer) =>
      layerBodies(stripped, layer).some((b) => BORDER_COMPAT.test(b))
    );
    expect(elsewhere, `The compat rule must not also appear in @layer ${elsewhere.join(", ")}.`).toEqual([]);
  });

  it("proves the matcher on planted fixtures", () => {
    expect(BORDER_COMPAT.test("*, *::before, *::after { border-color: var(--border); }")).toBe(true);
    // a literal instead of the role token: present, but no longer surface-aware
    expect(BORDER_COMPAT.test("*, *::before, *::after { border-color: #cfc7b6; }")).toBe(false);
    // currentColor is the defect itself
    expect(BORDER_COMPAT.test("*, *::before, *::after { border-color: currentColor; }")).toBe(false);
    // pseudo-elements dropped — preflight sets those too
    expect(BORDER_COMPAT.test("* { border-color: var(--border); }")).toBe(false);
    // the rule quoted inside a comment must not satisfy the guard
    expect(
      BORDER_COMPAT.test(
        stripCssComments("/* *, *::before, *::after { border-color: var(--border); } */")
      )
    ).toBe(false);
    // brace matching finds a rule in the SECOND @layer base block, not just the first
    expect(
      layerBodies("@layer base { html { color: red } }\n@layer base { *, *::before, *::after { border-color: var(--border); } }", "base")
        .some((b) => BORDER_COMPAT.test(b))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard — FieldDescription help/status text needs 4.5:1 (#488 design review)
// ---------------------------------------------------------------------------
// The vendored default was `text-muted-foreground` (--text-muted, greige-400): 3.57:1 on white, an axe
// `color-contrast` failure for the 12-14px help and status text under a field (same defect as #212).
describe("guard: FieldDescription reads the secondary text role (#488)", () => {
  it("does not use the muted text role", () => {
    const field = readFileSync(join(srcDir, "components/reui/field.tsx"), "utf8");
    const at = field.indexOf('data-slot="field-description"');
    expect(at, "field-description not found in reui/field.tsx").toBeGreaterThan(-1);
    const classes = /className=\{cn\(\s*"([^"]+)"/.exec(field.slice(at))?.[1] ?? "";
    expect(classes, "FieldDescription must not use the 3.57:1 muted text role").not.toMatch(/\btext-muted-foreground\b/);
    expect(classes, "FieldDescription must use text-foreground-secondary").toContain("text-foreground-secondary");
  });
});

// ---------------------------------------------------------------------------
// Guard — avatar fallback initials are text, so they need 4.5:1 (#212)
// ---------------------------------------------------------------------------
// The vendored `AvatarFallback` / `AvatarGroupCount` shipped `text-muted-foreground` on `bg-muted`:
// --text-muted (greige-400) on --bg-raised (paper-100) is 3.13:1, an axe `color-contrast` failure on
// every initials avatar that keeps the default (Board card editors, Team chip, calendar facets).
// Initials are 12–14px text, so the floor is the 4.5:1 text ratio, not the 3:1 non-text one.
describe("guard: avatar fallback initials clear 4.5:1 on their ground (#212)", () => {
  const AVATAR_FG = "text-foreground-secondary";

  it("reads the secondary text role on the muted ground, in both the fallback and the group count", () => {
    const avatar = readFileSync(join(srcDir, "components/reui/avatar.tsx"), "utf8");
    for (const slot of ["avatar-fallback", "avatar-group-count"]) {
      const at = avatar.indexOf(`data-slot="${slot}"`);
      expect(at, `${slot} not found in reui/avatar.tsx`).toBeGreaterThan(-1);
      const classes = /className=\{cn\(\s*"([^"]+)"/.exec(avatar.slice(at))?.[1] ?? "";
      expect(classes, `${slot} base classes`).toContain("bg-muted");
      expect(classes, `${slot} must not use the 3.13:1 muted text role`).not.toMatch(/\btext-muted-foreground\b/);
      expect(classes, `${slot} must use ${AVATAR_FG}`).toContain(AVATAR_FG);
    }
  });

  it("measures --foreground-secondary on --muted at 4.5:1 or more", () => {
    const declarations = new Map(
      ["tokens/colors.css", "tokens/tailwind.css"].flatMap((f) =>
        [...stripCssComments(readFileSync(join(stylesDir, f), "utf8")).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
          .map((m) => [m[1]!, m[2]!.trim()] as const)),
    );
    const resolve = (name: string): string => {
      const value = declarations.get(name) ?? "";
      const ref = /^var\((--[\w-]+)\)$/.exec(value);
      return ref ? resolve(ref[1]!) : value;
    };
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const fg = resolve("--foreground-secondary");
    const bg = resolve("--muted");
    expect(fg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(bg).toMatch(/^#[0-9a-f]{6}$/i);
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
    expect((hi! + 0.05) / (lo! + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------------------------------------------------------------------------
// Guard — the vendored Select popup and its items (#522)
// ---------------------------------------------------------------------------
// The popup shipped a `ring-1 ring-foreground/10` outline, no shadow and no inner padding, so the
// highlighted row ran edge to edge. Its item took BOTH the `focus:bg-accent` fill and the global
// `:focus-visible` ink ring, which `overflow-x-hidden` clipped. The fix is source text — happy-dom
// resolves no cascade — so it is pinned as source text, scoped to the two components (an assertion
// over the whole file would pass on a stray class anywhere in it).
//
// The item's outline is recoloured and inset with `!` on BOTH colour and offset: `tokens/base.css`
// declares an unlayered `:focus-visible { outline: … ; outline-offset: 2px }`, and unlayered CSS
// beats Tailwind's layered utilities regardless of specificity (lessons.md, inset-focus entries).
// Suppression (`outline-none` / `outline-hidden`) is never the fix — guard 3 tracks suppression.

/** The class string of the first `className=…` after `marker`, comments stripped. */
function selectClassesAfter(source: string, marker: string): string | null {
  const stripped = stripComments(source);
  const at = stripped.indexOf(marker);
  if (at < 0) return null;
  const match = /className=\{cn\(\s*"([^"]+)"/.exec(stripped.slice(at));
  return match ? match[1]! : null;
}

export function selectPopupProblems(classes: string): string[] {
  const problems: string[] = [];
  if (!/(?:^|\s)shadow-\[var\(--shadow-md\)\]/.test(classes)) problems.push("missing shadow-[var(--shadow-md)]");
  if (!/(?:^|\s)border(?:\s|$)/.test(classes) || !/(?:^|\s)border-border(?:\s|$)/.test(classes)) {
    problems.push("missing border border-border");
  }
  if (/(?:^|\s)ring-1(?:\s|$)|ring-foreground\/10/.test(classes)) problems.push("still has the ring-1 outline");
  return problems;
}

export function selectItemProblems(classes: string): string[] {
  const problems: string[] = [];
  if (!/(?:^|\s)focus-visible:!outline-\[color:var\(--accent-on\)\]/.test(classes)) {
    problems.push("outline colour must be !outline-[color:var(--accent-on)]");
  }
  if (!/(?:^|\s)focus-visible:!-outline-offset-\d+/.test(classes) &&
      !/(?:^|\s)focus-visible:!outline-offset-\[-\d+px\]/.test(classes)) {
    problems.push("outline offset must be an important negative (inset) offset");
  }
  if (/(?:^|\s)(?:focus(?:-visible)?:)?!?outline-(?:none|hidden)!?(?:\s|$)/.test(classes)) {
    problems.push("suppresses the focus outline");
  }
  if (/focus-visible:ring-/.test(classes)) problems.push("adds a second (ring) focus indicator");
  if (!/(?:^|\s)focus:bg-accent(?:\s|$)/.test(classes)) problems.push("lost the accent fill");
  return problems;
}

describe("guard: reui/select popup is elevated and its items show one inset indicator (#522)", () => {
  const source = readFileSync(join(srcDir, "components/reui/select.tsx"), "utf8");

  it("SelectContent carries a shadow token and a border, and no ring-1 outline", () => {
    const classes = selectClassesAfter(source, 'data-slot="select-content"');
    expect(classes, "SelectContent popup className not found").not.toBeNull();
    expect(selectPopupProblems(classes!)).toEqual([]);
  });

  it("SelectContent pads its list so the highlighted row is inset from the popup edge", () => {
    const stripped = stripComments(source);
    const list = /<SelectPrimitive\.List\b[^>]*>/.exec(stripped)?.[0] ?? "";
    expect(list, "SelectPrimitive.List not found").not.toBe("");
    expect(list).toMatch(/className=["{][^>]*\bp-1\b/);
  });

  it("SelectItem keeps the fill and draws one inset outline in --accent-on, important on colour and offset", () => {
    const classes = selectClassesAfter(source, 'data-slot="select-item"');
    expect(classes, "SelectItem className not found").not.toBeNull();
    expect(selectItemProblems(classes!)).toEqual([]);
  });

  it("proves the matchers on planted fixtures", () => {
    const OLD_POPUP = "relative rounded-lg bg-popover ring-1 ring-foreground/10 duration-100";
    expect(selectPopupProblems(OLD_POPUP)).toEqual([
      "missing shadow-[var(--shadow-md)]",
      "missing border border-border",
      "still has the ring-1 outline",
    ]);
    expect(selectPopupProblems("border border-border shadow-[var(--shadow-md)] bg-popover")).toEqual([]);

    const OLD_ITEM = "focus:bg-accent focus:text-accent-foreground";
    expect(selectItemProblems(OLD_ITEM)).toHaveLength(2);
    const NO_BANG = "focus:bg-accent focus-visible:outline-[color:var(--accent-on)] focus-visible:-outline-offset-4";
    expect(selectItemProblems(NO_BANG)).toHaveLength(2);
    const NO_INSET = "focus:bg-accent focus-visible:!outline-[color:var(--accent-on)]";
    expect(selectItemProblems(NO_INSET)).toEqual(["outline offset must be an important negative (inset) offset"]);
    const SUPPRESSED = "focus:bg-accent focus-visible:!outline-[color:var(--accent-on)] focus-visible:!-outline-offset-4 outline-none";
    expect(selectItemProblems(SUPPRESSED)).toEqual(["suppresses the focus outline"]);
    // The important forms are the ones that can actually beat the unlayered global outline rule.
    for (const suppress of ["focus-visible:!outline-none", "!outline-hidden", "focus:outline-none!"]) {
      const IMPORTANT = "focus:bg-accent focus-visible:!outline-[color:var(--accent-on)] focus-visible:!-outline-offset-4 " + suppress;
      expect(selectItemProblems(IMPORTANT)).toEqual(["suppresses the focus outline"]);
    }
    const GOOD = "focus:bg-accent focus-visible:!outline-[color:var(--accent-on)] focus-visible:!-outline-offset-4";
    expect(selectItemProblems(GOOD)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard — the focus ring has nothing to animate from (#532)
// ---------------------------------------------------------------------------
/**
 * Tailwind 4's `transition-colors` / `transition-all` animate `outline-color`. An unfocused
 * element's outline colour is `currentcolor`, so on a checked checkbox or a primary button (paper
 * text) the ring faded paper -> ink over 150ms on every focus. `tokens/base.css` therefore sets
 * `outline-color: var(--focus-ring)` on every element inside `@layer base`: the rest-state colour
 * is already the ring colour, so there is nothing to fade from. It must stay layered so an
 * explicit `outline-*` utility still wins.
 *
 * Because the ring is now `--focus-ring` at rest, an ink surface that is NOT a
 * `data-surface="inverse"` scope must set `--focus-ring` itself instead of overriding the outline
 * colour with `focus-visible:!outline-on-inverse` (which would fade from the rest colour again).
 */
describe("guard: outline-color defaults to --focus-ring in @layer base (#532)", () => {
  const baseCss = () => stripCssComments(readFileSync(join(stylesDir, "tokens", "base.css"), "utf8"));
  const layerBaseBodies = (css: string) =>
    topLevelBlocks(css).filter(({ prelude }) => /^@layer\s+base$/.test(prelude.trim())).map(({ body }) => body);

  it("tokens/base.css sets `outline-color: var(--focus-ring)` on all elements inside `@layer base`", () => {
    const hit = layerBaseBodies(baseCss()).some((body) =>
      /\*\s*,[^{]*\{[^}]*\boutline-color\s*:\s*var\(--focus-ring\)/.test(body));
    expect(hit, "base.css needs `*, *::before, *::after { outline-color: var(--focus-ring); }` in @layer base").toBe(true);
  });

  it("does not put that rule outside a layer (it would beat every outline utility)", () => {
    const unlayered = topLevelBlocks(baseCss()).filter(({ prelude }) => !prelude.startsWith("@"));
    expect(unlayered.filter(({ prelude, body }) => /^\*/.test(prelude.trim()) && /\boutline-color\b/.test(body))).toEqual([]);
  });

  it("the ink banner and toast set --focus-ring on their surface, not `!outline-on-inverse`", () => {
    for (const file of ["components/ImpersonationBanner.tsx", "components/quincy/ToastViewport.tsx"]) {
      const code = stripComments(readFileSync(join(srcDir, file), "utf8"));
      expect(code, `${file} must not override the ring colour`).not.toContain("outline-on-inverse");
      expect(code, `${file} must set --focus-ring on its ink surface`).toContain("[--focus-ring:var(--text-on-inverse)]");
    }
  });
});

/**
 * #552: setting only `outline-color` at rest left `outline-width` and `outline-offset` to animate
 * under `transition: all` (offset slid 0 -> 2px over ~150ms on every focus). `tokens/base.css` now
 * sets both at rest, inside `@layer base`, EQUAL to the unlayered `:focus-visible` shorthand, so on
 * focus only `outline-style` changes. If the shorthand's width or offset changes, change both.
 */
describe("guard: outline width and offset rest values match the focus ring (#552)", () => {
  const blocks = () => topLevelBlocks(stripCssComments(readFileSync(join(stylesDir, "tokens", "base.css"), "utf8")));
  const longhand = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;}]+)`).exec(body)?.[1]?.trim();

  it("tokens/base.css sets both on all elements inside @layer base, equal to the :focus-visible ring", () => {
    const ring = blocks().find(({ prelude }) => prelude === ":focus-visible")?.body ?? "";
    const ringShorthand = longhand(ring, "outline") ?? "";
    const rest = blocks()
      .filter(({ prelude }) => /^@layer\s+base$/.test(prelude))
      .flatMap(({ body }) => topLevelBlocks(body))
      .find(({ prelude, body }) => /^\*\s*,/.test(prelude) && /\boutline-width\s*:/.test(body));
    expect(rest, "base.css needs `*, *::before, *::after { outline-width; outline-offset }` in @layer base").toBeDefined();
    expect(ringShorthand.startsWith(`${longhand(rest!.body, "outline-width")} `), "rest width must equal the ring width").toBe(true);
    expect(longhand(rest!.body, "outline-offset"), "rest offset must equal the ring offset").toBe(longhand(ring, "outline-offset"));
  });
});

/**
 * #552, the other half. `tokens/base.css` rests every element at `outline-offset: 2px`. A control
 * whose focus ring is INSET (`-outline-offset-2`, `outline-offset-[-2px]`, `-outline-offset-4`, `0`)
 * and only sets that offset in its focus state would animate 2px -> -2px under `transition-all`,
 * the very slide the rest default removed. So every state-only offset that is not +2px must have its
 * counterpart at rest, in the same file and with the same spelling and the same non-state variants
 * (`max-[721px]:`, `after:`): `X focus-visible:!X`.
 *
 * Narrower than it could be: it checks "some token in this file", not "the same element", and it
 * knows the three state variants this repo uses (`focus-visible:`, `has-[…:focus-visible]:`,
 * `data-keyboard-focus:` / `data-drop-into:`).
 *
 * It also requires `!` on a bare `focus-visible:<offset>` that is NOT on a pseudo-element: the global
 * `:focus-visible` shorthand is unlayered and resets the offset, so without `!` the override never
 * applies (data-grid-column-header and rich-text-outline carried such dead overrides until #552).
 */
const STATE_VARIANT = /has-\[(?:[^\[\]]|\[[^\]]*\])*focus-visible\]:|(?<![\w-])(?:focus-visible|data-keyboard-focus|data-drop-into):/g;

export function insetOffsetProblems(source: string): string[] {
  const tokens = stripComments(source).split(/[\s"'`]+/).filter((token) => token.includes("outline-offset-"));
  const has = new Set(tokens);
  const problems: string[] = [];
  for (const token of tokens) {
    if (!/focus-visible|data-keyboard-focus|data-drop-into/.test(token)) continue;
    const value = /(-?)outline-offset-(\[[^\]]+\]|\d+)$/.exec(token.replace("!", ""));
    if (!value) continue;
    if (value[1] === "" && (value[2] === "2" || value[2] === "[2px]")) continue; // equals the rest value
    const rest = token.replace(STATE_VARIANT, "").replace("!", "");
    if (!has.has(rest)) problems.push(`${token} has no at-rest \`${rest}\``);
    const onElementItself = /(?:^|:)focus-visible:(?!after:|before:)[^:]*$/.test(token) && !token.includes("has-[");
    if (onElementItself && !token.includes("!")) problems.push(`${token} is not \`!\`-prefixed: the unlayered :focus-visible shorthand beats it`);
  }
  return problems;
}

describe("guard: an inset focus-ring offset is also set at rest (#552)", () => {
  it("every state-only outline-offset that is not +2px has its at-rest twin", () => {
    const offenders = sourceFiles().flatMap((file) =>
      insetOffsetProblems(readFileSync(file, "utf8")).map((problem) => `  ${rel(file)}: ${problem}`));
    expect(offenders, [
      "A focus/state-only `outline-offset` that differs from the +2px rest value animates under",
      "`transition-all`. Add the same utility, un-prefixed, beside it, e.g.",
      "`outline-offset-[-2px] focus-visible:!outline-offset-[-2px]`.",
      ...offenders,
    ].join("\n")).toEqual([]);
  });

  it("proves the matcher on planted fixtures", () => {
    expect(insetOffsetProblems("focus-visible:!outline-offset-[-2px]")).toHaveLength(1);
    expect(insetOffsetProblems("outline-offset-[-2px] focus-visible:!outline-offset-[-2px]")).toEqual([]);
    expect(insetOffsetProblems("focus-visible:!-outline-offset-4")).toHaveLength(1);
    expect(insetOffsetProblems("-outline-offset-4 focus-visible:!-outline-offset-4")).toEqual([]);
    // +2 equals the rest value
    expect(insetOffsetProblems("focus-visible:!outline-offset-2 focus-visible:outline-offset-2")).toEqual([]);
    // other variants must match
    expect(insetOffsetProblems("max-[721px]:focus-visible:!-outline-offset-2")).toHaveLength(1);
    expect(insetOffsetProblems("max-[721px]:-outline-offset-2 max-[721px]:focus-visible:!-outline-offset-2")).toEqual([]);
    expect(insetOffsetProblems("focus-visible:after:-outline-offset-2")).toHaveLength(1);
    expect(insetOffsetProblems("after:-outline-offset-2 focus-visible:after:-outline-offset-2")).toEqual([]);
    expect(insetOffsetProblems("has-[[data-x]:focus-visible]:outline-offset-[-2px]")).toHaveLength(1);
    expect(insetOffsetProblems("outline-offset-[-2px] has-[[data-x]:focus-visible]:outline-offset-[-2px]")).toEqual([]);
    expect(insetOffsetProblems("data-keyboard-focus:-outline-offset-2")).toHaveLength(1);
    // a bare, non-! focus-visible override is dead
    expect(insetOffsetProblems("outline-offset-[-2px] focus-visible:outline-offset-[-2px]")).toHaveLength(1);
    expect(insetOffsetProblems("outline-offset-[-2px] focus-visible:!outline-offset-[-2px]")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard — no unlayered element-type selector in styles/ (#569)
// ---------------------------------------------------------------------------
/**
 * Unlayered CSS beats everything in Tailwind's `@layer utilities` regardless of specificity, so an
 * unlayered `p { margin: 0 }` made `mt-*` on a <p> a silent no-op (#527's note, `!mt-[…]` in
 * CreateProject/Admin). Element resets belong inside `@layer base`.
 *
 * Deliberately narrow: it flags only a top-level (or top-level @media/@supports) rule with a
 * selector that STARTS with an element type or `*` — `p`, `h1`, `a`, `button`, `*`, `html`, `body`,
 * `img`. It ignores class/attribute/id selectors (app.css is full of intentional unlayered
 * component rules), `:root`, pseudo-element-only selectors such as `::selection`, and the global
 * `:focus-visible` ring, which is unlayered on purpose (Guard 3b/3c). `@keyframes`, `@font-face`
 * and `@property` bodies are skipped. The reduced-motion `* { …!important }` rule is exempt: it
 * must beat utilities.
 */
export function unlayeredElementSelectors(css: string): string[] {
  const out: string[] = [];
  const visit = (source: string) => {
    for (const { prelude, body } of topLevelBlocks(source)) {
      if (/^@(media|supports|container)\b/.test(prelude)) {
        if (REDUCED_MOTION_MEDIA.test(prelude)) continue;
        visit(body);
        continue;
      }
      if (prelude.startsWith("@")) continue; // @layer, @keyframes, @font-face, @property, @theme
      for (const selector of prelude.split(",").map((part) => part.trim())) {
        if (/^(?:\*|[a-z][a-z0-9-]*)(?![\w-])/i.test(selector)) out.push(selector.replace(/\s+/g, " "));
      }
    }
  };
  visit(stripComments(css));
  return out;
}

describe("guard: no unlayered element-type selectors in styles/ (#569)", () => {
  it("every element reset in styles/**/*.css sits inside @layer base", () => {
    const offenders = cssFiles().flatMap((file) =>
      unlayeredElementSelectors(readFileSync(file, "utf8")).map((selector) => `  ${selector} — ${rel(file)}`));
    expect(offenders, [
      "An element-type selector (`p`, `h1`, `button`, `*`, …) is declared outside any @layer. It beats",
      "every Tailwind utility regardless of specificity (a `mt-*` on a <p> silently does nothing).",
      "Move it inside `@layer base { … }`.",
      ...offenders,
    ].join("\n")).toEqual([]);
  });

  it("proves the detector on planted fixtures", () => {
    expect(unlayeredElementSelectors("p { margin: 0; }")).toEqual(["p"]);
    expect(unlayeredElementSelectors("h1, h2 { margin: 0 }\na { color: inherit }")).toEqual(["h1", "h2", "a"]);
    expect(unlayeredElementSelectors("*, *::before { box-sizing: border-box; }")).toEqual(["*", "*::before"]);
    expect(unlayeredElementSelectors("button:hover { color: red }")).toEqual(["button:hover"]);
    expect(unlayeredElementSelectors("@media (min-width: 40em) { p { margin: 1px } }")).toEqual(["p"]);
    // layered, classed, scoped, pseudo-only, custom-property roots: fine
    expect(unlayeredElementSelectors("@layer base { p { margin: 0 } h1 { margin: 0 } }")).toEqual([]);
    expect(unlayeredElementSelectors(".card p { margin: 0 } [data-x] { } #a { } :root { } ::selection { } :focus-visible { }")).toEqual([]);
    expect(unlayeredElementSelectors("@keyframes spin { from { transform: none } to { transform: none } }")).toEqual([]);
    // the reduced-motion `*` rule must beat utilities, on purpose
    expect(unlayeredElementSelectors("@media (prefers-reduced-motion: reduce) { * { animation-duration: 1ms !important } }")).toEqual([]);
    // quoted in a comment only
    expect(unlayeredElementSelectors("/* p { margin: 0 } */")).toEqual([]);
  });
});

/**
 * #541: a focus ring coloured from a raw palette step ignores `data-surface="inverse"` scopes (and
 * the banner/toast `--focus-ring` override), so the ring is ink on ink. Any `focus*:` / `has-[…focus…]`
 * / `focus-visible:after:` outline colour has to read `var(--focus-ring)` (or a role utility), never
 * `--ink-N` / `--paper-N` / `--greige-N` or the palette utilities.
 */
export function rawFocusRingColourProblems(source: string): string[] {
  return source.split(/[\s"'`]+/).filter((token) =>
    token.includes("focus") && /outline-(?:\[var\(--(?:ink|paper|greige)-\d+\)\]|(?:ink|paper|greige)-\d+)(?![\w-])/.test(token));
}

describe("guard: focus ring colour never comes from a raw palette step (#541)", () => {
  it("flags planted raw-palette focus outlines and accepts the token", () => {
    expect(rawFocusRingColourProblems('"focus-visible:!outline-[var(--ink-900)]"')).toHaveLength(1);
    expect(rawFocusRingColourProblems('"focus-visible:after:outline-[var(--paper-050)]"')).toHaveLength(1);
    expect(rawFocusRingColourProblems('"has-[:focus-visible]:outline-greige-200"')).toHaveLength(1);
    expect(rawFocusRingColourProblems('"focus-visible:!outline-[var(--focus-ring)] outline-[var(--ink-900)]"')).toEqual([]);
  });

  it("no source file colours a focus ring from the palette", () => {
    const offenders = sourceFiles().flatMap((file) =>
      rawFocusRingColourProblems(stripComments(readFileSync(file, "utf8"))).map((token) => `${rel(file)}: ${token}`));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard — one active-row cue in a person picker (#514)
// ---------------------------------------------------------------------------
/**
 * The mention list marked its active row with a 2px ink left bar while Select and Combobox filled
 * the row with `bg-accent`: three pickers, two cues. The mention list now shares the fill, so a
 * left-bar active treatment (or an active row with no fill) is a regression.
 */
describe("guard: the mention list's active row uses the shared fill, not a left bar (#514)", () => {
  function mentionRowProblems(classes: string): string[] {
    const tokens = classes.split(/\s+/);
    const problems: string[] = [];
    if (!tokens.includes("data-[active=true]:bg-accent")) problems.push("active row has no bg-accent fill");
    if (!tokens.includes("data-[active=true]:text-accent-foreground")) problems.push("active row has no text-accent-foreground");
    if (tokens.some((token) => /^(data-\[active=true\]:)?(border-l|border-l-|\[border-left)/.test(token) || /border-strong/.test(token))) problems.push("active row still draws a left bar");
    return problems;
  }
  const source = () => stripComments(readFileSync(join(srcDir, "components", "MentionAutocomplete.tsx"), "utf8"));
  const rowClasses = () => /data-slot="mention-option"[\s\S]*?className="([^"]*)"/.exec(source())?.[1] ?? "";

  it("MentionAutocomplete's option row passes", () => {
    expect(rowClasses(), "option row className not found").not.toBe("");
    expect(mentionRowProblems(rowClasses())).toEqual([]);
  });

  it("proves the matcher on planted fixtures", () => {
    const OLD = "bg-transparent border-0 [border-left-style:solid] border-l-[length:var(--border-width-bold)] border-l-transparent data-[active=true]:border-l-border-strong";
    expect(mentionRowProblems(OLD)).toEqual(["active row has no bg-accent fill", "active row has no text-accent-foreground", "active row still draws a left bar"]);
    expect(mentionRowProblems("data-[active=true]:bg-accent data-[active=true]:text-accent-foreground data-[active=true]:border-l-border-strong")).toEqual(["active row still draws a left bar"]);
    expect(mentionRowProblems("rounded-md data-[active=true]:bg-accent data-[active=true]:text-accent-foreground")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard — one popup radius across the pickers (#550)
// ---------------------------------------------------------------------------
/**
 * The Team popup was 14px (`rounded-lg`), Select was square and Mention square, so the Mention list's
 * rounded active row sat in a square popup next to a round one. Every list overlay is square
 * (`rounded-none`, with `rounded-md` rows inset by `p-1`); a `rounded-*` other than none on any of the
 * three popups is a regression.
 */
describe("guard: Team, Select and Mention popups share one square radius (#550)", () => {
  function popupRadiusProblems(classes: string): string[] {
    const radii = classes.split(/\s+/).filter((token) => /^rounded(?:-|$)/.test(token));
    return radii.length === 1 && radii[0] === "rounded-none" ? [] : [`expected exactly rounded-none, found [${radii.join(", ")}]`];
  }
  const read = (file: string) => stripComments(readFileSync(join(srcDir, file), "utf8"));
  const classesAfter = (source: string, marker: string) => {
    const at = source.indexOf(marker);
    return at < 0 ? "" : (/className=\{?(?:cn\()?\s*"([^"]+)"/.exec(source.slice(at))?.[1] ?? "");
  };

  it.each([
    ["components/reui/combobox.tsx", "<ComboboxPrimitive.Popup"],
    ["components/reui/select.tsx", "<SelectPrimitive.Popup"],
    ["components/MentionAutocomplete.tsx", 'data-slot="mention-content"'],
  ])("%s popup is rounded-none", (file, marker) => {
    const classes = classesAfter(read(file), marker);
    expect(classes, `${file}: popup className not found`).not.toBe("");
    expect(popupRadiusProblems(classes)).toEqual([]);
  });

  it("proves the matcher on planted fixtures", () => {
    expect(popupRadiusProblems("relative rounded-lg bg-popover")).toEqual(["expected exactly rounded-none, found [rounded-lg]"]);
    expect(popupRadiusProblems("relative bg-popover")).toEqual(["expected exactly rounded-none, found []"]);
    expect(popupRadiusProblems("relative rounded-none bg-popover")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard 5 — one focus line: no field primitive recolours its border on focus
// ---------------------------------------------------------------------------
/**
 * #613 item 3 (owner decision). A focused field drew TWO dark rules: a 1px border turned
 * `border-primary`/`border-ring` AND the 2px focus outline sat two pixels outside it (the
 * composer at 1920 showed them at x≈122 and x≈126). The 2px outline is the Portal's single focus
 * indicator, the same one buttons draw, so a field keeps its rest/hover border colour on focus.
 *
 * Two checks: the named field primitives carry no focus-time `border-<colour>` token at all, and
 * no file combines one with a focus outline utility. Error colours (`aria-invalid:`) are not
 * focus-time and are untouched.
 */
/**
 * Splits a class token into its variant prefix and utility at the last TOP-LEVEL colon, so a nested
 * arbitrary variant such as `has-[[contenteditable=true]:focus-visible]:border-primary` (colons and
 * brackets inside brackets) is read correctly. A regex over `[^\]]*` cannot do this.
 */
function splitVariant(token: string): { variants: string; utility: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) cut = i;
  }
  return { variants: token.slice(0, cut + 1), utility: token.slice(cut + 1) };
}
/**
 * Whitespace and quote characters separate class tokens ONLY at bracket depth 0: a quote inside an
 * arbitrary variant (`has-[[contenteditable='true']:focus-visible]:border-primary`) is part of the
 * token and must not split it.
 */
function classTokens(source: string): { variants: string; utility: string }[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of source) {
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[\s"'`]/.test(c)) {
      if (current) tokens.push(current);
      current = "";
    } else current += c;
  }
  if (current) tokens.push(current);
  // Tailwind's important modifier is a `!` prefix (v3/v4) or suffix (v4); normalise before matching.
  return tokens.map(splitVariant).map(({ variants, utility }) => ({ variants, utility: utility.replace(/^!/, "").replace(/!$/, "") }));
}
const FOCUS_VARIANT = /focus/;
const BORDER_COLOUR_UTILITY = /^border-(?!0$|transparent$|none$|solid$|\[length)/;
const FOCUS_OUTLINE_UTILITY = /^outline-(?:ring|solid|\[length)/;
const FOCUS_BORDER_COLOUR = { test: (code: string) => classTokens(code).some((t) => FOCUS_VARIANT.test(t.variants) && BORDER_COLOUR_UTILITY.test(t.utility)) };
const FOCUS_OUTLINE = { test: (code: string) => classTokens(code).some((t) => FOCUS_VARIANT.test(t.variants) && FOCUS_OUTLINE_UTILITY.test(t.utility)) };
const FIELD_PRIMITIVES = [
  "components/reui/input-group.tsx",
  "components/reui/input.tsx",
  "components/reui/textarea.tsx",
  "components/reui/select.tsx",
  "components/reui/combobox.tsx",
  "components/quincy/NativeSelect.tsx",
  "components/QuincyRichTextEditor.tsx",
  "lib/rail-field.ts",
];

function stripSourceComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function hasFocusBorderColour(source: string): boolean {
  return FOCUS_BORDER_COLOUR.test(stripSourceComments(source));
}

describe("guard: one focus line — no field primitive recolours its border on focus (#613 item 3)", () => {
  it("named field primitives carry no focus-time border colour", () => {
    const offenders = FIELD_PRIMITIVES.filter((file) => hasFocusBorderColour(readFileSync(join(srcDir, file), "utf8")));
    expect(
      offenders,
      "These field primitives recolour their border on focus while the focus outline also paints: two dark lines. Drop the border-colour utility; keep only the outline (#613 item 3).",
    ).toEqual([]);
  });

  it("no source file pairs a focus-time border colour with a focus outline", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const code = stripSourceComments(readFileSync(full, "utf8"));
          if (FOCUS_BORDER_COLOUR.test(code) && FOCUS_OUTLINE.test(code)) offenders.push(relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it("the detector flags the doubled pairing and spares rest, hover and error colours", () => {
    expect(hasFocusBorderColour('"focus-visible:border-ring"')).toBe(true);
    expect(hasFocusBorderColour('"has-[input:focus-visible]:border-primary outline-solid"')).toBe(true);
    expect(hasFocusBorderColour('"focus-within:border-ring"')).toBe(true);
    // nested-bracket arbitrary variant (the rich-text editor's contenteditable focus selector)
    expect(hasFocusBorderColour('"has-[[contenteditable=true]:focus-visible]:border-primary"')).toBe(true);
    expect(FOCUS_OUTLINE.test('"has-[[contenteditable=true]:focus-visible]:outline-ring"')).toBe(true);
    // quotes inside a nested variant stay part of the token
    expect(hasFocusBorderColour(`"has-[[contenteditable='true']:focus-visible]:border-primary"`)).toBe(true);
    expect(hasFocusBorderColour('"has-[[contenteditable=\\"true\\"]:focus-visible]:border-primary"')).toBe(true);
    expect(FOCUS_OUTLINE.test(`"has-[[contenteditable='true']:focus-visible]:outline-ring"`)).toBe(true);
    // important modifier, prefix and Tailwind v4 suffix
    expect(hasFocusBorderColour('"focus-visible:!border-ring"')).toBe(true);
    expect(hasFocusBorderColour('"focus-visible:border-ring!"')).toBe(true);
    expect(FOCUS_OUTLINE.test('"focus-visible:!outline-ring"')).toBe(true);
    expect(FOCUS_OUTLINE.test('"focus-visible:outline-solid!"')).toBe(true);
    expect(hasFocusBorderColour('"focus-visible:!border-0 focus-visible:border-transparent!"')).toBe(false);
    expect(hasFocusBorderColour('"focus-visible:border-[color:var(--border-strong)]"')).toBe(true);
    expect(hasFocusBorderColour('"hover:border-border-hover focus-visible:outline-ring aria-invalid:border-destructive"')).toBe(false);
    expect(hasFocusBorderColour('"focus-visible:border-0 border-border"')).toBe(false);
    expect(hasFocusBorderColour("// focus-visible:border-ring in a comment")).toBe(false);
  });
});
