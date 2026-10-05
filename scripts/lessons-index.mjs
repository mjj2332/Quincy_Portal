#!/usr/bin/env node
// Index of docs/lessons.md sections (each `## ` heading carries a `Tags:` line).
//
// Usage (from the repo root):
//   node scripts/lessons-index.mjs                 every section: line  tags  heading
//   node scripts/lessons-index.mjs focus-overlays  sections carrying that tag
//   node scripts/lessons-index.mjs '#52'           sections citing that issue/PR (also: 52)
//   node scripts/lessons-index.mjs 'router'        sections whose heading contains the text (case-insensitive)
// Tag vocabulary: docs/lessons-tags.md.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lessons = readFileSync(fileURLToPath(new URL("../docs/lessons.md", import.meta.url)), "utf8").split("\n");

const sections = [];
lessons.forEach((text, index) => {
  if (!text.startsWith("## ")) return;
  const tagLine = /^Tags: ([^·]*?)(?: · (.*))?$/.exec(lessons[index + 1] ?? "");
  sections.push({
    line: index + 1,
    heading: text.slice(3),
    tags: tagLine ? tagLine[1].split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    refs: tagLine?.[2] ? tagLine[2].split(",").map((ref) => ref.trim()) : [],
    headingRefs: [...text.matchAll(/#(\d+)/g)].map((match) => `#${match[1]}`),
  });
});

const query = process.argv[2];
const issue = query === undefined ? undefined : /^#?(\d+)$/.exec(query)?.[1];
const matches = sections.filter((section) => {
  if (query === undefined) return true;
  if (issue !== undefined) return [...section.refs, ...section.headingRefs].includes(`#${issue}`);
  if (section.tags.includes(query)) return true;
  return section.heading.toLowerCase().includes(query.toLowerCase());
});

for (const section of matches) {
  console.log(`${String(section.line).padStart(5)}  ${section.tags.join(",").padEnd(40)}  ${section.heading}`);
}
if (matches.length === 0) {
  console.error(`No section matches ${JSON.stringify(query)}.`);
  process.exitCode = 1;
}
