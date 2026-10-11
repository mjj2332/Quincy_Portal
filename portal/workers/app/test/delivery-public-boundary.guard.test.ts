import { describe, expect, it } from "vitest";

/**
 * The public Delivery page (#787 slice 6) shares a Worker with the staff app and nothing else. This scan keeps `src/delivery/**` from importing anything staff-only: the session and capability
 * middleware, Better Auth, any `routes/` module (which reads `c.get("user")`), impersonation, MCP, or the staff WRITE libraries (Publish, premium, Unlock). It also keeps `console.*` out, which
 * could take a request path or body. Falsified below with planted sources: a scan that cannot fail is not a guard.
 */
const sources = import.meta.glob("../src/delivery/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const FORBIDDEN_IMPORTS = [/\/middleware\//, /(^|\/)auth$/, /better-auth/, /\/routes\/(?!$)/, /\/lib\/impersonation/, /\/mcp\//, /\/lib\/delivery-publish/, /\/lib\/asset-premium/, /\/lib\/video-approval/, /\/lib\/audit/, /\/lib\/server-timing/];
export function violations(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const specifier = match[1]!;
    if (FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier))) found.push(`import ${specifier}`);
  }
  if (/\bconsole\s*\./.test(source)) found.push("console.*");
  if (/c\.get\(\s*["']user["']\s*\)|requireSession|requireCapability|getAuth\s*\(/.test(source)) found.push("staff principal");
  return found;
}

describe("public Delivery surface boundary", () => {
  it("scans the real delivery files", () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(1);
    for (const [path, source] of Object.entries(sources)) expect(violations(source), path).toEqual([]);
  });

  it("detects each forbidden reach on planted sources", () => {
    expect(violations('import { requireSession } from "../middleware/session";')).toContain("import ../middleware/session");
    expect(violations('import { hasProjectAccess } from "../middleware/capability";')).toContain("import ../middleware/capability");
    expect(violations('import { getAuth } from "../auth";')).toContain("import ../auth");
    expect(violations('import { betterAuth } from "better-auth";')).toContain("import better-auth");
    expect(violations('import { serveAssetRendition } from "../routes/media";')).toContain("import ../routes/media");
    expect(violations('import { publishDelivery } from "../lib/delivery-publish";')).toContain("import ../lib/delivery-publish");
    expect(violations('import { setPremium } from "../lib/asset-premium";')).toContain("import ../lib/asset-premium");
    expect(violations('import { writeAudit } from "../lib/audit";')).toContain("import ../lib/audit");
    expect(violations("console.log(c.req.url);")).toContain("console.*");
    expect(violations('const u = c.get("user");')).toContain("staff principal");
    expect(violations('import { readDeliveryState } from "../lib/delivery-dto";\nimport { serveR2Object } from "../lib/r2-serve";\nimport { guestNotFound } from "../guest/http";')).toEqual([]);
  });
});
