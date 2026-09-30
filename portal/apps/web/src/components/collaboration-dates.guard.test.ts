/**
 * #376 — every date on the Collaboration tab goes through `lib/date-format.ts` (Sydney time, no
 * seconds). A file that formats a date itself with a locale API silently picks the viewer's zone
 * and adds seconds, which is how comments, activity and background jobs drifted apart.
 *
 * Per `docs/lessons.md` ("a grep gate that cannot fail is not a gate"), the detector is a pure
 * function exercised against planted fixture text as well as the real files.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const srcDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const COLLABORATION_FILES = [
  "components/ProjectDiscussionThread.tsx",
  "components/ProjectActivityView.tsx",
  "components/ProjectCollaborationPanel.tsx",
  "components/SubtaskChecklist.tsx",
  "screens/ProjectWorkspace.tsx",
] as const;

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat((match.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const FORBIDDEN = [/\.toLocaleString\s*\(/, /\.toLocaleDateString\s*\(/, /\.toLocaleTimeString\s*\(/, /new\s+Intl\.DateTimeFormat\s*\(/];

/** The forbidden locale-formatting calls a source file makes in code (comments ignored). */
export function localeDateCalls(source: string): string[] {
  const code = stripComments(source);
  return FORBIDDEN.flatMap((pattern) => (pattern.test(code) ? [pattern.source] : []));
}

describe("detector", () => {
  it("flags each locale-formatting form in code", () => {
    expect(localeDateCalls("const a = new Date(x).toLocaleString();")).toHaveLength(1);
    expect(localeDateCalls('d.toLocaleString("en-AU")')).toHaveLength(1);
    expect(localeDateCalls("d.toLocaleDateString()")).toHaveLength(1);
    expect(localeDateCalls("d.toLocaleTimeString()")).toHaveLength(1);
    expect(localeDateCalls("new Intl.DateTimeFormat('en-AU')")).toHaveLength(1);
  });

  it("ignores comments and unrelated calls", () => {
    expect(localeDateCalls("// used to be toLocaleString()\n/* new Intl.DateTimeFormat( */ const n = (5).toFixed(2);")).toEqual([]);
  });
});

describe("Collaboration tab files", () => {
  it.each(COLLABORATION_FILES)("%s formats no date itself", (file) => {
    expect(localeDateCalls(readFileSync(join(srcDir, file), "utf8"))).toEqual([]);
  });
});
