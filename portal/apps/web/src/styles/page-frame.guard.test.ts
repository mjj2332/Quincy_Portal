/**
 * Page frame guard — full-width Dashboard.
 *
 * `.page` is the capped page frame (`max-width: var(--container-page)`); `.page--full` lifts the cap
 * and swaps the frame's inline padding for the layout gutter (`--gutter`, 32px) — `--space-4`
 * (16px) at ≤720px. The Dashboard and ProjectWorkspace's loading/unavailable/error states are full
 * width; every other `.page` stays capped. This guard pins:
 *
 *   (a) `--container-page` is declared exactly once in `tokens/spacing.css`, as a px length in a
 *       top-level `:root` rule (not inside `@media` or on any other selector), and the `.page` rule
 *       reads it with no px `max-width` literal;
 *   (b) `.page--full`'s declarations exactly, after `.page` (equal specificity, so source order is
 *       what lets its `padding-inline` beat the `padding` shorthand), and the ≤720 override exactly,
 *       after the phone `.page` rule in the same `@media (max-width: 720px)` block;
 *   (c) a split manifest: per non-test `.tsx` under `src`, how many className string literals,
 *       `const` string initialisers and `cn(…)`/`clsx(…)`/`twMerge(…)` calls inside a className
 *       expression carry the full frame (`page page--full`) vs the capped frame (`page` alone). An
 *       unlisted file using either class, or a count mismatch, fails.
 *
 * Blind spot, by design: (c) reads only `className="…"`, `className={"…"}`, `` className={`…`} ``,
 * `const X = "…"` literals, and the string-literal arguments of a `cn`/`clsx`/`twMerge` call written
 * inside `className={…}`. A frame class reaching className any other way (a ternary of bare
 * literals, `const X = cn("page")`, a prop) is not counted.
 *
 * Per `docs/lessons.md` — "a grep gate that cannot fail is not a gate" — every detector is a pure
 * function over injected text, proven against planted fixtures that must fail, alongside the real
 * scan.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const stylesDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(stylesDir, "..");

// ---------------------------------------------------------------------------------------------
// CSS parsing
// ---------------------------------------------------------------------------------------------

type Declaration = [prop: string, value: string];
type CssRule = { selector: string; ancestors: string[]; blockId: number; index: number; declarations: Declaration[] };

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseDeclarations(body: string): Declaration[] {
  return body
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const colon = part.indexOf(":");
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, " ")] as Declaration;
    });
}

/** Flattens every style rule, recording its enclosing at-rule preludes and the block it sits in. */
export function parseCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let nextBlockId = 1;
  const walk = (text: string, ancestors: string[], blockId: number) => {
    let i = 0;
    let preludeStart = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === ";") {
        preludeStart = i + 1; // a statement at-rule (`@import …;`) or stray declaration
      } else if (ch === "{") {
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === "{") depth++;
          else if (text[j] === "}") depth--;
          j++;
        }
        const prelude = text.slice(preludeStart, i).trim().replace(/\s+/g, " ");
        const body = text.slice(i + 1, j - 1);
        if (body.includes("{")) {
          walk(body, [...ancestors, prelude], nextBlockId++);
        } else {
          rules.push({ selector: prelude, ancestors, blockId, index: rules.length, declarations: parseDeclarations(body) });
        }
        i = j;
        preludeStart = j;
        continue;
      }
      i++;
    }
  };
  walk(stripComments(css), [], 0);
  return rules;
}

const PHONE_MEDIA = "@media (max-width: 720px)";

function sameDeclarations(actual: Declaration[], expected: Declaration[]): boolean {
  return actual.length === expected.length && expected.every(([p, v], k) => actual[k]?.[0] === p && actual[k]?.[1] === v);
}

function show(declarations: Declaration[]): string {
  return `{ ${declarations.map(([p, v]) => `${p}: ${v};`).join(" ")} }`;
}

// ---------------------------------------------------------------------------------------------
// (a) --container-page and the .page cap
// ---------------------------------------------------------------------------------------------

export function findContainerTokenErrors(spacingCss: string): string[] {
  const declarations = parseCssRules(spacingCss).flatMap((rule) =>
    rule.declarations.filter(([p]) => p === "--container-page").map(([, v]) => ({ rule, value: v })),
  );
  const [only] = declarations;
  if (declarations.length !== 1 || !only) {
    return [`tokens/spacing.css must declare \`--container-page\` exactly once; found ${declarations.length}.`];
  }
  const errors: string[] = [];
  if (only.rule.ancestors.length !== 0 || only.rule.selector !== ":root") {
    errors.push(
      `\`--container-page\` must be declared in a top-level \`:root\` rule; found in \`${only.rule.selector}\` under ${JSON.stringify(only.rule.ancestors)}.`,
    );
  }
  if (!/^\d+px$/.test(only.value)) errors.push(`\`--container-page\` must be a px length; found \`${only.value}\`.`);
  return errors;
}

export function findPageCapErrors(appCss: string): string[] {
  const pages = parseCssRules(appCss).filter((rule) => rule.ancestors.length === 0 && rule.selector === ".page");
  const [page] = pages;
  if (pages.length !== 1 || !page) return [`Expected exactly one top-level \`.page\` rule, found ${pages.length}.`];
  const errors: string[] = [];
  const maxWidths = page.declarations.filter(([p]) => p === "max-width");
  if (maxWidths.length !== 1 || maxWidths[0]?.[1] !== "var(--container-page)") {
    errors.push(`\`.page\` must declare \`max-width: var(--container-page)\` once; found ${show(maxWidths)}.`);
  }
  if (maxWidths.some(([, v]) => /\d+px/.test(v))) errors.push("`.page` max-width must not be a px literal.");
  return errors;
}

// ---------------------------------------------------------------------------------------------
// (b) .page--full, exactly
// ---------------------------------------------------------------------------------------------

const FULL_DESKTOP: Declaration[] = [["max-width", "none"], ["padding-inline", "var(--gutter)"]];
const FULL_PHONE: Declaration[] = [["padding-inline", "var(--space-4)"]];

export function findPageFullErrors(appCss: string): string[] {
  const rules = parseCssRules(appCss);
  const errors: string[] = [];

  const topPage = rules.filter((r) => r.ancestors.length === 0 && r.selector === ".page");
  const topFull = rules.filter((r) => r.ancestors.length === 0 && r.selector === ".page--full");
  const [full] = topFull;
  const [page] = topPage;
  if (topFull.length !== 1 || !full) {
    errors.push(`Expected exactly one top-level \`.page--full\` rule, found ${topFull.length}.`);
  } else {
    if (!sameDeclarations(full.declarations, FULL_DESKTOP)) {
      errors.push(`\`.page--full\` must be exactly ${show(FULL_DESKTOP)}; found ${show(full.declarations)}.`);
    }
    if (topPage.length !== 1 || !page || full.index < page.index) {
      errors.push("`.page--full` must come after the single top-level `.page` rule, or `.page`'s padding shorthand wins.");
    }
  }

  const phoneFull = rules.filter((r) => r.selector === ".page--full" && r.ancestors.length > 0);
  const [override] = phoneFull;
  if (phoneFull.length !== 1 || !override) {
    errors.push(`Expected exactly one nested \`.page--full\` rule (the ≤720 override), found ${phoneFull.length}.`);
    return errors;
  }
  if (override.ancestors.length !== 1 || override.ancestors[0] !== PHONE_MEDIA) {
    errors.push(`The \`.page--full\` override must sit directly in \`${PHONE_MEDIA}\`; found in ${JSON.stringify(override.ancestors)}.`);
  }
  if (!sameDeclarations(override.declarations, FULL_PHONE)) {
    errors.push(`The ≤720 \`.page--full\` override must be exactly ${show(FULL_PHONE)}; found ${show(override.declarations)}.`);
  }
  const phonePage = rules.find((r) => r.selector === ".page" && r.blockId === override.blockId);
  if (!phonePage || phonePage.index > override.index) {
    errors.push("The ≤720 `.page--full` override must follow the phone `.page` rule in the same media block.");
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// (c) the full vs capped split
// ---------------------------------------------------------------------------------------------

export type FrameCounts = { full: number; capped: number };

const CLASS_NAME_LITERAL = /\bclassName\s*=\s*(?:\{\s*)?(["'`])((?:(?!\1)[\s\S])*)\1/g;
const CONST_LITERAL = /\bconst\s+[A-Za-z_$][\w$]*\s*=\s*(["'`])((?:(?!\1)[\s\S])*)\1/g;

const CLASS_NAME_EXPRESSION = /\bclassName\s*=\s*\{/g;
const CLASS_MERGE_CALL = /\b(?:cn|clsx|twMerge)\s*\(/g;
const STRING_LITERAL = /(["'`])((?:(?!\1)[\s\S])*)\1/g;

/** The text between the opener at `open` (`{` or `(`) and its matching closer. */
function balancedBody(source: string, open: number): string {
  const opener = source[open];
  const closer = opener === "{" ? "}" : ")";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === opener) depth++;
    else if (source[i] === closer && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

/** The class tokens of one literal; a template literal's `${…}` holes are dropped. */
function literalTokens(quote: string | undefined, body: string): string[] {
  return (quote === "`" ? body.replace(/\$\{[^}]*\}/g, " ") : body).split(/\s+/);
}

/** Every class-token set to classify: each className/const literal on its own, and each
 * `cn`/`clsx`/`twMerge` call inside a `className={…}` expression as the union of its string-literal
 * arguments (a nested merge call is folded into its outermost call). */
function frameTokenSets(source: string): string[][] {
  const sets: string[][] = [];
  for (const pattern of [CLASS_NAME_LITERAL, CONST_LITERAL]) {
    for (const [, quote, body = ""] of source.matchAll(pattern)) sets.push(literalTokens(quote, body));
  }
  for (const expression of source.matchAll(CLASS_NAME_EXPRESSION)) {
    const text = balancedBody(source, expression.index + expression[0].length - 1);
    const call = new RegExp(CLASS_MERGE_CALL);
    for (let match = call.exec(text); match; match = call.exec(text)) {
      const args = balancedBody(text, match.index + match[0].length - 1);
      sets.push([...args.matchAll(STRING_LITERAL)].flatMap(([, quote, body = ""]) => literalTokens(quote, body)));
      call.lastIndex = match.index + match[0].length + args.length + 1;
    }
  }
  return sets;
}

/** Counts className/const string literals, and className merge calls, carrying the page frame
 * class. A set with `page--full` is a full frame; `page` without it is capped; `page--full` without
 * `page` has no frame at all and is reported as an error. */
export function countFrameClasses(source: string): FrameCounts & { orphans: number } {
  const counts = { full: 0, capped: 0, orphans: 0 };
  for (const tokens of frameTokenSets(source)) {
    const hasPage = tokens.includes("page");
    const hasFull = tokens.includes("page--full");
    if (hasFull && hasPage) counts.full++;
    else if (hasFull) counts.orphans++;
    else if (hasPage) counts.capped++;
  }
  return counts;
}

export function diffFrameManifest(
  actual: Record<string, FrameCounts & { orphans: number }>,
  expected: Record<string, FrameCounts>,
): string[] {
  const errors: string[] = [];
  for (const [file, counts] of Object.entries(actual)) {
    if (counts.orphans > 0) errors.push(`${file}: ${counts.orphans} literal(s) carry \`page--full\` without \`page\`.`);
    if (counts.full + counts.capped === 0) continue;
    const want = expected[file];
    if (!want) {
      errors.push(`${file}: uses the page frame (full ${counts.full}, capped ${counts.capped}) but is not in the manifest.`);
    } else if (want.full !== counts.full || want.capped !== counts.capped) {
      errors.push(`${file}: expected full ${want.full}, capped ${want.capped}; found full ${counts.full}, capped ${counts.capped}.`);
    }
  }
  for (const file of Object.keys(expected)) {
    const got = actual[file];
    if (!got || got.full + got.capped === 0) errors.push(`${file}: listed in the manifest but uses no page frame.`);
  }
  return errors;
}

/** Owner decision: Dashboard and ProjectWorkspace's transient states are full width (the ready
 * workspace is `.work`, not `.page`); everything else stays capped. */
const FRAME_MANIFEST: Record<string, FrameCounts> = {
  "screens/Dashboard.tsx": { full: 1, capped: 0 },
  // FULL_PAGE (loading/unavailable/error) + the two collaboration-only views, capped.
  "screens/ProjectWorkspace.tsx": { full: 1, capped: 2 },
  "screens/CreateProject.tsx": { full: 0, capped: 1 },
  "screens/EditProject.tsx": { full: 0, capped: 1 },
  "screens/Admin.tsx": { full: 0, capped: 1 },
  "screens/Notifications.tsx": { full: 0, capped: 1 },
  "screens/NotificationPreferences.tsx": { full: 0, capped: 1 },
  "lib/app-router.tsx": { full: 0, capped: 2 },
};

function listSourceTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listSourceTsx(path));
    else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const GOOD_CSS = `
/* .page { max-width: 1480px; } — comments are ignored */
.page { width: 100%; max-width: var(--container-page); margin: 0 auto; padding: var(--space-7) var(--space-7) var(--space-10); }
.page--full { max-width: none; padding-inline: var(--gutter); }
@media (max-width: 720px) {
  .page { padding: var(--space-6) var(--space-4) var(--space-9); }
  .page--full { padding-inline: var(--space-4); }
}
`;

describe("page frame detectors (planted fixtures)", () => {
  it("accept the good fixture", () => {
    expect(findPageCapErrors(GOOD_CSS)).toEqual([]);
    expect(findPageFullErrors(GOOD_CSS)).toEqual([]);
    expect(findContainerTokenErrors(":root { --container-xl: 1320px; --container-page: 1480px; }")).toEqual([]);
  });

  it("(a) fail on a missing token and on a px cap", () => {
    expect(findContainerTokenErrors(":root { --container-xl: 1320px; }")).not.toEqual([]);
    expect(findContainerTokenErrors("/* --container-page: 1480px; */ :root { --x: 1px; }")).not.toEqual([]);
    expect(findContainerTokenErrors(":root { --container-page: var(--container-xl); }")).not.toEqual([]);
  });

  it("(a) fail when --container-page is not a single top-level :root declaration", () => {
    const planted = [
      // Only inside a media query.
      ":root { --container-xl: 1320px; }\n@media (max-width: 720px) { :root { --container-page: 1480px; } }",
      // On another selector.
      ":root { --container-xl: 1320px; }\n.foo { --container-page: 1480px; }",
      // Twice: the top-level one plus a media override.
      ":root { --container-page: 1480px; }\n@media (max-width: 720px) { :root { --container-page: 1200px; } }",
      // Twice at top level.
      ":root { --container-page: 1480px; }\n:root { --container-page: 1400px; }",
    ];
    for (const css of planted) expect(findContainerTokenErrors(css)).not.toEqual([]);
    expect(findPageCapErrors(GOOD_CSS.replace("max-width: var(--container-page)", "max-width: 1480px"))).not.toEqual([]);
    expect(findPageCapErrors(GOOD_CSS.replace("max-width: var(--container-page); ", ""))).not.toEqual([]);
  });

  it("(b) fail on any drift in .page--full", () => {
    const planted = [
      GOOD_CSS.replace("max-width: none; padding-inline: var(--gutter);", "max-width: none;"),
      GOOD_CSS.replace("padding-inline: var(--gutter)", "padding-inline: var(--space-7)"),
      GOOD_CSS.replace("max-width: none;", "max-width: 1920px;"),
      GOOD_CSS.replace("padding-inline: var(--gutter); }", "padding-inline: var(--gutter); margin: 0; }"),
      // Before `.page`: the shorthand would win.
      GOOD_CSS.replace(".page--full { max-width: none; padding-inline: var(--gutter); }\n", "").replace(
        ".page { width",
        ".page--full { max-width: none; padding-inline: var(--gutter); }\n.page { width",
      ),
      GOOD_CSS.replace("  .page--full { padding-inline: var(--space-4); }\n", ""),
      GOOD_CSS.replace("padding-inline: var(--space-4)", "padding-inline: var(--gutter)"),
      GOOD_CSS.replace("@media (max-width: 720px)", "@media (max-width: 721px)"),
      // Override ahead of the phone `.page` rule.
      GOOD_CSS.replace(
        "  .page { padding: var(--space-6) var(--space-4) var(--space-9); }\n  .page--full { padding-inline: var(--space-4); }",
        "  .page--full { padding-inline: var(--space-4); }\n  .page { padding: var(--space-6) var(--space-4) var(--space-9); }",
      ),
      // Override in a different 720 block from the phone `.page` rule.
      GOOD_CSS.replace("  .page--full { padding-inline: var(--space-4); }\n", "") +
        "@media (max-width: 720px) { .page--full { padding-inline: var(--space-4); } }",
    ];
    for (const css of planted) {
      expect(css).not.toBe(GOOD_CSS);
      expect(findPageFullErrors(css)).not.toEqual([]);
    }
  });

  it("(c) ignore look-alikes and count real frame literals", () => {
    const falsePositives = [
      `<a aria-current="page" href="/">x</a>`,
      `<NotificationList scale="page" />`,
      `const pageSize = 20; const x = { pageSize };`,
      `<div className="pagehead" />`,
      `<div className="page-header page-x" />`,
      `const LABEL = "pagehead page-title";`,
      `if (scale === "page") return null;`,
      `type Scale = "panel" | "page";`,
    `<div className={cn("pagehead", x)} />`,
    `<div className={cn(active && "page-x", "grid")} />`,
    `const merged = cn("grid", "gap-2");`,
    ].join("\n");
    expect(countFrameClasses(falsePositives)).toEqual({ full: 0, capped: 0, orphans: 0 });

    expect(countFrameClasses(`<main className="page">`)).toEqual({ full: 0, capped: 1, orphans: 0 });
    expect(countFrameClasses(`<main className="page !max-w-[1080px]">`)).toEqual({ full: 0, capped: 1, orphans: 0 });
    expect(countFrameClasses(`<main className="page page--full [overflow-x:clip]">`)).toEqual({ full: 1, capped: 0, orphans: 0 });
    expect(countFrameClasses(`const FULL_PAGE = "page page--full";`)).toEqual({ full: 1, capped: 0, orphans: 0 });
    expect(countFrameClasses(`<main className={"page grid"}>`)).toEqual({ full: 0, capped: 1, orphans: 0 });
    expect(countFrameClasses("<main className={`page ${x}`}>")).toEqual({ full: 0, capped: 1, orphans: 0 });
    expect(countFrameClasses(`<main className="page--full">`)).toEqual({ full: 0, capped: 0, orphans: 1 });
  });

  it("(c) count frame classes passed through cn/clsx/twMerge in a className expression", () => {
    expect(countFrameClasses(`<main className={cn("page", "page--full")}>`)).toEqual({ full: 1, capped: 0, orphans: 0 });
    expect(countFrameClasses(`<main className={cn("page", x)}>`)).toEqual({ full: 0, capped: 1, orphans: 0 });
    expect(countFrameClasses(`<main className={clsx("page", wide && "page--full")}>`)).toEqual({ full: 1, capped: 0, orphans: 0 });
    expect(countFrameClasses(`<main className={twMerge("page grid", x)}>`)).toEqual({ full: 0, capped: 1, orphans: 0 });
    expect(countFrameClasses(`<main className={cn("page", cn("page--full", y))}>`)).toEqual({ full: 1, capped: 0, orphans: 0 });
    expect(countFrameClasses(`<main className={cn("grid", "page--full")}>`)).toEqual({ full: 0, capped: 0, orphans: 1 });
    // A multi-line call in a real-file shape.
    expect(countFrameClasses(`<main\n  className={cn(\n    "page",\n    { x: y },\n  )}\n>`)).toEqual({ full: 0, capped: 1, orphans: 0 });
  });

  it("(c) fail on an unlisted file, a count mismatch, an orphan and a stale entry", () => {
    const expected = { "a.tsx": { full: 1, capped: 0 } };
    expect(diffFrameManifest({ "a.tsx": { full: 1, capped: 0, orphans: 0 } }, expected)).toEqual([]);
    expect(diffFrameManifest({ "a.tsx": { full: 1, capped: 0, orphans: 0 }, "b.tsx": { full: 0, capped: 1, orphans: 0 } }, expected)).not.toEqual([]);
    expect(diffFrameManifest({ "a.tsx": { full: 0, capped: 1, orphans: 0 } }, expected)).not.toEqual([]);
    expect(diffFrameManifest({ "a.tsx": { full: 1, capped: 0, orphans: 1 } }, expected)).not.toEqual([]);
    expect(diffFrameManifest({}, expected)).not.toEqual([]);
  });
});

describe("page frame (real files)", () => {
  it("(a) --container-page is defined and .page reads it", () => {
    expect(findContainerTokenErrors(readFileSync(join(stylesDir, "tokens/spacing.css"), "utf8"))).toEqual([]);
    expect(findPageCapErrors(readFileSync(join(stylesDir, "app.css"), "utf8"))).toEqual([]);
  });

  it("(b) .page--full and its ≤720 override are pinned exactly", () => {
    expect(findPageFullErrors(readFileSync(join(stylesDir, "app.css"), "utf8"))).toEqual([]);
  });

  it("(c) the full/capped split matches the manifest", () => {
    const actual: Record<string, FrameCounts & { orphans: number }> = {};
    for (const path of listSourceTsx(srcDir)) {
      actual[relative(srcDir, path).split(sep).join("/")] = countFrameClasses(readFileSync(path, "utf8"));
    }
    expect(Object.keys(actual).length).toBeGreaterThan(50);
    expect(diffFrameManifest(actual, FRAME_MANIFEST)).toEqual([]);
  });
});
