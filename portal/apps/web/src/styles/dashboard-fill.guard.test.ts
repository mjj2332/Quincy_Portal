/**
 * #363 -- the Dashboard fills the viewport and scrolls inside itself. Three mechanical guards:
 *
 *   (a) the five `page--fill` rules exist in `app.css`, top-level (outside any `@layer`/`@media`)
 *       with exactly the declared declarations. They must be unlayered: `.app`'s min-height, the
 *       vendored `min-h-svh` and `.page`'s padding all beat a Tailwind utility.
 *   (b) exactly one source file uses `page--fill` (`screens/Dashboard.tsx`), always together with
 *       `page` and `page--full`.
 *   (c) no fixed or viewport-offset height remains on the Gantt / Calendar body, and the
 *       Dashboard's old fixed loading floor is gone.
 *
 * Each detector is a pure function over injected text, proven against planted fixtures that must
 * fail ("a grep gate that cannot fail is not a gate", docs/lessons.md).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const stylesDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(stylesDir, "..");

// ---------------------------------------------------------------------------------------------
// CSS parsing -- copied from page-frame.guard.test.ts; importing a test module re-registers its tests
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

function parseCssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let nextBlockId = 1;
  const walk = (text: string, ancestors: string[], blockId: number) => {
    let i = 0;
    let preludeStart = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === ";") {
        preludeStart = i + 1;
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

function sameDeclarations(actual: Declaration[], expected: Declaration[]): boolean {
  return actual.length === expected.length && expected.every(([p, v], k) => actual[k]?.[0] === p && actual[k]?.[1] === v);
}

// ---------------------------------------------------------------------------------------------
// (a) the fill rules
// ---------------------------------------------------------------------------------------------

const FILL_RULES: Array<[selector: string, declarations: Declaration[]]> = [
  [".app:has(.page--fill)", [["height", "100dvh"], ["min-height", "0"]]],
  [".app:has(.page--fill) .app__shell", [["min-height", "0"]]],
  [".app:has(.page--fill) .shell-header", [["flex-shrink", "0"]]],
  [".page--fill", [["display", "flex"], ["flex-direction", "column"], ["flex", "1 1 0"], ["min-height", "0"]]],
  [".page.page--fill", [["padding-bottom", "0"]]],
];

export function findFillRuleErrors(css: string): string[] {
  const errors: string[] = [];
  const rules = parseCssRules(css);
  for (const [selector, expected] of FILL_RULES) {
    const matches = rules.filter((rule) => rule.selector === selector);
    if (matches.length !== 1) {
      errors.push(`${selector}: expected exactly one rule, found ${matches.length}.`);
      continue;
    }
    const rule = matches[0]!;
    if (rule.ancestors.length !== 0) errors.push(`${selector}: must be top-level and unlayered, found inside ${rule.ancestors.join(" > ")}.`);
    if (!sameDeclarations(rule.declarations, expected)) {
      errors.push(`${selector}: declarations must be exactly ${expected.map(([p, v]) => `${p}: ${v}`).join("; ")}.`);
    }
  }
  return errors;
}

const GOOD_FILL_CSS = `
.app:has(.page--fill) { height: 100dvh; min-height: 0; }
.app:has(.page--fill) .app__shell { min-height: 0; }
.app:has(.page--fill) .shell-header { flex-shrink: 0; }
.page--fill { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; }
.page.page--fill { padding-bottom: 0; }
`;

// ---------------------------------------------------------------------------------------------
// (b) one user
// ---------------------------------------------------------------------------------------------

const CLASS_NAME_LITERAL = /\bclassName\s*=\s*(?:\{\s*)?(["'`])((?:(?!\1)[\s\S])*)\1/g;
const CONST_LITERAL = /\bconst\s+[A-Za-z_$][\w$]*\s*=\s*(["'`])((?:(?!\1)[\s\S])*)\1/g;
const CLASS_NAME_EXPRESSION = /\bclassName\s*=\s*\{/g;
const CLASS_MERGE_CALL = /\b(?:cn|clsx|twMerge)\s*\(/g;
const STRING_LITERAL = /(["'`])((?:(?!\1)[\s\S])*)\1/g;

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

function literalTokens(quote: string | undefined, body: string): string[] {
  return (quote === "`" ? body.replace(/\$\{[^}]*\}/g, " ") : body).split(/\s+/);
}

function tokenSets(source: string): string[][] {
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

/** `files` maps a src-relative path to its source. Returns the errors for `page--fill` usage. */
export function findFillUserErrors(files: Record<string, string>): string[] {
  const errors: string[] = [];
  const users: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    let uses = false;
    for (const tokens of tokenSets(source)) {
      if (!tokens.includes("page--fill")) continue;
      uses = true;
      if (!tokens.includes("page") || !tokens.includes("page--full")) {
        errors.push(`${file}: a \`page--fill\` literal must also carry \`page\` and \`page--full\`.`);
      }
    }
    if (uses) users.push(file);
  }
  if (users.length !== 1 || users[0] !== "screens/Dashboard.tsx") {
    errors.push(`exactly screens/Dashboard.tsx may use \`page--fill\`; found [${users.join(", ")}].`);
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// (c) no fixed body height
// ---------------------------------------------------------------------------------------------

const FIXED_HEIGHT_ALLOWLIST = new Set(["min-h-[44px]"]);

export function findFixedHeights(source: string): string[] {
  const found: string[] = [];
  for (const [match] of source.matchAll(/(?<![\w-])(?:min-|max-)?h-\[[^\]]*\]/g)) {
    if (/\d(?:px|rem|vh|svh|dvh|lvh)/.test(match) && !FIXED_HEIGHT_ALLOWLIST.has(match)) found.push(match);
  }
  for (const [match] of source.matchAll(/calc\(100[sdl]?vh/g)) found.push(match);
  return found;
}

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
// Fixtures + real files
// ---------------------------------------------------------------------------------------------

describe("dashboard fill rules (a)", () => {
  it("accepts the good block", () => {
    expect(findFillRuleErrors(GOOD_FILL_CSS)).toEqual([]);
  });

  it("rejects planted regressions", () => {
    const planted = [
      `@layer components {${GOOD_FILL_CSS}}`,
      `@media (max-width: 720px) {${GOOD_FILL_CSS}}`,
      GOOD_FILL_CSS.replace(".page.page--fill { padding-bottom: 0; }", ".page.page--fill { }"),
      GOOD_FILL_CSS.replace("height: 100dvh; min-height: 0;", "height: 100dvh;"),
      "",
    ];
    for (const css of planted) expect(findFillRuleErrors(css)).not.toEqual([]);
  });

  it("holds in the real app.css", () => {
    expect(findFillRuleErrors(readFileSync(join(stylesDir, "app.css"), "utf8"))).toEqual([]);
  });
});

describe("page--fill has one user (b)", () => {
  const good = { "screens/Dashboard.tsx": `<main className="page page--full page--fill [overflow-x:clip]">` };

  it("accepts Dashboard alone", () => {
    expect(findFillUserErrors(good)).toEqual([]);
  });

  it("rejects planted regressions", () => {
    expect(findFillUserErrors({ ...good, "screens/Other.tsx": `<main className="page page--full page--fill">` })).not.toEqual([]);
    expect(findFillUserErrors({ "screens/Dashboard.tsx": `<main className="page--fill">` })).not.toEqual([]);
    expect(findFillUserErrors({ "screens/Dashboard.tsx": `<main className="page page--fill">` })).not.toEqual([]);
    expect(findFillUserErrors({})).not.toEqual([]);
  });

  it("holds across the real source", () => {
    const files: Record<string, string> = {};
    for (const path of listSourceTsx(srcDir)) files[relative(srcDir, path).split(sep).join("/")] = readFileSync(path, "utf8");
    expect(Object.keys(files).length).toBeGreaterThan(50);
    expect(findFillUserErrors(files)).toEqual([]);
  });
});

describe("no fixed body height (c)", () => {
  it("flags fixed and viewport-offset heights", () => {
    for (const bad of ["h-[36rem]", "h-[28rem]", "h-[480px]", "min-h-[480px]", "h-[min(760px,calc(100svh-220px))]", "max-h-[70vh]"]) {
      expect(findFixedHeights(`<div className="grid ${bad}" />`), bad).not.toEqual([]);
    }
  });

  it("leaves the tap target and token heights alone", () => {
    for (const ok of ["min-h-[44px]", "h-[var(--space-7)]", "min-h-0"]) {
      expect(findFixedHeights(`<div className="grid ${ok}" />`), ok).toEqual([]);
    }
  });

  it("holds for the real Gantt and Calendar", () => {
    for (const file of ["components/ProductionGantt.tsx", "components/ProductionEventCalendar.tsx"]) {
      expect(findFixedHeights(readFileSync(join(srcDir, file), "utf8")), file).toEqual([]);
    }
  });

  it("the Dashboard's fixed loading floor is gone", () => {
    const dashboard = readFileSync(join(srcDir, "screens/Dashboard.tsx"), "utf8");
    expect(dashboard).not.toContain("CALENDAR_STATE_BOX");
    expect(dashboard).not.toContain("min-h-[180px]");
  });
});
