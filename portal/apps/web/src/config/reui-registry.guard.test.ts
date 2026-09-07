/**
 * ReUI registry guard — the proxy URL is deliberate, not a mistake to "fix".
 *
 * `components.json` will carry a `@reui` entry under `registries` pointing at
 * `https://proxy.collectui.pro/api/r/reui/{style}/{name}.json`. ReUI's own documentation and its
 * MCP server both advertise a different canonical URL — `https://reui.io/r/{style}/{name}.json`
 * — for the same registry. The owner deliberately chose the proxy instead of the vendor's
 * documented URL (see the "ReUI component registry" section of the root `CLAUDE.md`). An agent
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
import { readFileSync } from "node:fs";
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
        "CLAUDE.md. Do not 'correct' this back to reui.io; revert the change.",
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
