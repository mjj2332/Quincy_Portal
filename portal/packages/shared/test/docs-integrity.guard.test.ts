/**
 * Documentation-integrity guard — four repo-wide checks on `docs/lessons.md` and the doc paths
 * agents are told to follow. Hosted in `packages/shared` beside `ci-vitest-configs.guard.test.ts`
 * for the same reason: shared's is the one config CI has always invoked.
 *
 * 1. No line-number citations into lessons.md. The file grows by hundreds of lines a week, so
 *    `lessons.md:1368-1380` points at the wrong text within days. Cite the heading instead:
 *    docs/lessons.md § "<heading or a unique prefix of it>".
 * 2. Every `## ` section of lessons.md has a `Tags:` line (vocabulary: docs/lessons-tags.md).
 * 3. Every backticked `docs/`, `portal/`, `scripts/`, `.claude/` path in AGENTS.md,
 *    docs/agents/*.md and docs/maps/*.md exists.
 * 4. Every `lessons.md § "…"` citation matches a heading prefix.
 *
 * **Never add an exception list to make a check pass.** Fix the citation, tag or path.
 * Each detector below is a pure function and is exercised against a planted violation, so a
 * detector that stops matching fails here instead of passing vacuously.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const lessonsPath = join(repoRoot, "docs/lessons.md");

// This file's own comments and fixtures quote the patterns it forbids, so the scans skip it.
const SELF = "portal/packages/shared/test/docs-integrity.guard.test.ts";

const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string, accept: (repoRelative: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const absolute = join(dir, name);
    const repoRelative = relative(repoRoot, absolute);
    if (statSync(absolute).isDirectory()) {
      if (repoRelative === "docs/archive" || repoRelative === "docs/retros") continue;
      walk(absolute, accept, out);
    } else if (accept(repoRelative)) {
      out.push(repoRelative);
    }
  }
  return out;
}

function read(repoRelative: string): string {
  return readFileSync(join(repoRoot, repoRelative), "utf8");
}

function citationScanFiles(): string[] {
  const files = ["AGENTS.md"];
  files.push(...walk(join(repoRoot, "docs"), (file) => file.endsWith(".md")));
  if (existsSync(join(repoRoot, ".claude"))) files.push(...walk(join(repoRoot, ".claude"), (file) => file.endsWith(".md")));
  files.push(...walk(join(repoRoot, "portal"), (file) => /\.(ts|tsx|mjs|md)$/.test(file)));
  return files.filter((file) => file !== SELF);
}

// ---------- detectors (pure) ----------

const LINE_CITATION = /lessons\.md[: ]*(line[s]? )?\d+/;

function lineCitations(source: string): string[] {
  return source
    .split("\n")
    .map((line, index) => (LINE_CITATION.test(line) ? `${index + 1}: ${line.trim()}` : undefined))
    .filter((hit): hit is string => hit !== undefined);
}

interface Section {
  line: number;
  heading: string;
  tagsLine: string | undefined;
}

function sectionsOf(lessons: string): Section[] {
  const lines = lessons.split("\n");
  const sections: Section[] = [];
  lines.forEach((text, index) => {
    if (text.startsWith("## ")) sections.push({ line: index + 1, heading: text.slice(3), tagsLine: lines[index + 1] });
  });
  return sections;
}

function tagVocabulary(vocabularySource: string): Set<string> {
  return new Set([...vocabularySource.matchAll(/^- `([a-z0-9-]+)` —/gm)].map((match) => match[1]));
}

function badTagSections(sections: Section[], vocabulary: Set<string>): string[] {
  const bad: string[] = [];
  for (const section of sections) {
    const parsed = /^Tags: ([^·]+?)(?: · (#\d+(?:, #\d+)*))?$/.exec(section.tagsLine ?? "");
    if (!parsed) {
      bad.push(`${section.line}: no \`Tags:\` line directly under "${section.heading}"`);
      continue;
    }
    const tags = parsed[1].split(",").map((tag) => tag.trim());
    const unknown = tags.filter((tag) => !vocabulary.has(tag));
    if (tags.length === 0 || tags.length > 3 || unknown.length > 0) {
      bad.push(`${section.line}: "${section.heading}" has tags [${tags.join(", ")}] (1-3 tags from docs/lessons-tags.md; unknown: [${unknown.join(", ")}])`);
    }
  }
  return bad;
}

const DOC_PATH_ROOT = /^(?:docs|portal|scripts|\.claude)\//;

function docPaths(source: string): string[] {
  const paths: string[] = [];
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim().split(/\s+/)[0] ?? "";
    if (!DOC_PATH_ROOT.test(token)) continue;
    const cleaned = token
      .replace(/#.*$/, "")
      .replace(/:\d+(?:-\d+)?$/, "")
      .replace(/[,.;:)]+$/, "");
    if (/[*<>{}$]/.test(cleaned)) continue;
    paths.push(cleaned);
  }
  return paths;
}

function headingCitations(source: string): string[] {
  return [...source.matchAll(/lessons\.md\s*§\s*"([^"\n]+)"/g)].map((match) => match[1]);
}

/** A path exists if it is on disk, is a unique-name prefix of a sibling (`docs/adr/0003` for `0003-….md`), or is gitignored. */
function pathResolves(repoRelative: string): boolean {
  const absolute = join(repoRoot, repoRelative);
  if (existsSync(absolute)) return true;
  const parent = dirname(absolute);
  const leaf = absolute.slice(parent.length + 1);
  if (existsSync(parent) && readdirSync(parent).some((name) => name.startsWith(`${leaf}-`) || name.startsWith(`${leaf}.`))) return true;
  try {
    execFileSync("git", ["check-ignore", "-q", repoRelative], { cwd: repoRoot, stdio: "ignore" });
    return true; // exit 0: ignored (e.g. `.env.local`, which CI never has)
  } catch {
    return false;
  }
}

// ---------- checks on the real repo ----------

describe("docs/lessons.md citations and structure", () => {
  const lessons = readFileSync(lessonsPath, "utf8");
  const sections = sectionsOf(lessons);

  it("sees the lessons file and its sections (a broken read would make every check vacuous)", () => {
    expect(sections.length).toBeGreaterThan(100);
    expect(citationScanFiles().length).toBeGreaterThan(100);
  });

  it("has no line-number citations into lessons.md", () => {
    const offenders = citationScanFiles().flatMap((file) => lineCitations(read(file)).map((hit) => `${file}:${hit}`));
    expect(
      offenders,
      `Cite the heading, not a line: docs/lessons.md § "<heading or unique prefix>". Line numbers rot as the file grows.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("gives every `## ` section a valid Tags line", () => {
    const vocabulary = tagVocabulary(read("docs/lessons-tags.md"));
    expect(vocabulary.size).toBeGreaterThan(15);
    expect(badTagSections(sections, vocabulary)).toEqual([]);
  });

  it("resolves every `lessons.md § \"…\"` citation to a heading prefix", () => {
    const headings = sections.map((section) => section.heading);
    const unresolved: string[] = [];
    let checked = 0;
    for (const file of citationScanFiles()) {
      for (const cited of headingCitations(read(file))) {
        checked += 1;
        if (!headings.some((heading) => heading.startsWith(cited))) unresolved.push(`${file}: "${cited}"`);
      }
    }
    expect(checked, "no heading citations found; the scan proved nothing").toBeGreaterThan(0);
    expect(unresolved, `No docs/lessons.md heading starts with:\n${unresolved.join("\n")}`).toEqual([]);
  });
});

describe("doc paths named in agent-facing docs", () => {
  it("exist", () => {
    const files = ["AGENTS.md"];
    for (const dir of ["docs/agents", "docs/maps"]) {
      if (existsSync(join(repoRoot, dir))) {
        files.push(...readdirSync(join(repoRoot, dir)).filter((name) => name.endsWith(".md")).map((name) => `${dir}/${name}`));
      }
    }
    let checked = 0;
    const missing: string[] = [];
    for (const file of files) {
      for (const path of docPaths(read(file))) {
        checked += 1;
        if (!pathResolves(path)) missing.push(`${file}: ${path}`);
      }
    }
    expect(checked, "no doc paths found; the scan proved nothing").toBeGreaterThan(0);
    expect(missing, `Paths named in backticks that do not exist:\n${missing.join("\n")}`).toEqual([]);
  });
});

// ---------- the detectors against planted violations ----------

describe("detectors catch planted violations", () => {
  it("flags a line-number citation and passes a heading citation", () => {
    const planted = ["see docs/lessons", ".md:123"].join("");
    expect(lineCitations(`ok\n${planted}\n`)).toHaveLength(1);
    expect(lineCitations(`x ${["lessons", ".md lines 5"].join("")}`)).toHaveLength(1);
    expect(lineCitations('see docs/lessons.md § "A router that owns the URL" and lessons.md (#52)')).toEqual([]);
  });

  it("flags a section with no tags, an unknown tag, or too many tags", () => {
    const vocabulary = new Set(["auth", "routing", "dropbox", "css-tokens"]);
    const section = (tagsLine: string | undefined): Section => ({ line: 1, heading: "H", tagsLine });
    expect(badTagSections([section("Tags: auth, routing · #52")], vocabulary)).toEqual([]);
    expect(badTagSections([section(undefined)], vocabulary)).toHaveLength(1);
    expect(badTagSections([section("Tags: nonsense")], vocabulary)).toHaveLength(1);
    expect(badTagSections([section("Tags: auth, routing, dropbox, css-tokens")], vocabulary)).toHaveLength(1);
  });

  it("extracts doc paths, stripping :line and #anchor and skipping globs and placeholders", () => {
    const source = "`docs/a.md:12-14` `docs/b.md#x` `docs/c/*.md` `portal/<pkg>/x.ts` `docs/lessons.md § \"T\"` `src/x.ts`";
    expect(docPaths(source)).toEqual(["docs/a.md", "docs/b.md", "docs/lessons.md"]);
  });

  it("extracts heading citations", () => {
    expect(headingCitations('docs/lessons.md § "A" and lessons.md § "B (x)"')).toEqual(["A", "B (x)"]);
  });
});
