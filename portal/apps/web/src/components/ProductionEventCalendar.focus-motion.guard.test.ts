/**
 * Focus / reduced-motion guard for the Calendar, the Gantt's shared scheduling dialogs and the ReUI
 * shells they render in — the replacement for `ProductionCalendarChrome.guard.test.ts`, which #224
 * retired together with `production-calendar.css` and FullCalendar.
 *
 * The old Calendar had its own `:focus-visible` and reduced-motion blocks, keyed off the
 * `.qc-calendar-screen` / `.qc-cal-event-card` hooks that guard pinned. The ReUI Calendar has none:
 * its focus ring is `tokens/base.css`'s unlayered `:focus-visible` and its reduced motion is
 * `app.css`'s unlayered `@media (prefers-reduced-motion: reduce) { * { …!important } }`. That both
 * rules exist and stay unlayered is pinned by `styles/design-system-guards.test.ts` (Guard 3b/3c).
 *
 * This file pins the other half: nothing on these surfaces may BEAT those rules.
 *
 * - An ordinary `outline-none` / `transition-*` / `duration-*` / `animate-*` utility cannot: it sits
 *   in `@layer utilities`, and unlayered normal declarations outrank every layer.
 * - An `!important` utility can. For important declarations the cascade inverts, so a layered
 *   `!outline-none` beats the unlayered `:focus-visible`, and a layered `!duration-300` beats the
 *   reduced-motion rule's own `!important`. Either leaves the whole DOM suite green (happy-dom
 *   resolves neither layers nor media queries) while removing a focus indicator or restoring motion.
 * - JS-driven motion (`element.animate(...)`, a `motion`/`framer-motion` import, a `behavior:
 *   "smooth"` scroll) never sees CSS at all.
 *
 * Class tokens are matched inside string and template literals only, so a `!animate` negation in
 * code cannot trip the detector. The `requestAnimationFrame` loops in `event-calendar-dnd.tsx` are
 * drag auto-scroll and drop follow-up, driven by the user's pointer, and are not motion to reduce.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const componentsDir = fileURLToPath(new URL(".", import.meta.url));

const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);

function scopedFiles(): string[] {
  const top = readdirSync(componentsDir).filter((name) =>
    isSource(name)
    && (/^ProductionEventCalendar/.test(name)
      || ["ProjectCalendarAnchor.tsx", "ProductionGanttDeadlineDialog.tsx", "ProductionCalendarMoveConfirmation.tsx", "ProductionCalendarScheduleEditorFields.tsx"].includes(name)));
  const vendored = readdirSync(join(componentsDir, "reui", "event-calendar")).filter(isSource).map((name) => join("reui", "event-calendar", name));
  const shells = [join("reui", "alert-dialog.tsx"), join("reui", "sheet.tsx")];
  return [...top, ...vendored, ...shells].map((file) => join(componentsDir, file)).sort();
}

const relName = (file: string) => relative(componentsDir, file).split(sep).join("/");

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The contents of every string and template literal: where class tokens live. */
function stringLiterals(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

const VARIANTS = String.raw`(?:[\w\-\[\]&:=*>.()"'@/]+:)*`;
const UTILITY_TAIL = String.raw`(?:-[\w\-\[\]().%/]+)?`;
/** Tailwind v4 accepts the important marker as a prefix (`!outline-none`) or a suffix (`outline-none!`). */
const IMPORTANT_OUTLINE = new RegExp(String.raw`(?<![\w-])${VARIANTS}(?:!outline-(?:none|hidden|0|transparent)(?![\w-])|outline-(?:none|hidden|0|transparent)!)`);
const IMPORTANT_MOTION = new RegExp(String.raw`(?<![\w-])${VARIANTS}(?:!(?:transition|animate|duration|delay)${UTILITY_TAIL}(?![\w-])|(?:transition|animate|duration|delay)${UTILITY_TAIL}!)`);
const JS_MOTION = /\.animate\(|from\s+["'](?:motion|framer-motion)(?:\/[\w-]+)?["']|behavior:\s*["']smooth["']/;

type Finding = { file: string; token: string };

export function findImportantOverrides(source: string, detector: RegExp): string[] {
  const found: string[] = [];
  for (const literal of stringLiterals(stripComments(source))) {
    for (const token of literal.split(/\s+/)) if (detector.test(token)) found.push(token);
  }
  return found;
}

export function findJsMotion(source: string): string[] {
  return stripComments(source).split("\n").filter((line) => JS_MOTION.test(line)).map((line) => line.trim());
}

function scan(check: (source: string) => string[]): Finding[] {
  return scopedFiles().flatMap((file) => check(readFileSync(file, "utf8")).map((token) => ({ file: relName(file), token })));
}

const format = (findings: Finding[]) => findings.map(({ file, token }) => `  ${file}: ${token}`);

describe("guard: the Calendar's surfaces never beat the global focus ring or reduced-motion rule", () => {
  it("scans the files it claims to (a guard over zero files is green by construction)", () => {
    const names = scopedFiles().map(relName);
    expect(names).toEqual(expect.arrayContaining([
      "ProductionEventCalendar.tsx",
      "ProductionEventCalendarDialogs.tsx",
      "ProjectCalendarAnchor.tsx",
      "reui/event-calendar/event-calendar.tsx",
      "reui/alert-dialog.tsx",
      "reui/sheet.tsx",
    ]));
    expect(names.some((name) => /\.test\.tsx?$/.test(name))).toBe(false);
  });

  it("carries no `!important` outline suppression", () => {
    const findings = scan((source) => findImportantOverrides(source, IMPORTANT_OUTLINE));
    expect(findings, [
      "An !important outline utility beats tokens/base.css's unlayered `:focus-visible` (important",
      "declarations invert the layer order), so it removes the focus ring these surfaces rely on.",
      "Drop the `!` and let the global outline stand.",
      ...format(findings),
    ].join("\n")).toEqual([]);
  });

  it("carries no `!important` transition / animation / duration utility", () => {
    const findings = scan((source) => findImportantOverrides(source, IMPORTANT_MOTION));
    expect(findings, [
      "An !important motion utility beats app.css's unlayered reduced-motion rule, restoring motion",
      "for users who asked for none. Drop the `!`.",
      ...format(findings),
    ].join("\n")).toEqual([]);
  });

  it("drives no motion from JavaScript, which reduced-motion CSS cannot reach", () => {
    const findings = scan(findJsMotion);
    expect(findings, [
      "JS-driven motion ignores prefers-reduced-motion CSS. Use a CSS transition (the global rule",
      "covers it) or gate the call on `matchMedia(\"(prefers-reduced-motion: reduce)\")`.",
      ...format(findings),
    ].join("\n")).toEqual([]);
  });
});

describe("guard: the detectors can fail — proof against planted fixtures", () => {
  const outline = (source: string) => findImportantOverrides(source, IMPORTANT_OUTLINE);
  const motion = (source: string) => findImportantOverrides(source, IMPORTANT_MOTION);

  it("flags important outline suppression, prefix or suffix, behind variants", () => {
    expect(outline('className="rounded-sm !outline-none"')).toEqual(["!outline-none"]);
    expect(outline("cn('px-2', 'focus-visible:outline-hidden!')")).toEqual(["focus-visible:outline-hidden!"]);
    expect(outline("const C = `data-[state=open]:!outline-0 grid`;")).toEqual(["data-[state=open]:!outline-0"]);
  });

  it("ignores the ordinary utilities the global rule already beats, and prose", () => {
    expect(outline('className="outline-none focus-visible:outline-2 focus-visible:outline-solid"')).toEqual([]);
    expect(outline("// never write !outline-none here\nconst x = 1;")).toEqual([]);
    expect(outline('className="!outline-offset-2"')).toEqual([]);
  });

  it("flags important motion utilities and leaves ordinary ones and code negations alone", () => {
    expect(motion('className="!transition-all duration-200"')).toEqual(["!transition-all"]);
    expect(motion('className="data-open:duration-300! animate-in"')).toEqual(["data-open:duration-300!"]);
    expect(motion('className="!animate-[spin_1s_linear_infinite]"')).toEqual(["!animate-[spin_1s_linear_infinite]"]);
    expect(motion('className="transition-opacity duration-150 animate-in fade-in-0"')).toEqual([]);
    expect(motion("if (!animate) return; const transitioning = !transitionRef.current;")).toEqual([]);
  });

  it("flags JS-driven motion and ignores a comment about it", () => {
    expect(findJsMotion("el.animate([{ opacity: 0 }], 200);")).toHaveLength(1);
    expect(findJsMotion('import { motion } from "motion/react";')).toHaveLength(1);
    expect(findJsMotion('node.scrollIntoView({ behavior: "smooth" });')).toHaveLength(1);
    expect(findJsMotion("// el.animate() is banned here\nconst y = 2;")).toEqual([]);
    expect(findJsMotion('node.scrollIntoView({ block: "nearest" });')).toEqual([]);
  });
});
