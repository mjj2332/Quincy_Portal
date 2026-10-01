/**
 * Frame token bridge guard — #420, ADR 0014.
 *
 * `components/reui/frame.tsx` reads `--frame-*` custom properties for radius, panel radius,
 * border, panel border, panel background and gap. Quincy's token set has no such names, so
 * `tokens/reui.css` bridges them (`--frame-radius: var(--radius-card)` …). A role the TSX reads but
 * the bridge lacks resolves to nothing: the frame silently loses its border, background or gap and
 * no authored-CSS guard sees it (the same hole `sidebar-token-bridge.guard.test.ts` closes).
 *
 * The six roles ADR 0014 names are required in reui.css's top-level `:root` unconditionally; any
 * further role frame.tsx consumes without declaring itself (base class list or `spacing` variant)
 * is derived and required too. frame.tsx may not declare a bridged role inline anywhere, except the
 * allow-listed re-points (`dense`, `inverse`). Roles the cva
 * declares inline (`--frame-px`, `--frame-panel-px-base`, …) are the primitive's own structure and
 * need no bridge. Variants may still re-point a bridged role (`dense`, `inverse`).
 *
 * Detectors are pure functions over text and are exercised against planted fixtures
 * (lessons.md: "a grep gate that cannot fail is not a gate").
 *
 * If this fires: bridge the role in `tokens/reui.css`'s :root, or stop consuming it. Do not edit
 * the guard, and do not declare it inline in frame.tsx — that would shadow the bridge.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const stylesDir = dirname(fileURLToPath(import.meta.url));
const framePath = join(stylesDir, "..", "components", "reui", "frame.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every `--frame-*` role the source reads: `var(--frame-x)`, or Tailwind's `utility-(--frame-x)`. */
export function frameRolesConsumed(source: string): Set<string> {
  const out = new Set<string>();
  const tsx = stripComments(source);
  for (const m of tsx.matchAll(/(?:var\(|-\()\s*(--frame-[a-z0-9-]+)/g)) if (m[1]) out.add(m[1]);
  return out;
}

/**
 * Roles the primitive always sets itself: declared inline as `[--frame-x:…]` in the base class
 * list, or in the `spacing` variant (every spacing option declares the `-base` roles, and
 * `spacing` always has a default). Other variants (`dense`, `inverse`) only OVERRIDE a bridged
 * role, so a declaration there does not make the role self-declared.
 */
export function frameRolesDeclaredInBase(source: string): Set<string> {
  const tsx = stripComments(source);
  const cut = tsx.indexOf("variants:");
  const base = cut === -1 ? tsx : tsx.slice(0, cut);
  const spacingStart = tsx.indexOf("spacing: {", cut === -1 ? 0 : cut);
  const spacingEnd = spacingStart === -1 ? -1 : tsx.indexOf("stacked:", spacingStart);
  const spacing = spacingStart === -1 || spacingEnd === -1 ? "" : tsx.slice(spacingStart, spacingEnd);
  const out = new Set<string>();
  for (const m of `${base}\n${spacing}`.matchAll(/\[\s*(--frame-[a-z0-9-]+)\s*:/g)) if (m[1]) out.add(m[1]);
  return out;
}

/**
 * The roles the Quincy bridge OWNS, required in reui.css `:root` regardless of what frame.tsx
 * declares or consumes. Closed on purpose: ADR 0014 names them. Removing one from the bridge and
 * declaring it inline in the primitive used to pass every check.
 */
export const BRIDGED_ROLES = [
  "--frame-radius",
  "--frame-panel-radius",
  "--frame-gap",
  "--frame-border-color",
  "--frame-panel-border-color",
  "--frame-panel-bg",
] as const;

/** Roles the bridge must supply: the fixed owned set plus anything else frame.tsx consumes unaided. */
export function frameRolesNeedingBridge(source: string): string[] {
  const own = frameRolesDeclaredInBase(source);
  const derived = [...frameRolesConsumed(source)].filter((r) => !own.has(r));
  return [...new Set([...BRIDGED_ROLES, ...derived])].sort();
}

/** Every inline `[--frame-x:value]` declaration anywhere in the (comment-stripped) source. */
export function inlineFrameDeclarations(source: string): { role: string; value: string }[] {
  const out: { role: string; value: string }[] = [];
  for (const m of stripComments(source).matchAll(/\[\s*(--frame-[a-z0-9-]+)\s*:([^\]]*)\]/g)) {
    if (m[1]) out.push({ role: m[1], value: (m[2] ?? "").trim() });
  }
  return out;
}

/**
 * The only inline declarations of a bridged role that are allowed: re-points to another token,
 * never a value. Keyed `role|value` (Tailwind arbitrary-value spelling, `_` for space).
 */
export const ALLOWED_INLINE_REPOINTS = new Set([
  "--frame-panel-radius|var(--frame-radius)", // dense: panels sit flush at the frame's own radius
  "--frame-panel-bg|color-mix(in_oklch,var(--color-muted)_40%,transparent)", // inverse
]);

/** Any literal: a number, a length, a hex or a colour function other than color-mix of var(). */
const LITERAL = /(?:^|[^a-z0-9-])-?\d|#[0-9a-f]{3}|\b(?:oklch|oklab|rgb|rgba|hsl|hwb|lab|lch)\(/i;

/** Inline declarations of a bridged role that are not an allow-listed re-point. Whole file. */
export function inlineBridgeViolations(source: string): string[] {
  const bridged = new Set<string>(BRIDGED_ROLES);
  return inlineFrameDeclarations(source)
    .filter(({ role, value }) => bridged.has(role) && !ALLOWED_INLINE_REPOINTS.has(`${role}|${value}`))
    .map(({ role, value }) => `${role}: ${value}${LITERAL.test(value) ? " (literal)" : ""}`);
}

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Declarations made directly in a TOP-LEVEL `:root { }` block: the selector must be exactly
 * `:root` at brace depth 0, and only the block's own declarations count (nested rules are
 * skipped). A declaration inside `@media`, `@supports`, `@layer`, `.x`, `[data-surface]` … does
 * not apply document-wide, so it must not satisfy the bridge or any hop it resolves through.
 */
export function topLevelRootDeclarations(css: string): Map<string, string> {
  const text = stripCssComments(css);
  const out = new Map<string, string>();
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = -1; // start of the current top-level :root body, -1 when not inside one
  let own = ""; // the :root block's own text, nested rules cut out
  let ownFrom = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth === 0 && text.slice(selectorStart, i).trim() === ":root") {
        bodyStart = i + 1;
        ownFrom = i + 1;
        own = "";
      } else if (depth === 1 && bodyStart !== -1) {
        // a nested rule opens inside :root: keep the text before its selector, drop the rule
        own += text.slice(ownFrom, i).replace(/[^;]*$/, "");
      }
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        if (bodyStart !== -1) {
          own += text.slice(ownFrom, i);
          for (const m of own.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
            if (m[1] && m[2]) out.set(m[1], m[2].trim());
          }
          bodyStart = -1;
        }
        selectorStart = i + 1;
      } else if (depth === 1 && bodyStart !== -1) {
        ownFrom = i + 1; // nested rule closed; resume own text
      }
    } else if (c === ";" && depth === 0) {
      selectorStart = i + 1; // e.g. `@import …;`
    }
  }
  return out;
}

export function allDeclarations(sources: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const css of sources) for (const [k, v] of topLevelRootDeclarations(css)) out.set(k, v);
  return out;
}

/** Follow every `var()` hop; report an undefined reference or a cycle. */
export function resolutionFailure(role: string, decls: Map<string, string>) {
  const seen = new Set<string>();
  let frontier = [role];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const token of frontier) {
      if (seen.has(token)) return { role, reason: "cycle", token };
      seen.add(token);
      const value = decls.get(token);
      if (value === undefined) return { role, reason: "undefined", token };
      for (const ref of value.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) if (ref[1]) next.push(ref[1]);
    }
    frontier = next;
  }
  return null;
}

/** A bridge value must be a bare `var(--token)`: no literal length, hex or colour function. */
export const isBareVarReference = (value: string) => /^var\(\s*--[A-Za-z0-9-]+\s*\)$/.test(value);

const cssSources = () => {
  const tokensDir = join(stylesDir, "tokens");
  return [
    ...readdirSync(stylesDir).filter((n) => n.endsWith(".css")).map((n) => join(stylesDir, n)),
    ...readdirSync(tokensDir).filter((n) => n.endsWith(".css")).map((n) => join(tokensDir, n)),
  ].map((f) => readFileSync(f, "utf8"));
};

describe("detectors (planted fixtures)", () => {
  const tsx = `
    // var(--frame-commented) is documentation
    const v = cva(["gap-(--frame-gap) [--frame-px:--spacing(3)] px-(--frame-px)",
      "[--frame-radius:var(--radius-xl)]"], { variants: { dense: { true: "[--frame-panel-bg:red] bg-(--frame-panel-bg)" } } })
    const p = "rounded-(--frame-panel-radius) border-(--frame-panel-border-color)"`;
  it("derives consumed and self-declared roles", () => {
    expect([...frameRolesConsumed(tsx)].sort()).toEqual([
      "--frame-gap", "--frame-panel-bg", "--frame-panel-border-color", "--frame-panel-radius", "--frame-px",
    ]);
    expect([...frameRolesDeclaredInBase(tsx)].sort()).toEqual(["--frame-px", "--frame-radius"]);
  });

  it("requires the owned roles even when the source declares or omits them (hole 1)", () => {
    // frame.tsx that declares --frame-gap itself and never reads half the roles: all six still needed
    const needed = frameRolesNeedingBridge('const c = "[--frame-gap:99px] gap-(--frame-gap)"');
    for (const role of BRIDGED_ROLES) expect(needed).toContain(role);
  });

  it("flags an inline declaration of a bridged role in the base, a variant or FramePanel (holes 1+2)", () => {
    const base = 'cva(["[--frame-gap:99px]"], { variants: {} })';
    const variant = 'cva([], { variants: { dense: { true: "[--frame-border-color:#fff]" } } })';
    const panel = 'function FramePanel(){ return <div className="[--frame-panel-bg:oklch(0.9_0_0)]" /> }';
    expect(inlineBridgeViolations(base)).toEqual(["--frame-gap: 99px (literal)"]);
    expect(inlineBridgeViolations(variant)).toEqual(["--frame-border-color: #fff (literal)"]);
    expect(inlineBridgeViolations(panel)).toEqual(["--frame-panel-bg: oklch(0.9_0_0) (literal)"]);
    // a re-point to some OTHER token is still not allow-listed
    expect(inlineBridgeViolations('"[--frame-panel-radius:var(--radius-lg)]"')).toEqual([
      "--frame-panel-radius: var(--radius-lg)",
    ]);
    // the two real re-points, and unbridged structure roles, pass
    expect(
      inlineBridgeViolations(
        '"[--frame-panel-radius:var(--frame-radius)] [--frame-panel-bg:color-mix(in_oklch,var(--color-muted)_40%,transparent)] [--frame-px:--spacing(3)]"',
      ),
    ).toEqual([]);
  });

  it("only counts a top-level :root declaration (hole 3)", () => {
    const css = [
      ".x { --a: 1; }",
      "@media (min-width: 1px) { :root { --b: 2; } }",
      "@supports (color: red) { :root { --c: 3; } }",
      "@layer base { :root { --d: 4; } }",
      ':root[data-theme="x"] { --e: 5; }',
      "@theme inline { --f: 6; }",
      ":root { --g: 7; @media (min-width: 1px) { --h: 8; } --i: 9; }",
      ":root { --j: 10; }",
    ].join("\n");
    expect([...topLevelRootDeclarations(css).keys()].sort()).toEqual(["--g", "--i", "--j"]);
    // a bridge hop declared only under @media does not resolve
    const decls = allDeclarations(["@media (x) { :root { --frame-gap: var(--space-1); --space-1: 4px; } }"]);
    expect(resolutionFailure("--frame-gap", decls)?.reason).toBe("undefined");
  });

  it("rejects literal bridge values and undefined hops", () => {
    expect(isBareVarReference("var(--space-1)")).toBe(true);
    for (const bad of ["3px", "#fff", "oklch(0.9 0 0)", "calc(var(--a) - 1px)", "0"]) {
      expect(isBareVarReference(bad)).toBe(false);
    }
    expect(resolutionFailure("--a", new Map([["--a", "var(--b)"]]))?.reason).toBe("undefined");
    expect(
      resolutionFailure("--a", new Map([["--a", "var(--b)"], ["--b", "var(--a)"]]))?.reason,
    ).toBe("cycle");
  });
});

describe("guard: the frame token bridge", () => {
  const source = readFileSync(framePath, "utf8");
  const reuiCss = readFileSync(join(stylesDir, "tokens", "reui.css"), "utf8");
  const needed = frameRolesNeedingBridge(source);
  const declared = new Map(
    [...topLevelRootDeclarations(reuiCss)].filter(([k]) => k.startsWith("--frame-")),
  );

  it("requires the six owned roles", () => {
    for (const role of BRIDGED_ROLES) expect(needed).toContain(role);
  });

  it("bridges every required role in reui.css's top-level :root", () => {
    const missing = needed.filter((r) => !declared.has(r));
    expect(missing, `bridge in tokens/reui.css :root — ${missing.join(", ")}`).toEqual([]);
  });

  it("declares no --frame-* role the primitive does not consume", () => {
    const consumed = frameRolesConsumed(source);
    const dead = [...declared.keys()].filter((r) => !consumed.has(r)).sort();
    expect(dead, `dead frame tokens — ${dead.join(", ")}`).toEqual([]);
  });

  it("never declares a bridged role inline anywhere in frame.tsx, bar the allow-listed re-points", () => {
    expect(
      inlineBridgeViolations(source),
      "an inline declaration shadows the bridge — bridge it in reui.css instead",
    ).toEqual([]);
  });

  it("bridges each role to a Quincy token, never a literal", () => {
    for (const role of needed) {
      const value = declared.get(role) ?? "";
      expect(isBareVarReference(value), `${role}: ${value} must be var(--quincy-token)`).toBe(true);
    }
  });

  it("resolves every bridged role through top-level :root tokens, no undefined hop or cycle", () => {
    const decls = allDeclarations(cssSources());
    const failures = needed.map((r) => resolutionFailure(r, decls)).filter((f) => f !== null);
    expect(failures).toEqual([]);
  });
});
