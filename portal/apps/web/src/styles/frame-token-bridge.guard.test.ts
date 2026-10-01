/**
 * Frame token bridge guard — #420, ADR 0014.
 *
 * `components/reui/frame.tsx` reads `--frame-*` custom properties for radius, panel radius,
 * border, panel border, panel background and gap. Quincy's token set has no such names, so
 * `tokens/reui.css` bridges them (`--frame-radius: var(--radius-card)` …). A role the TSX reads but
 * the bridge lacks resolves to nothing: the frame silently loses its border, background or gap and
 * no authored-CSS guard sees it (the same hole `sidebar-token-bridge.guard.test.ts` closes).
 *
 * The role list is DERIVED from the source, never hard-coded: a role is "bridged" when the TSX
 * consumes it and does not itself declare it (base class list or the `spacing` variant). Roles the cva
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

/** Roles the bridge must supply: consumed, and not self-declared by the primitive. */
export function frameRolesNeedingBridge(source: string): string[] {
  const own = frameRolesDeclaredInBase(source);
  return [...frameRolesConsumed(source)].filter((r) => !own.has(r)).sort();
}

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** `:root` blocks, brace-counted (they nest at-rules in this codebase). */
export function rootBlocksIn(css: string): string {
  const scrubbed = stripCssComments(css);
  const blocks: string[] = [];
  for (const opener of scrubbed.matchAll(/(^|[\s},])(:root)\s*\{/g)) {
    let depth = 1;
    let i = (opener.index ?? 0) + opener[0].length;
    const start = i;
    while (i < scrubbed.length && depth > 0) {
      if (scrubbed[i] === "{") depth += 1;
      else if (scrubbed[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push(scrubbed.slice(start, i - 1));
  }
  return blocks.join("\n");
}

export function frameRolesDeclaredIn(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of stripCssComments(css).matchAll(/(--frame-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (m[1] && m[2]) out.set(m[1], m[2].trim());
  }
  return out;
}

export function allDeclarations(sources: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const css of sources) {
    for (const m of stripCssComments(css).matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
      if (m[1] && m[2]) out.set(m[1], m[2].trim());
    }
  }
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
  it("derives consumed, self-declared and bridge-needing roles", () => {
    expect([...frameRolesConsumed(tsx)].sort()).toEqual([
      "--frame-gap", "--frame-panel-bg", "--frame-panel-border-color", "--frame-panel-radius", "--frame-px",
    ]);
    expect([...frameRolesDeclaredInBase(tsx)].sort()).toEqual(["--frame-px", "--frame-radius"]);
    // --frame-panel-bg is declared only inside a variant, so the base still needs the bridge
    expect(frameRolesNeedingBridge(tsx)).toEqual([
      "--frame-gap", "--frame-panel-bg", "--frame-panel-border-color", "--frame-panel-radius",
    ]);
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
  it("only counts :root declarations", () => {
    const css = ".x { --frame-gap: var(--a); } :root { --frame-radius: var(--b); }";
    expect([...frameRolesDeclaredIn(rootBlocksIn(css)).keys()]).toEqual(["--frame-radius"]);
  });
});

describe("guard: the frame token bridge", () => {
  const source = readFileSync(framePath, "utf8");
  const reuiCss = readFileSync(join(stylesDir, "tokens", "reui.css"), "utf8");
  const needed = frameRolesNeedingBridge(source);
  const declared = frameRolesDeclaredIn(rootBlocksIn(reuiCss));

  it("finds roles to bridge (the extractor is not returning nothing)", () => {
    expect(needed.length).toBeGreaterThan(0);
  });

  it("bridges every role frame.tsx consumes without declaring itself", () => {
    const missing = needed.filter((r) => !declared.has(r));
    expect(missing, `bridge in tokens/reui.css :root — ${missing.join(", ")}`).toEqual([]);
  });

  it("declares no --frame-* role the primitive does not consume", () => {
    const consumed = frameRolesConsumed(source);
    const dead = [...declared.keys()].filter((r) => !consumed.has(r)).sort();
    expect(dead, `dead frame tokens — ${dead.join(", ")}`).toEqual([]);
  });

  it("does not shadow a bridged role with an inline declaration in the base class list", () => {
    const own = frameRolesDeclaredInBase(source);
    const shadowed = [...declared.keys()].filter((r) => own.has(r)).sort();
    expect(shadowed, `frame.tsx declares these itself, defeating the bridge: ${shadowed}`).toEqual([]);
  });

  it("bridges each role to a Quincy token, never a literal", () => {
    for (const role of needed) {
      const value = declared.get(role) ?? "";
      expect(isBareVarReference(value), `${role}: ${value} must be var(--quincy-token)`).toBe(true);
    }
  });

  it("resolves every bridged role through defined tokens, no undefined hop or cycle", () => {
    const decls = allDeclarations(cssSources());
    const failures = needed.map((r) => resolutionFailure(r, decls)).filter((f) => f !== null);
    expect(failures).toEqual([]);
  });
});
