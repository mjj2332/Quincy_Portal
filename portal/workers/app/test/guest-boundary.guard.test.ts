import { describe, expect, it } from "vitest";

/**
 * The guest surface (#741 12a) shares a Worker with the staff app and nothing else. This scan keeps `src/guest/**` from reaching the staff session,
 * Better Auth, the capability guards or `console.*` (which could take a request body). It is falsified below with planted sources: a scan that cannot
 * fail is not a guard.
 */
const sources = import.meta.glob("../src/guest/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const FORBIDDEN_IMPORTS = [/\/middleware\/(session|capability)\b/, /(^|\/)auth$/, /better-auth/, /\/routes\/(?!$)/, /\/lib\/impersonation/, /\/mcp\//];
export function violations(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const specifier = match[1]!;
    if (FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier))) found.push(`import ${specifier}`);
  }
  if (/\bconsole\s*\./.test(source)) found.push("console.*");
  if (/c\.get\(\s*["']user["']\s*\)|requireSession|getAuth\s*\(/.test(source)) found.push("staff principal");
  return found;
}

describe("guest surface boundary", () => {
  it("scans the real guest files", () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(5);
    for (const [path, source] of Object.entries(sources)) expect(violations(source), path).toEqual([]);
  });

  it("detects each forbidden reach on planted sources", () => {
    expect(violations('import { requireSession } from "../middleware/session";')).toContain("import ../middleware/session");
    expect(violations('import { getAuth } from "../auth";')).toContain("import ../auth");
    expect(violations('import { betterAuth } from "better-auth";')).toContain("import better-auth");
    expect(violations('import { hasProjectAccess } from "../middleware/capability";')).toContain("import ../middleware/capability");
    expect(violations('import { x } from "../routes/media";')).toContain("import ../routes/media");
    expect(violations("console.log(await c.req.text());")).toContain("console.*");
    expect(violations('const u = c.get("user");')).toContain("staff principal");
    expect(violations('import { hashToken } from "../lib/opaque-token";\nimport { serveR2Object } from "../lib/r2-serve";')).toEqual([]);
  });
});
