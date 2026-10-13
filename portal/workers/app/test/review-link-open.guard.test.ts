import { describe, expect, it } from "vitest";

/**
 * "Is this Review link open" has one SQL home (#847): `reviewLinkOpenSql` / `reviewLinkExpiryOrSql` in `packages/db/src/review-link-sql.ts`, and `reviewLinkExpired` for TypeScript.
 * `client_links.expires_at` is NULL for the Delivery review link, and NULL breaks every hand-written form: `expires_at > now` reads it as expired, `MIN(x, expires_at)` is NULL (which then
 * violates `guest_sessions.expires_at NOT NULL`). So no file in `workers/*\/src` may compare the column of a Review link itself. Other tables' `expires_at` (sessions, uploads, codes) are untouched.
 *
 * The scanner reads text: a comparison on an alias of `client_links` (`l`, `dl`, `cl`, `link`, or the table name), a comparison on a bare `expires_at` whose nearest FROM/UPDATE/JOIN table is
 * `client_links`, or a MIN/COALESCE over such a column. It is falsified against planted fixtures below (docs/lessons.md, "A guard's matcher must be validated against forms that actually exist").
 */
const app = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const background = import.meta.glob("../../background/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const LINK_ALIASES = "(?:l|dl|cl|link|client_links)";
const ALIASED = new RegExp(`\\b${LINK_ALIASES}\\.expires_at\\s*(?:<=|>=|<|>|=(?!=))`, "g");
const WRAPPED = new RegExp(`\\b(?:MIN|MAX|COALESCE|IFNULL)\\s*\\([^()]*\\b${LINK_ALIASES}\\.expires_at\\b`, "gi");
const BARE = /(?<![\w.])expires_at\s*(?:<=|>=|<|>)/g;

export function violations(source: string): Array<{ line: number; text: string }> {
  const found = new Map<number, string>();
  const note = (index: number) => { const line = source.slice(0, index).split("\n").length; found.set(line, source.split("\n")[line - 1]!.trim()); };
  for (const match of source.matchAll(ALIASED)) note(match.index!);
  for (const match of source.matchAll(WRAPPED)) note(match.index!);
  for (const match of source.matchAll(BARE)) {
    const before = source.slice(Math.max(0, match.index! - 600), match.index!);
    const tables = [...before.matchAll(/\b(?:FROM|UPDATE|JOIN)\s+(\w+)/gi)];
    if (tables.at(-1)?.[1] === "client_links") note(match.index!);
  }
  return [...found].map(([line, text]) => ({ line, text }));
}

describe("one definition of an open Review link (#847)", () => {
  it("no worker source compares or wraps client_links.expires_at itself", () => {
    const offenders = Object.entries({ ...app, ...background }).flatMap(([path, source]) => violations(source).map((found) => `${path}:${found.line}  ${found.text}`));
    expect(offenders).toEqual([]);
  });

  it("falsification: the planted forms are caught", () => {
    expect(violations("SELECT 1 FROM client_links l WHERE l.expires_at > ?1")).toHaveLength(1);
    expect(violations("SELECT 1 FROM client_links dl WHERE dl.expires_at <= ?1")).toHaveLength(1);
    expect(violations("SELECT MIN(?4, l.expires_at) FROM client_links l")).toHaveLength(1);
    expect(violations("SELECT COALESCE(l.expires_at, 0) FROM client_links l")).toHaveLength(1);
    expect(violations("EXISTS (SELECT 1 FROM client_links WHERE id = ? AND expires_at > ?)")).toHaveLength(1);
    expect(violations("UPDATE client_links SET token_hash = ? WHERE id = ? AND expires_at > ?")).toHaveLength(1);
    expect(violations("SELECT 1 FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE client_links.expires_at > ?")).toHaveLength(1);
  });

  it("falsification: other tables and the helper's callers are not flagged", () => {
    expect(violations("SELECT 1 FROM guest_sessions s WHERE s.expires_at > ?1")).toEqual([]);
    expect(violations("SELECT 1 FROM external_edited_upload_sessions WHERE expires_at > ?")).toEqual([]);
    expect(violations("SELECT 1 FROM client_links l JOIN guest_sessions s ON s.link_id = l.id WHERE s.expires_at > ?3")).toEqual([]);
    expect(violations('SELECT l.id, l.label, l.expires_at, l.created_at FROM client_links l WHERE ${reviewLinkOpenSql("l", "?2")}')).toEqual([]);
    expect(violations("const LINK_SELECT = \"l.id, l.expires_at, l.allow_comments\"")).toEqual([]);
  });
});
