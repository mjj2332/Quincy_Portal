import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #500: `app.css` is imported OUTSIDE any `@layer`, so every rule in it beats every Tailwind utility (`@layer utilities`) and every
 * variant of one. A bare `.sr-only` there silently defeated `group-hover:not-sr-only` (the whiteboard History row's Restore action was
 * never visible). A bare rule named after a Tailwind utility is never needed -- the utility exists -- and is always a trap.
 */
const UTILITIES = ["sr-only", "not-sr-only", "hidden", "block", "inline", "inline-block", "flex", "inline-flex", "grid", "invisible", "visible", "static", "relative", "absolute", "fixed", "sticky", "truncate", "contents"];

describe("guard: unlayered CSS never redefines a Tailwind utility (#500)", () => {
  const css = readFileSync(resolve(__dirname, "./app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("app.css has no rule whose selector is a bare Tailwind utility class", () => {
    const offenders = UTILITIES.filter((name) => new RegExp(`(^|[{},;\\s])\\.${name.replace("-", "\\-")}\\s*[,{]`).test(css));
    expect(offenders, "an unlayered `.name {}` beats `group-hover:name` and every other variant; delete it, Tailwind generates the utility").toEqual([]);
  });
});
