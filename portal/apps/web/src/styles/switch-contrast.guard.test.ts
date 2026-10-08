/**
 * Guard (#724): the Switch's off state must meet WCAG 1.4.11 (3:1 for UI components) on both the
 * default and the inverse surface. The off track reads `--control-off` (not the shared `--input`,
 * a 1.6:1 hairline), and the thumb reads `--background`. Ratios are computed from the resolved hex
 * values in the token files, with real relative-luminance maths.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const colors = read("./tokens/colors.css");
const tailwind = read("./tokens/tailwind.css");
const inverse = read("./tokens/inverse.css");
const switchSource = read("../components/reui/switch.tsx");

/** The body of the first rule whose selector is exactly `selector`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  return css.slice(start, css.indexOf("}", start));
}

function decl(body: string, prop: string): string {
  const m = body.match(new RegExp(`(?:^|[\\s;{])${prop}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`no ${prop} declaration`);
  return (m[1] ?? "").replace(/\/\*.*?\*\//g, "").trim();
}

/** Resolve `var(--x)` chains through the given scopes (first match wins) down to a hex colour. */
function resolve(value: string, scopes: string[]): string {
  let v = value;
  for (let i = 0; i < 12; i += 1) {
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    const ref = v.match(/^var\((--[\w-]+)\)$/);
    const name = ref?.[1];
    if (!name) throw new Error(`cannot resolve ${value} (stuck at ${v})`);
    let next: string | undefined;
    for (const scope of scopes) {
      try {
        next = decl(scope, name);
        break;
      } catch {
        /* try the next scope */
      }
    }
    if (next === undefined) throw new Error(`${name} is not defined`);
    v = next;
  }
  throw new Error(`reference loop resolving ${value}`);
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const rootColors = block(colors, ":root");
const rootRoles = block(tailwind, ":root");
const inverseRoles = block(inverse, '[data-surface="inverse"]');
const defaultRoles = block(inverse, '[data-surface="default"]');

const surfaces = {
  default: [defaultRoles, rootRoles, rootColors],
  inverse: [inverseRoles, rootRoles, rootColors],
  // the :root scope, with no data-surface ancestor
  root: [rootRoles, rootColors],
} as const;

describe("Switch off-state contrast (#724, WCAG 1.4.11)", () => {
  it("the switch reads --control-off, not the shared --input", () => {
    expect(switchSource).toContain("data-unchecked:bg-control-off");
    expect(switchSource).not.toContain("data-unchecked:bg-input");
    expect(tailwind).toMatch(/--color-control-off:\s*var\(--control-off\)/);
  });

  for (const [name, scopes] of Object.entries(surfaces)) {
    describe(`${name} surface`, () => {
      const hex = (role: string) => resolve(`var(${role})`, [...scopes]);
      const background = () => hex("--background");
      const off = () => hex("--control-off");

      it("off track vs background is at least 3:1", () => {
        expect(contrast(off(), background())).toBeGreaterThanOrEqual(3);
      });
      it("thumb (--background) vs off track is at least 3:1", () => {
        expect(contrast(background(), off())).toBeGreaterThanOrEqual(3);
      });
      it("checked track (--primary) vs background is at least 3:1", () => {
        expect(contrast(hex("--primary"), background())).toBeGreaterThanOrEqual(
          3,
        );
      });
    });
  }

  it("the inverse and default blocks both declare --control-off", () => {
    expect(inverseRoles).toMatch(/--control-off:/);
    expect(defaultRoles).toMatch(/--control-off:/);
  });
});
