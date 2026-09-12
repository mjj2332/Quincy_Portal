/**
 * Sidebar token bridge guard — #111, AC5 and AC6.
 *
 * ## The hole this fills
 *
 * `design-system-guards.test.ts`'s phantom-token guard scans **authored CSS**: it pairs every
 * `var(--x)` in a `.css` file against every `--x:` declaration in a `.css` file. A Tailwind colour
 * utility that arrives as a **TSX class name** is invisible to it. `tokens/reui.css`'s header says
 * so in as many words, and records that this is exactly how `--focus` was missed once already.
 *
 * The `--sidebar*` roles are the largest block of TSX-only consumers in the app, and they fail in
 * the quietest way available. A `bg-sidebar` with no `--color-sidebar` in `@theme inline` does not
 * error, does not warn, and does not render: Tailwind v4 generates the utility from the `@theme`
 * entry, so the class simply never exists and the element paints transparent. Nothing in the suite
 * would notice.
 *
 * So this guard reads the primitive's source and works **in both directions**:
 *
 *   1. every `--sidebar*` role the TSX consumes is declared in `tokens/reui.css`'s `:root`;
 *   2. every one of those also has a matching `--color-sidebar*` in `@theme inline`;
 *   3. every `--sidebar*` role declared in CSS is consumed by the TSX — no dead sidebar tokens,
 *      which is the rule `tokens/reui.css`'s header set when it refused to define these roles
 *      speculatively in the first place;
 *   4. nothing a sidebar role resolves through is undefined or cyclic;
 *   5. no sidebar role is declared inside a `[data-surface=…]` block (AC6).
 *
 * Direction 3 is why the ROLE COUNT is not written down anywhere. #111's AC5 asked for "all eight
 * `--sidebar*` roles"; the real number after trimming the vendor component is five, and the ticket
 * was reworded rather than the code padded. A hardcoded count would have to be edited by whoever
 * adds a role — which is precisely the moment a guard should be checking, not being updated.
 *
 * ## Shape
 *
 * Every detector is a pure function over injected text, never a function that reads the filesystem
 * itself. The real scan below passes today, so a scan that never fires is not evidence the
 * detector works — `docs/lessons.md`: "a grep gate that cannot fail is not a gate". Each detector
 * is therefore also exercised against planted fixtures that manufacture the violation.
 *
 * If this guard fires: bridge the role in `tokens/reui.css` (both the `:root` declaration and the
 * `@theme inline` entry), or stop consuming it in the primitive. Do not edit the guard, and do not
 * reach for the shadcn CLI — `components/reui/sidebar.tsx`'s header explains why that set is
 * trimmed by hand.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const stylesDir = dirname(fileURLToPath(import.meta.url));
const reuiCssPath = join(stylesDir, "tokens", "reui.css");
const primitivePath = join(stylesDir, "..", "components", "reui", "sidebar.tsx");

// ---------------------------------------------------------------------------
// Detectors — pure functions over text
// ---------------------------------------------------------------------------

/**
 * Every `--sidebar*` role a TSX source consumes.
 *
 * Two ways a role can be reached from TSX. A Tailwind colour utility
 * (`bg-sidebar`, `text-sidebar-accent-foreground`, `border-sidebar-border`) resolves through the
 * `@theme inline` entry; a direct `var(--sidebar-…)` resolves through the `:root` declaration. Both
 * count, and both need the same bridge.
 *
 * The utility-prefix list is closed on purpose rather than matching "any word before `-sidebar`":
 * an open match would read a bare `sidebar-menu-button` data-slot value as a role. Opacity
 * modifiers (`text-sidebar-foreground/70`) fall away because `/` is not in the suffix class.
 */
const UTILITY_PREFIXES = [
  "bg",
  "text",
  "border",
  "ring",
  "fill",
  "stroke",
  "outline",
  "divide",
  "shadow",
  "from",
  "via",
  "to",
  "caret",
  "accent",
  "decoration",
  "placeholder",
];

/**
 * Strip comments before extracting.
 *
 * Found by this guard failing on its first run. `components/reui/sidebar.tsx`'s header explains at
 * length why `ring-sidebar-ring` was REMOVED — and the extractor read that sentence as a
 * consumption and demanded the role be bridged. Documentation must be able to name a token it is
 * telling you not to use.
 *
 * `//` is only treated as a line comment when it is not preceded by `:`, so a `https://` inside a
 * string literal survives.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function sidebarRolesConsumedBy(source: string): Set<string> {
  const roles = new Set<string>();
  const tsx = stripComments(source);

  const utility = new RegExp(
    `\\b(?:${UTILITY_PREFIXES.join("|")})-sidebar(-[a-z]+(?:-[a-z]+)*)?(?=$|[^a-zA-Z0-9-])`,
    "g",
  );
  for (const match of tsx.matchAll(utility)) roles.add(`--sidebar${match[1] ?? ""}`);

  for (const match of tsx.matchAll(/var\(\s*(--sidebar(?:-[a-z]+)*)\s*[),]/g)) {
    if (match[1]) roles.add(match[1]);
  }

  return roles;
}

/** Every `--sidebar*` custom property declared at the top level of a CSS source, and its value. */
export function sidebarRolesDeclaredIn(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of css.matchAll(/(--sidebar(?:-[a-z]+)*)\s*:\s*([^;]+);/g)) {
    if (match[1] && match[2]) out.set(match[1], match[2].trim());
  }
  return out;
}

/** Every `--color-sidebar*` alias declared inside an `@theme inline` block. */
export function themeSidebarAliasesIn(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of css.matchAll(/@theme\s+inline\s*\{([\s\S]*?)\n\}/g)) {
    const body = block[1];
    if (!body) continue;
    for (const match of body.matchAll(/(--color-sidebar(?:-[a-z]+)*)\s*:\s*([^;]+);/g)) {
      if (match[1] && match[2]) out.set(match[1], match[2].trim());
    }
  }
  return out;
}

/**
 * Sidebar roles declared inside a `[data-surface=…]` scope — AC6.
 *
 * `tokens/inverse.css` re-scopes the shadcn ROLE layer for the dark stage and restores it for a
 * nested light panel. A sidebar role declared in either block would make the rail's paint depend on
 * where it sits in the tree. The bridge reads Quincy's semantic aliases (`--bg-surface`,
 * `--text-primary`) rather than that role layer for exactly this reason, and this detector is what
 * stops a later edit from quietly reintroducing the dependency.
 *
 * Brace-counted rather than regex-matched on the block body: these blocks nest.
 */
export function sidebarRolesInSurfaceScopes(css: string): { selector: string; role: string }[] {
  const found: { selector: string; role: string }[] = [];

  for (const opener of css.matchAll(/([^{};]*\[data-surface=[^\]]*\][^{};]*)\{/g)) {
    const selector = (opener[1] ?? "").trim().replace(/\s+/g, " ");
    let depth = 1;
    let index = (opener.index ?? 0) + opener[0].length;
    const start = index;
    while (index < css.length && depth > 0) {
      const char = css[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    const body = css.slice(start, index - 1);
    for (const role of sidebarRolesDeclaredIn(body).keys()) found.push({ selector, role });
  }

  return found;
}

/**
 * Resolve a custom property through every `var()` hop across the whole authored CSS, reporting the
 * first undefined reference or cycle it hits.
 *
 * A `var(--x, fallback)` only reaches its fallback when `--x` is undefined, so the reference is
 * what matters and the fallback is not followed.
 */
export function resolutionFailure(
  role: string,
  declarations: Map<string, string>,
): { role: string; reason: "undefined" | "cycle"; token: string } | null {
  const seen = new Set<string>();
  let frontier = [role];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const token of frontier) {
      if (seen.has(token)) return { role, reason: "cycle", token };
      seen.add(token);
      const value = declarations.get(token);
      if (value === undefined) return { role, reason: "undefined", token };
      for (const ref of value.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
        if (ref[1]) next.push(ref[1]);
      }
    }
    frontier = next;
  }

  return null;
}

/** Every custom property declared anywhere in a set of CSS sources. Last declaration wins. */
export function allDeclarations(sources: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const css of sources) {
    for (const match of css.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
      if (match[1] && match[2]) out.set(match[1], match[2].trim());
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The real scan
// ---------------------------------------------------------------------------

const cssSources = () => {
  const tokensDir = join(stylesDir, "tokens");
  const files = [
    ...readdirSync(stylesDir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => join(stylesDir, name)),
    ...readdirSync(tokensDir)
      .filter((name) => name.endsWith(".css"))
      .map((name) => join(tokensDir, name)),
  ];
  return files.map((file) => readFileSync(file, "utf8"));
};

describe("guard: the sidebar token bridge", () => {
  const primitive = readFileSync(primitivePath, "utf8");
  const reuiCss = readFileSync(reuiCssPath, "utf8");
  const consumed = sidebarRolesConsumedBy(primitive);
  const declared = sidebarRolesDeclaredIn(reuiCss);
  const aliases = themeSidebarAliasesIn(reuiCss);

  it("finds the roles the primitive consumes", () => {
    // Not an assertion about the count — an assertion that the extractor is not returning nothing,
    // which would make every check below pass vacuously.
    expect(consumed.size).toBeGreaterThan(0);
    expect([...consumed]).toContain("--sidebar");
  });

  it("declares every role the primitive consumes", () => {
    const missing = [...consumed].filter((role) => !declared.has(role)).sort();
    expect(missing, `bridge these in tokens/reui.css's :root — ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every consumed role a matching @theme inline alias", () => {
    const missing = [...consumed]
      .filter((role) => !aliases.has(role.replace(/^--/, "--color-")))
      .sort();
    expect(
      missing,
      `without a --color-* entry the utility is a silent no-op — ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("declares no sidebar role the primitive does not consume", () => {
    const dead = [...declared.keys()].filter((role) => !consumed.has(role)).sort();
    expect(dead, `dead sidebar tokens — delete them or consume them: ${dead.join(", ")}`).toEqual(
      [],
    );
  });

  it("has no @theme alias without its role, and none pointing at the wrong role", () => {
    const orphaned = [...aliases.keys()]
      .filter((alias) => !declared.has(alias.replace(/^--color-/, "--")))
      .sort();
    expect(orphaned).toEqual([]);

    for (const [alias, value] of aliases) {
      expect(value, `${alias} should read its own role`).toBe(
        `var(${alias.replace(/^--color-/, "--")})`,
      );
    }
  });

  it("resolves every sidebar role to a real value, with no undefined hop and no cycle", () => {
    const declarations = allDeclarations(cssSources());
    const failures = [...consumed]
      .map((role) => resolutionFailure(role, declarations))
      .filter((failure) => failure !== null);
    expect(failures).toEqual([]);
  });

  it("declares no sidebar role inside a [data-surface] scope (AC6)", () => {
    const scoped = cssSources().flatMap((css) => sidebarRolesInSurfaceScopes(css));
    expect(
      scoped,
      "the rail must not repaint on an inverse surface — read Quincy's semantic aliases, " +
        "not the shadcn role layer",
    ).toEqual([]);
  });

  it("reads the semantic alias layer, not the inverse-scoped role layer", () => {
    // The positive form of the check above: inverse.css re-scopes these role names, so a sidebar
    // role whose value reaches one of them would flip on the dark stage even though no sidebar
    // role is itself declared in an inverse block.
    const inverseCss = readFileSync(join(stylesDir, "tokens", "inverse.css"), "utf8");
    const rescoped = new Set<string>();
    for (const match of inverseCss.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) {
      if (match[1]) rescoped.add(match[1]);
    }

    const declarations = allDeclarations(cssSources());
    const offenders: string[] = [];
    for (const role of consumed) {
      const seen = new Set<string>();
      let frontier = [role];
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const token of frontier) {
          if (seen.has(token)) continue;
          seen.add(token);
          if (token !== role && rescoped.has(token)) offenders.push(`${role} -> ${token}`);
          for (const ref of (declarations.get(token) ?? "").matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
            if (ref[1]) next.push(ref[1]);
          }
        }
        frontier = next;
      }
    }

    expect(offenders.sort()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-test — every detector above, against a planted violation
// ---------------------------------------------------------------------------

describe("guard self-test: the detectors catch a planted violation", () => {
  it("extracts roles from utilities, opacity modifiers and direct var() alike", () => {
    const roles = sidebarRolesConsumedBy(`
      className="bg-sidebar text-sidebar-foreground/70 border-sidebar-border"
      style={{ width: "var(--sidebar-width)" }}
      data-slot="sidebar-menu-button"
    `);
    expect([...roles].sort()).toEqual([
      "--sidebar",
      "--sidebar-border",
      "--sidebar-foreground",
      "--sidebar-width",
    ]);
  });

  it("does not read a role named in a comment as a consumption", () => {
    // The bug this guard found in itself. Both comment forms, and a URL that must survive.
    const roles = sidebarRolesConsumedBy(`
      /* ring-sidebar-ring is REMOVED — see https://example.test/x//y */
      // bg-sidebar-primary is read by nothing
      className="bg-sidebar"
    `);
    expect([...roles]).toEqual(["--sidebar"]);
  });

  it("does not read a data-slot value or a component name as a role", () => {
    const roles = sidebarRolesConsumedBy(`
      data-slot="sidebar-group-label"
      function SidebarMenuSubButton() {}
      const sidebarMenuButtonVariants = cva("peer/menu-button")
    `);
    expect([...roles]).toEqual([]);
  });

  it("reports a consumed role that is not declared", () => {
    const consumed = sidebarRolesConsumedBy(`className="bg-sidebar ring-sidebar-ring"`);
    const declared = sidebarRolesDeclaredIn(`:root { --sidebar: var(--bg-surface); }`);
    expect([...consumed].filter((role) => !declared.has(role))).toEqual(["--sidebar-ring"]);
  });

  it("reports a declared role nothing consumes", () => {
    const consumed = sidebarRolesConsumedBy(`className="bg-sidebar"`);
    const declared = sidebarRolesDeclaredIn(
      `:root { --sidebar: var(--bg-surface); --sidebar-primary: var(--accent); }`,
    );
    expect([...declared.keys()].filter((role) => !consumed.has(role))).toEqual([
      "--sidebar-primary",
    ]);
  });

  it("reports a role with no @theme inline alias", () => {
    const aliases = themeSidebarAliasesIn(
      `@theme inline {\n  --color-sidebar: var(--sidebar);\n}`,
    );
    expect(aliases.has("--color-sidebar")).toBe(true);
    expect(aliases.has("--color-sidebar-accent")).toBe(false);
  });

  it("ignores a --color-sidebar* declaration that is not inside @theme inline", () => {
    expect(themeSidebarAliasesIn(`:root { --color-sidebar: var(--sidebar); }`).size).toBe(0);
  });

  it("reports an undefined hop", () => {
    const failure = resolutionFailure(
      "--sidebar",
      allDeclarations([`:root { --sidebar: var(--bg-surface); }`]),
    );
    expect(failure).toEqual({ role: "--sidebar", reason: "undefined", token: "--bg-surface" });
  });

  it("reports a cycle rather than hanging", () => {
    const failure = resolutionFailure(
      "--sidebar",
      allDeclarations([`:root { --sidebar: var(--a); --a: var(--sidebar); }`]),
    );
    expect(failure?.reason).toBe("cycle");
  });

  it("reports a sidebar role declared inside an inverse block", () => {
    expect(
      sidebarRolesInSurfaceScopes(`
        [data-surface="inverse"] {
          --card: var(--ink-800);
          --sidebar: var(--ink-900);
        }
      `),
    ).toEqual([{ selector: '[data-surface="inverse"]', role: "--sidebar" }]);
  });

  it("counts braces rather than stopping at the first close", () => {
    const found = sidebarRolesInSurfaceScopes(`
      [data-surface="inverse"] {
        .nested { color: red; }
        --sidebar-border: var(--greige-500);
      }
      :root { --sidebar: var(--bg-surface); }
    `);
    expect(found).toEqual([
      { selector: '[data-surface="inverse"]', role: "--sidebar-border" },
    ]);
  });
});
