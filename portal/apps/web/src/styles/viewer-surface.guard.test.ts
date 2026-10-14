/**
 * Viewer-surface guard (ADR 0024, #877).
 *
 * A panel, pane, tab or notice inside a dark viewer inherits the viewer's inverse scope. It must not
 * open its own `data-surface="default"` scope. Source-level on purpose: the attribute is the defect,
 * and a rendered test only sees the viewers a test happens to mount.
 *
 * Allowed: the toast viewport (floats above every screen and keeps the app-wide light look) and the
 * Project page's DeliveryTab (outside every viewer).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(["components/quincy/ToastViewport.tsx", "components/delivery/DeliveryTab.tsx"]);

/** Matches a default-scope opener in JSX or an object/props literal. */
const FORBIDDEN = /data-surface\s*=\s*(?:"default"|'default'|\{\s*["'`]default["'`]\s*\})|surface\s*:\s*["'`]default["'`]/;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
    }
  };
  walk(srcDir);
  return out;
}

describe("viewer surface guard (ADR 0024)", () => {
  it("matcher catches every form of a default scope (negative fixture)", () => {
    for (const bad of [
      '<aside data-surface="default" className="x">',
      "<aside data-surface='default'>",
      '<div data-surface={"default"}>',
      "<div data-surface={`default`}>",
      'const p = { surface: "default" }',
    ]) expect(FORBIDDEN.test(bad), bad).toBe(true);
    for (const ok of ['<div data-surface="inverse">', "<div data-surface={surface}>", "// default surface"]) {
      expect(FORBIDDEN.test(ok), ok).toBe(false);
    }
  });

  it("no component opens a default scope except the toast viewport and the Project page's DeliveryTab", () => {
    const offenders = sourceFiles()
      .map((f) => relative(srcDir, f))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => FORBIDDEN.test(readFileSync(join(srcDir, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the video Delivery panel does not import DeliveryTab (which opens default scopes)", () => {
    const src = readFileSync(join(srcDir, "components/video/VideoDeliveryPanel.tsx"), "utf8");
    expect(src).not.toMatch(/DeliveryTab/);
  });
});

describe("frame roles follow the surface scope (#877)", () => {
  // --frame-panel-bg / --frame-border-color are declared on :root and read raw aliases, so a
  // FramePanel in the dark viewer painted paper with paper-050 text unless the scope overrides them.
  const inverse = readFileSync(join(srcDir, "styles/tokens/inverse.css"), "utf8");
  const block = (selector: string) =>
    new RegExp(`\\[data-surface="${selector}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(inverse)?.[1] ?? "";

  it.each(["inverse", "default"])("the %s scope defines the frame roles", (scope) => {
    for (const role of ["--frame-panel-bg", "--frame-border-color", "--frame-panel-border-color"]) {
      expect(block(scope), `${scope} missing ${role}`).toMatch(new RegExp(`${role}\\s*:`));
    }
  });

  it("the inverse frame panel resolves to the inverted card role, not paper", () => {
    expect(block("inverse")).toMatch(/--frame-panel-bg:\s*var\(--card\)/);
  });
});
