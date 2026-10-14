import { describe, expect, it } from "vitest";

/**
 * The guest surface (#741 12a) shares a Worker with the staff app and nothing else. This scan keeps `src/guest/**` from reaching the staff session,
 * Better Auth, the capability guards or `console.*` (which could take a request body). It is falsified below with planted sources: a scan that cannot
 * fail is not a guard.
 */
const sources = import.meta.glob("../src/guest/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const FORBIDDEN_IMPORTS = [/\/middleware\/(session|capability)\b/, /(^|\/)auth$/, /better-auth/, /\/routes\/(?!$)/, /\/lib\/impersonation/, /\/mcp\//, /\/lib\/delivery-review-link/];
export function violations(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const specifier = match[1]!;
    if (FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier))) found.push(`import ${specifier}`);
  }
  if (/\bconsole\s*\./.test(source)) found.push("console.*");
  if (/c\.get\(\s*["']user["']\s*\)|requireSession|getAuth\s*\(/.test(source)) found.push("staff principal");
  // #847: the guest side only ever hashes the token it is shown. The stored secret is staff's (copy the address) and the public Delivery page's entry (`lib/delivery-review-entry.ts`), nothing here.
  if (/\btoken_secret\b/.test(source)) found.push("reads the stored link secret");
  // #863: Review status is staff-only. No column, DTO key or stored value of it may appear in a guest or public Delivery source (ADR 0021 section 7).
  if (/\b(?:review_status|reviewStatus|approved_internal)\b/.test(source)) found.push("reads Review status");
  // #872: a guest sees an overlay's id, name and public image path (`listGuestSocialOverlays` maps them). The platform label is staff's.
  if (/\b(?:platform_label|platformLabel)\b/.test(source)) found.push("reads the Social platform label");
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
    expect(violations("db.prepare('SELECT token_secret FROM client_links')")).toContain("reads the stored link secret");
    // #863: Review status is staff-only (ADR 0021 section 7, guests see public content only). The planted forms are the column, the DTO key and the stored value.
    expect(violations("db.prepare('SELECT m.review_status FROM video_version_meta m')")).toContain("reads Review status");
    expect(violations("const dto = { reviewStatus: video.reviewStatus };")).toContain("reads Review status");
    expect(violations("if (row.status === 'approved_internal') hide();")).toContain("reads Review status");
    expect(violations("const approvalStatus = 'approved'; // a client decision is not a Review status")).toEqual([]);
    expect(violations("db.prepare('SELECT platform_label FROM social_overlays')")).toContain("reads the Social platform label");
    expect(violations("const dto = { platformLabel: row.platform_label };")).toContain("reads the Social platform label");
    expect(violations("const dto = { id: row.id, name: row.name, imageUrl };")).toEqual([]);
    expect(violations('import { syncDeliveryReviewLink } from "../lib/delivery-review-link";')).toContain("import ../lib/delivery-review-link");
    expect(violations('import { hashToken } from "../lib/opaque-token";\nimport { serveR2Object } from "../lib/r2-serve";')).toEqual([]);
  });
});
