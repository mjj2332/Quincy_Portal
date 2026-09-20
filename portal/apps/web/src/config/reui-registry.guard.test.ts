/**
 * ReUI registry guard — the proxy URL is deliberate, not a mistake to "fix".
 *
 * `components.json` will carry a `@reui` entry under `registries` pointing at
 * `https://proxy.collectui.pro/api/r/reui/{style}/{name}.json`. ReUI's own documentation and its
 * MCP server both advertise a different canonical URL — `https://reui.io/r/{style}/{name}.json`
 * — for the same registry. The owner deliberately chose the proxy instead of the vendor's
 * documented URL (see the "ReUI component registry" section of the root `AGENTS.md`). An agent
 * that diffs this repo against ReUI's docs will read our URL as a defect and silently "correct"
 * it back to `reui.io`, quietly changing where component source is fetched from on every future
 * `shadcn add`. That correction must fail CI instead of shipping.
 *
 * This guard has no baseline and must never acquire one — unlike the design-system guards in
 * `styles/design-system-guards.test.ts`, there is no pre-existing instance of this defect to
 * grandfather. Any occurrence of the vendor URL is a fresh regression, full stop.
 *
 * As of this writing, `components.json` has no `@reui` entry yet (see issue #49) — only
 * `@fullcalendar`. Assertion 1 and 2 hold unconditionally today. Assertions 3 and 4 are written
 * to pass vacuously while `@reui` is absent, and to bite the moment it is added with the wrong
 * URL or an inlined license key.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// portal/apps/web/src/config/ -> portal/apps/web/components.json
const componentsJsonPath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "components.json");

const REUI_PROXY_URL = "https://proxy.collectui.pro/api/r/reui/{style}/{name}.json";

function rawText(): string {
  return readFileSync(componentsJsonPath, "utf8");
}

function parsed(): Record<string, unknown> {
  return JSON.parse(rawText()) as Record<string, unknown>;
}

describe("guard: components.json parses as valid JSON", () => {
  it("does not throw when parsed", () => {
    expect(() => parsed()).not.toThrow();
  });
});

describe("guard: the ReUI registry never points at reui.io's documented (non-proxy) URL", () => {
  it("contains no `reui.io/r/` anywhere in the raw file text", () => {
    const text = rawText();
    expect(
      text.includes("reui.io/r/"),
      [
        "components.json references `reui.io/r/`, ReUI's documented canonical registry URL.",
        "This repo deliberately routes the @reui registry through a proxy",
        `(${REUI_PROXY_URL}) instead — see the "ReUI component registry" section of the root`,
        "AGENTS.md. Do not 'correct' this back to reui.io; revert the change.",
      ].join("\n"),
    ).toBe(false);
  });
});

describe("guard: if the @reui registry entry exists, its url is exactly the proxy URL", () => {
  it("matches the proxy URL, or reports that the entry does not exist yet", () => {
    const registries = parsed().registries as Record<string, unknown> | undefined;
    const reui = registries?.["@reui"] as Record<string, unknown> | undefined;

    if (reui === undefined) {
      // Vacuously true today (issue #49 has not landed yet). Once the @reui entry is added,
      // this branch stops running and the assertion below starts enforcing the real URL.
      expect(reui, "@reui registry entry does not exist yet — guard is vacuous until issue #49 lands").toBeUndefined();
      return;
    }

    expect(reui.url, "registries[\"@reui\"].url must be exactly the proxy URL, not reui.io's documented URL").toBe(
      REUI_PROXY_URL,
    );
  });
});

describe("guard: styles/index.css stays an import manifest, so a CLI install cannot inject a palette", () => {
  it("contains only @layer and @import statements", () => {
    const indexCss = join(fileURLToPath(new URL(".", import.meta.url)), "..", "styles", "index.css");
    const offending = readFileSync(indexCss, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => line.length > 0)
      .filter(({ line }) => !/^@(layer|import)\b/.test(line));

    expect(
      offending.map(({ line, number }) => `${number}: ${line}`),
      [
        "styles/index.css must contain nothing but @layer and @import.",
        "",
        "`shadcn add` merges each registry item's cssVars and css blocks into the file named by",
        "`tailwind.css` in components.json — which is this file. Installing @reui/badge appended a",
        "`:root` block redefining --success/--info/--warning/--invert to ReUI's emerald, violet and",
        "yellow defaults. Because it landed AFTER the @import of tokens/reui.css at equal specificity,",
        "it silently overrode the entire Quincy token bridge: the brand would have shipped as a ReUI",
        "demo. That is not hypothetical — it is what happened, and this guard is the result.",
        "",
        "If this fires after an install: move the injected declarations into tokens/reui.css (mapping",
        "them onto Quincy tokens), and leave this file a manifest. Do not silence the guard.",
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("guard: installed components use this repo's cn helper, not the `cn` npm package", () => {
  it("has no `cn` dependency and no import of it in src/components/reui", () => {
    const webRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
    // Both manifests: this monorepo keeps runtime dependencies in the ROOT package.json, so
    // checking only apps/web would let the exact defect this guard exists for land one directory
    // up and pass. (Sol, diff review.)
    const manifests = [join(webRoot, "package.json"), join(webRoot, "..", "..", "package.json")];
    const declaredIn = manifests.filter((path) => {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return { ...pkg.dependencies, ...pkg.devDependencies }.cn !== undefined;
    });

    expect(
      declaredIn.length === 0 ? undefined : declaredIn.join(", "),
      [
        "apps/web/package.json depends on the npm package `cn`.",
        "",
        "Every base-nova registry item declares `\"dependencies\": [\"cn\"]` and ships",
        "`import { cn } from \"cn\"`. `cn` is a real published package, so `shadcn add` installs it,",
        "and the installed component then uses it instead of this repo's own src/lib/utils helper.",
        "That helper is twMerge-backed, which is what makes conflicting Tailwind classes resolve",
        "deterministically (see the CONTROL_ROW comment in NotificationPreferences.tsx). The npm",
        "package is not twMerge-backed, so the swap is silent and changes which class wins.",
        "",
        "Fix: revert the dependency (package.json + package-lock.json) and repoint the import to",
        "@/lib/utils. Do not silence this guard.",
      ].join("\n"),
    ).toBeUndefined();

    // Recursive: components land in subdirectories as soon as a registry item ships more than one
    // file. A flat readdir would miss them.
    const walk = (dir: string): string[] =>
      !existsSync(dir)
        ? []
        : readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = join(dir, entry.name);
            return entry.isDirectory() ? walk(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
          });

    // Comments are stripped first, then any module specifier of "cn" is matched in any form —
    // static import (including the multi-line shape a formatter produces), re-export, require,
    // and dynamic import. Anchoring to `^\s*import` instead, as this guard first did, misses all
    // but the single-line form; matching the raw text instead falsely fires on prose describing
    // the defect, which is how it first fired — on its own explanatory comment. (Sol, diff review.)
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const importsCn = (source: string) => /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*["']cn["']/.test(stripComments(source));

    const reuiDir = join(webRoot, "src", "components", "reui");
    const offenders = walk(reuiDir)
      .filter((path) => importsCn(readFileSync(path, "utf8")))
      .map((path) => path.slice(reuiDir.length + 1));

    expect(offenders, "these installed components import from the `cn` package instead of @/lib/utils").toEqual([]);
  });
});

describe("guard: no ReUI license key is ever inlined in components.json", () => {
  it("keeps the Authorization header as an unexpanded env placeholder, and leaks no raw key", () => {
    const registries = parsed().registries as Record<string, unknown> | undefined;
    const reui = registries?.["@reui"] as Record<string, unknown> | undefined;
    const headers = reui?.headers as Record<string, unknown> | undefined;
    const authorization = headers?.Authorization;

    if (authorization === undefined) {
      expect(authorization, "no Authorization header present yet — guard is vacuous until issue #49 lands").toBeUndefined();
    } else {
      expect(
        typeof authorization === "string" && authorization.includes("${REUI_LICENSE_KEY}"),
        "registries[\"@reui\"].headers.Authorization must contain the literal `${REUI_LICENSE_KEY}` " +
          "placeholder (expanded by the shadcn CLI at install time), never an inlined key",
      ).toBe(true);
    }

    // Unconditional: even if the header shape changes, no raw ReUI key may appear anywhere in
    // the file text.
    expect(
      /reui_[A-Za-z0-9]/.test(rawText()),
      "components.json contains what looks like a raw ReUI license key/token (`reui_...`). " +
        "License keys must only ever appear as the `${REUI_LICENSE_KEY}` env placeholder.",
    ).toBe(false);
  });
});
