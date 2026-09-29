/**
 * #262: the reuse rule in AGENTS.md ("Reuse ReUI before building UI"), made mechanical.
 *
 * Every UI plan and PR carries a reuse ledger, and reviewers report a new element with no ledger
 * line, but that is guidance an agent can still miss. This guard fails the build when app code
 * OUTSIDE the two component layers AGENTS.md names (`components/reui/`, the vendored ReUI and
 * base-nova set, and `components/quincy/`, the Quincy-owned layer that includes the Base UI
 * `menu.tsx` and ADR 0003's priority stars) gains a hand-built interactive primitive:
 *
 * - a raw `<button>`, `<input>`, `<select>`, `<textarea>` or `<dialog>` element, or
 * - a widget role literal: `dialog`, `menu`, `menuitem`, `listbox`, `option`, `tab`, `tablist`,
 *   `combobox`.
 *
 * Existing occurrences are recorded per file in `ui-primitive-allowlist.ts`, which may only shrink
 * (see that file's header). Tests, the `harness/` preview app and `testing/` helpers are not shipped
 * UI and are not scanned. Icons (inline `<svg>`) are deliberately out of scope: the signature is too
 * noisy to ratchet without a long list of false positives.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { UI_PRIMITIVE_ALLOWLIST, type UiPrimitiveAllowance } from "./ui-primitive-allowlist";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const relSrc = (file: string) => relative(srcDir, file).split(sep).join("/");

const EXCLUDED_DIRS = ["components/reui/", "components/quincy/", "harness/", "testing/"];
const isTestFile = (rel: string) => /\.(dom\.)?test\.tsx?$/.test(rel);

/** Blanks `/* … *\/` (including JSX `{/* … *\/}`) and whole-line `// …` comments. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const RAW_ELEMENT = /<(?:button|input|select|textarea|dialog)(?=[\s>/]|$)/gm;
const WIDGET_ROLE = /\brole=(?:\{\s*)?["'](?:dialog|menu|menuitem|listbox|option|tab|tablist|combobox)["']/g;

export function countPrimitives(source: string): number {
  const text = stripComments(source);
  return (text.match(RAW_ELEMENT)?.length ?? 0) + (text.match(WIDGET_ROLE)?.length ?? 0);
}

function scannedFiles(dir = srcDir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relSrc(full);
    if (statSync(full).isDirectory()) {
      if (!EXCLUDED_DIRS.some((d) => `${rel}/`.startsWith(d))) scannedFiles(full, out);
    } else if (rel.endsWith(".tsx") && !isTestFile(rel)) {
      out.push(full);
    }
  }
  return out;
}

export function measure(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of scannedFiles()) {
    const n = countPrimitives(readFileSync(file, "utf8"));
    if (n > 0) counts[relSrc(file)] = n;
  }
  return counts;
}

export function ratchetViolations(
  actual: Record<string, number>,
  allowlist: Record<string, UiPrimitiveAllowance>,
): string[] {
  const problems: string[] = [];
  for (const [file, n] of Object.entries(actual)) {
    const allowed = allowlist[file];
    if (!allowed) problems.push(`NEW   ${file}: ${n} hand-built primitive(s), not in the allowlist`);
    else if (n > allowed.count) problems.push(`MORE  ${file}: ${n}, allowlist says ${allowed.count}`);
    else if (n < allowed.count) problems.push(`FEWER ${file}: ${n}, allowlist says ${allowed.count} - lower it to lock the gain in`);
  }
  for (const [file, allowed] of Object.entries(allowlist)) {
    if (!(file in actual)) problems.push(`GONE  ${file}: 0 now, allowlist says ${allowed.count} - delete the entry`);
    if (!allowed.ledger.trim()) problems.push(`LEDGER ${file}: the entry needs its reuse-ledger line`);
  }
  return problems.sort();
}

describe("guard: the hand-built UI primitive detector (#262)", () => {
  it("self-test: counts raw primitives and widget roles, not components, prose, or comments", () => {
    const planted = [
      `<button type="button">a</button>`,
      `<input\n  value={x}\n/>`,
      `<select>`,
      `<textarea/>`,
      `<dialog open>`,
      `<div role="dialog">`,
      `<ul role={"listbox"}>`,
      `<li role='option'>`,
      `<div role="tab"> <div role="tablist"> <div role="menu"> <div role="menuitem"> <div role="combobox">`,
    ].join("\n");
    expect(countPrimitives(planted)).toBe(13);

    const clean = [
      `<Button type="button">a</Button>`,
      `<InputGroup>`,
      `<SelectTrigger>`,
      `<buttonish>`,
      `<div role="status">`,
      `<div role="menubar-ish">`,
      `const hint = "press the button to open the dialog";`,
      `// <button> named in a comment`,
      `{/* <input> named in a JSX comment */}`,
      `/* <dialog> in a block comment */`,
    ].join("\n");
    expect(countPrimitives(clean)).toBe(0);
  });

  it("self-test: the ratchet reports new files, raised counts, lowered counts, stale entries and empty ledgers", () => {
    const allowlist: Record<string, UiPrimitiveAllowance> = {
      "same.tsx": { count: 2, ledger: "baseline (#262)" },
      "raised.tsx": { count: 1, ledger: "baseline (#262)" },
      "lowered.tsx": { count: 3, ledger: "baseline (#262)" },
      "gone.tsx": { count: 1, ledger: "baseline (#262)" },
      "unledgered.tsx": { count: 1, ledger: " " },
    };
    const actual = { "same.tsx": 2, "raised.tsx": 2, "lowered.tsx": 1, "new.tsx": 1, "unledgered.tsx": 1 };
    expect(ratchetViolations(actual, allowlist)).toEqual([
      "FEWER lowered.tsx: 1, allowlist says 3 - lower it to lock the gain in",
      "GONE  gone.tsx: 0 now, allowlist says 1 - delete the entry",
      "LEDGER unledgered.tsx: the entry needs its reuse-ledger line",
      "MORE  raised.tsx: 2, allowlist says 1",
      "NEW   new.tsx: 1 hand-built primitive(s), not in the allowlist",
    ]);
  });

  it("scans real app files and skips the two component layers, tests, harness and testing", () => {
    const scanned = scannedFiles().map(relSrc);
    expect(scanned.length).toBeGreaterThan(50);
    expect(scanned).toContain("screens/Dashboard.tsx");
    expect(scanned.some((f) => EXCLUDED_DIRS.some((d) => f.startsWith(d)))).toBe(false);
    expect(scanned.some(isTestFile)).toBe(false);
  });
});

describe("guard: no new hand-built UI primitive outside components/reui/ and components/quincy/ (#262)", () => {
  it("matches the allowlist exactly - it may only shrink", () => {
    const actual = measure();
    const problems = ratchetViolations(actual, UI_PRIMITIVE_ALLOWLIST);
    expect(problems, [
      "The hand-built UI primitive ratchet moved (config/ui-primitive-allowlist.ts).",
      "",
      "NEW or MORE: reach for an installed ReUI or Quincy component first, in AGENTS.md's order",
      "(components/reui, components/quincy, a ReUI component or example, a ReUI block, a shadcn",
      "base-nova primitive). If hand-building really is the answer, add the file to the allowlist in",
      "the same PR with its reuse-ledger line as `ledger`.",
      "FEWER or GONE: good - lower or delete the entry so the gain is locked in.",
      "",
      ...problems,
      "",
      "Current measurement, for reference:",
      JSON.stringify(actual, null, 2),
    ].join("\n")).toEqual([]);
  });
});
