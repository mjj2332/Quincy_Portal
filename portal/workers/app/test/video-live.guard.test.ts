import { describe, expect, it } from "vitest";

/**
 * Video Trash (#776 B). A Version or Video in Trash keeps its rows, so any SQL that reads or writes `video_version_meta` or `videos` must say whether it wants the LIVE row.
 * Every SQL string in `workers/*\/src` that names either table must filter every instance of it with `<alias>.removed_at` (or a bare `removed_at` for an unaliased table), or call
 * `LIVE_VERSION("<alias>")` / `LIVE_VIDEO("<alias>")` from `lib/video-live-sql.ts`, or carry an entry in ALLOWLIST below with the reason it must see removed rows.
 *
 * The scanner reads the source text, not the running program, so it has its own lexer (comments, strings, template literals with nested `${}`, regex literals) and joins strings
 * concatenated with `+` into one unit. It is falsified against planted fixtures below: a guard that cannot fail is not a guard (docs/lessons.md, "A guard's matcher must be validated
 * against forms that actually exist").
 */
const app = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const background = import.meta.glob("../../background/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// ---- lexer ----------------------------------------------------------------------------------------------------------------------------------------------

export type Unit = { text: string; line: number };
const REGEX_PREV = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** The end index (exclusive) of the quoted string starting at `i`. */
function endOfString(source: string, i: number): number {
  const quote = source[i]!;
  let j = i + 1;
  while (j < source.length && source[j] !== quote) j += source[j] === "\\" ? 2 : 1;
  return j + 1;
}
/** The end index (exclusive) of the template literal starting at `i`, `${}` expressions (and templates nested in them) included. */
function endOfTemplate(source: string, i: number): number {
  let j = i + 1;
  while (j < source.length) {
    const ch = source[j]!;
    if (ch === "\\") j += 2;
    else if (ch === "`") return j + 1;
    else if (ch === "$" && source[j + 1] === "{") j = endOfExpression(source, j + 2);
    else j += 1;
  }
  return j;
}
/** The index just past the `}` closing an expression that starts at `i` (after `${` or `{`). */
function endOfExpression(source: string, i: number): number {
  let depth = 1; let j = i;
  while (j < source.length && depth > 0) {
    const ch = source[j]!;
    if (ch === "'" || ch === '"') j = endOfString(source, j);
    else if (ch === "`") j = endOfTemplate(source, j);
    else if (ch === "/" && source[j + 1] === "/") j = source.indexOf("\n", j) === -1 ? source.length : source.indexOf("\n", j);
    else if (ch === "/" && source[j + 1] === "*") j = source.indexOf("*/", j + 2) + 2;
    else { if (ch === "{") depth += 1; else if (ch === "}") depth -= 1; j += 1; }
  }
  return j;
}

/** Every string and template literal of a TypeScript source, comments and regex literals skipped, literals joined by `+` merged into one unit. */
export function sqlUnits(source: string): Unit[] {
  const literals: Array<{ start: number; end: number }> = [];
  let i = 0; let prev = ""; let prevWord = "";
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "/" && source[i + 1] === "/") { const nl = source.indexOf("\n", i); i = nl === -1 ? source.length : nl; continue; }
    if (ch === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); i = end === -1 ? source.length : end + 2; continue; }
    if (ch === "'" || ch === '"') { const end = endOfString(source, i); literals.push({ start: i, end }); i = end; prev = ch; prevWord = ""; continue; }
    if (ch === "`") { const end = endOfTemplate(source, i); literals.push({ start: i, end }); i = end; prev = ch; prevWord = ""; continue; }
    if (ch === "/" && (prev === "" || REGEX_PREV.has(prev) || prevWord === "return" || prevWord === "typeof")) {
      let j = i + 1; let inClass = false;
      while (j < source.length && (source[j] !== "/" || inClass) && source[j] !== "\n") { if (source[j] === "\\") j += 1; else if (source[j] === "[") inClass = true; else if (source[j] === "]") inClass = false; j += 1; }
      i = j + 1; prev = "/"; prevWord = ""; continue;
    }
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[\w$]/.test(ch)) { let j = i; while (j < source.length && /[\w$]/.test(source[j]!)) j += 1; prevWord = source.slice(i, j); prev = "a"; i = j; continue; }
    prev = ch; prevWord = ""; i += 1;
  }
  const units: Array<{ start: number; end: number }> = [];
  for (const literal of literals) {
    const last = units.at(-1);
    const between = last ? source.slice(last.end, literal.start).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/\s+/g, "") : null;
    if (last && between === "+") last.end = literal.end; else units.push({ ...literal });
  }
  return units.map((unit) => ({ text: source.slice(unit.start, unit.end), line: source.slice(0, unit.start).split("\n").length }));
}

// ---- the rule -------------------------------------------------------------------------------------------------------------------------------------------

const SQL_KEYWORDS = new Set(["on", "where", "set", "join", "left", "right", "inner", "cross", "full", "natural", "group", "order", "limit", "using", "and", "or", "union", "values", "returning", "when", "then", "else", "end", "select", "from", "as", "not", "is", "in", "exists", "case", "having", "offset", "except", "intersect"]);
const INSTANCE = /\b(FROM|JOIN|UPDATE)\s+(videos|video_version_meta)\b(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
/** The Drizzle spellings of the two tables: a query-builder read is no more exempt than a raw string. */
const BUILDER = /\bschema\.(videos|videoVersionMeta)\b|\bvideoVersionMeta\b/;

type Instance = { table: "videos" | "video_version_meta"; alias: string | null };
/** Every FROM / JOIN / UPDATE of the two tables in a unit, with its alias. */
export function instances(text: string): Instance[] {
  const found: Instance[] = [];
  for (const match of text.matchAll(INSTANCE)) {
    const candidate = match[3]; const alias = candidate && !SQL_KEYWORDS.has(candidate.toLowerCase()) ? candidate : null;
    found.push({ table: match[2]!.toLowerCase() as Instance["table"], alias });
  }
  return found;
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether the unit filters this instance: `<alias>.removed_at`, a bare `removed_at` for an unaliased table, or the matching live fragment called with that alias. */
export function filtered(text: string, instance: Instance): boolean {
  const name = instance.alias ?? instance.table;
  const fragment = instance.table === "videos" ? "LIVE_VIDEO" : "LIVE_VERSION";
  if (new RegExp(`(?<![\\w.])${escape(name)}\\.removed_at\\b`).test(text)) return true;
  if (new RegExp(`\\b${fragment}\\s*\\(\\s*["'\`]${escape(name)}["'\`]\\s*\\)`).test(text)) return true;
  if (new RegExp(`\\bLIVE_VERSION_OF_VIDEO\\s*\\([^)]*["'\`]${escape(name)}["'\`]`).test(text)) return true;
  return instance.alias === null && new RegExp("(?<![\\w.])removed_at\\b").test(text);
}
/** The reasons a unit breaks the rule, empty when it keeps it. */
export function problems(text: string): string[] {
  const found = instances(text); const out: string[] = [];
  for (const instance of found) if (!filtered(text, instance)) out.push(`${instance.table}${instance.alias ? ` ${instance.alias}` : ""} is not filtered on removed_at`);
  if (found.length === 0 && /\bvideo_version_meta\b/.test(text) && !/\bINSERT\s+INTO\s+video_version_meta\b/i.test(text)) out.push("names video_version_meta outside FROM / JOIN / UPDATE");
  return out;
}

export type Violation = { file: string; line: number; reasons: string[]; text: string };
export function scan(files: Record<string, string>): Violation[] {
  const out: Violation[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (/\.test\.ts$/.test(file)) continue;
    for (const unit of sqlUnits(source)) { const reasons = problems(unit.text); if (reasons.length) out.push({ file, line: unit.line, reasons, text: unit.text }); }
    // Query-builder references (outside the schema file that defines them).
    if (!/\/schema\.ts$/.test(file) && BUILDER.test(source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""))) out.push({ file, line: 1, reasons: ["references the Drizzle videos / videoVersionMeta table"], text: "schema.videos" });
  }
  return out;
}

// ---- the allowlist: paths that must see removed rows ----------------------------------------------------------------------------------------------------

/** `contains` is a substring that identifies exactly one violating unit in `file`. An entry that matches nothing, or more than one unit, fails the test. */
export const ALLOWLIST: ReadonlyArray<{ file: string; contains: string; reason: string }> = [
  { file: "../src/routes/video-uploads.ts", contains: "SELECT MAX(position) + 1 FROM videos WHERE collection_id", reason: "Position allocation counts Trash too, so a restored Video never lands on a position another Video took." },
  { file: "../src/routes/video-uploads.ts", contains: "SELECT poster_key FROM video_version_meta WHERE asset_id = ?) = ?", reason: "Cleanup ownership: the poster adoption's queue entry is deleted only if the row still holds the key, whether or not the Version is in Trash." },
  { file: "../src/routes/video-uploads.ts", contains: "SELECT poster_key AS posterKey FROM video_version_meta WHERE asset_id = ?", reason: "Cleanup ownership: after a thrown adoption the object is kept if the row holds its key, in Trash or not." },
];

const files = { ...app, ...background };
describe("video Trash: every SQL over video_version_meta or videos filters on removed_at", () => {
  it("scans the real sources", () => {
    expect(Object.keys(files).length).toBeGreaterThan(100);
    expect(Object.keys(files).some((file) => file.includes("background/src/notification-delivery.ts"))).toBe(true);
    // The scanner must see the SQL it is there to guard.
    const seen = scan({ x: 'const a = "SELECT 1 FROM videos v";' }); expect(seen).toHaveLength(1);
  });

  it("has no unfiltered SQL outside the allowlist, and no stale allowlist entry", () => {
    const violations = scan(files);
    const used = new Set<number>();
    const open = violations.filter((violation) => {
      const index = ALLOWLIST.findIndex((entry) => entry.file === violation.file && violation.text.includes(entry.contains));
      if (index === -1) return true;
      used.add(index); return false;
    });
    expect(open.map((violation) => `${violation.file}:${violation.line} ${violation.reasons.join("; ")}\n${violation.text.slice(0, 240)}`), "unfiltered SQL").toEqual([]);
    ALLOWLIST.forEach((entry, index) => {
      expect(entry.reason.length, `${entry.contains} needs a reason`).toBeGreaterThan(20);
      expect(used.has(index), `stale allowlist entry: ${entry.file} ${entry.contains}`).toBe(true);
      expect(violations.filter((violation) => violation.file === entry.file && violation.text.includes(entry.contains)), `ambiguous allowlist entry: ${entry.contains}`).toHaveLength(1);
    });
  });
});

describe("the scanner, falsified against planted sources", () => {
  const flagged = (source: string) => scan({ "planted.ts": source }).length;

  it("flags an unfiltered template literal, string, concatenation and fragment-less alias", () => {
    expect(flagged("db.prepare(`SELECT v.id FROM videos v WHERE v.project_id = ?`)")).toBe(1);
    expect(flagged('db.prepare("SELECT m.asset_id FROM video_version_meta m WHERE m.video_id = ?")')).toBe(1);
    expect(flagged("db.prepare('SELECT 1 FROM videos v ' + 'JOIN video_version_meta m ON m.video_id = v.id ' + 'WHERE v.id = ?')")).toBe(1);
    expect(flagged("const sql = `SELECT 1 FROM assets a JOIN videos v ON v.id = a.version_group_id WHERE ${cond}`;")).toBe(1);
    expect(flagged('const update = "UPDATE videos SET premium = 1 WHERE id = ?";')).toBe(1);
    expect(flagged("const q = `SELECT 1 FROM x WHERE a ${flag ? \"AND EXISTS (SELECT 1 FROM videos v WHERE v.id = x.v)\" : \"\"}`;")).toBe(1);
    expect(flagged("const q = db.select().from(schema.videos);")).toBe(1);
  });

  it("flags a filter that belongs to another table or another alias, or sits in a comment", () => {
    expect(flagged("`SELECT 1 FROM review_link_videos rv JOIN videos v ON v.id = rv.video_id WHERE rv.removed_at IS NULL`")).toBe(1);
    expect(flagged("`SELECT 1 FROM video_version_meta m JOIN videos v ON v.id = m.video_id WHERE m.removed_at IS NULL`")).toBe(1);
    expect(flagged('`SELECT 1 FROM videos v WHERE ${LIVE_VIDEO("other")}`')).toBe(1);
    expect(flagged("`SELECT 1 FROM videos v` // WHERE v.removed_at IS NULL")).toBe(1);
    expect(flagged("`SELECT 1 FROM videos v` /* v.removed_at IS NULL */")).toBe(1);
    expect(flagged("`SELECT 1 FROM videos v WHERE x_removed_at IS NULL`")).toBe(1);
  });

  it("accepts every filtered form: the column, a bare column, the fragments, and a concatenation split across the filter", () => {
    expect(flagged("`SELECT v.id FROM videos v WHERE v.project_id = ? AND v.removed_at IS NULL`")).toBe(0);
    expect(flagged("`SELECT id FROM videos WHERE project_id = ? AND removed_at IS NULL`")).toBe(0);
    expect(flagged("`UPDATE videos SET premium = 1 WHERE id = ? AND videos.removed_at IS NULL`")).toBe(0);
    expect(flagged('`SELECT 1 FROM video_version_meta m JOIN videos v ON v.id = m.video_id WHERE ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")}`')).toBe(0);
    expect(flagged("`SELECT 1 FROM video_version_meta AS m JOIN videos AS v ON v.id = m.video_id WHERE ${LIVE_VERSION_OF_VIDEO('m', 'v')}`")).toBe(0);
    expect(flagged("db.prepare('SELECT 1 FROM videos v ' + 'WHERE v.id = ? ' + 'AND v.removed_at IS NULL')")).toBe(0);
    expect(flagged('`UPDATE video_version_meta SET poster_key = ? WHERE ${LIVE_VERSION("video_version_meta")}`')).toBe(0);
  });

  it("ignores comments, regex literals, URL paths and an INSERT's column list, and keeps lexing after a regex with a quote in it", () => {
    expect(flagged("// SELECT 1 FROM videos v\n/* JOIN videos v */ const x = 1;")).toBe(0);
    expect(flagged("const r = /['()*]/g; const sql = `SELECT 1 FROM videos v`;")).toBe(1);
    expect(flagged("const path = '/projects/:projectId/videos'; const t = `from the videos list`;")).toBe(0);
    expect(flagged("`INSERT INTO video_version_meta (asset_id, video_id) VALUES (?, ?)`")).toBe(0);
    expect(flagged("`INSERT INTO videos (id) SELECT ? WHERE 1`")).toBe(0);
  });

  it("flags a bare mention of video_version_meta that is not an instance", () => {
    expect(flagged("`SELECT poster_key, video_version_meta.asset_id`")).toBe(1);
  });

  it("joins a concatenation, keeps adjacent unrelated strings apart, and survives nested templates", () => {
    expect(sqlUnits("a('x ' + 'y', 'z')").map((unit) => unit.text)).toEqual(["'x ' + 'y'", "'z'"]);
    const nested = sqlUnits("const q = `A ${b ? `inner ${c}` : \"d\"} E`; const next = 'F';").map((unit) => unit.text);
    expect(nested).toEqual(["`A ${b ? `inner ${c}` : \"d\"} E`", "'F'"]);
  });
});
