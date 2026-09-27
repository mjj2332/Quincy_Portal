/**
 * The write boundary of `ProductionGantt.tsx`, asserted against its source text.
 *
 * History: #220 pass B (build spec S6 point 4) made this the read-only boundary's fourth leg — it
 * failed the build if `ProductionGantt.tsx` imported anything from `lib/use-scheduling-commands`,
 * `lib/scheduling-policy*` or `lib/scheduling-undo`, and said #221 would delete that assertion on
 * purpose. #221 PR B2 did: the Gantt now writes checklist schedules through the shared scheduling
 * controller, so importing those modules is the design, not an accident.
 *
 * What still must never happen, and what this guard now pins (post-#221 contract):
 * (a) `onEventsChange` is never passed to `<Gantt>`. Every write is `"deferred"` to the controller,
 *     whose authoritative refetch is the only thing that moves a bar for good; an `onEventsChange`
 *     consumer would let the vendor commit a range the server later refuses.
 * (b) `canDropEvent` / `enforceCanDrop` are never passed. Production warns (`dropWarning`), it
 *     never blocks a drop — the server's versioned write is the only gate.
 *
 * The names are matched anywhere in the file's CODE (comments stripped first — the header of
 * `ProductionGantt.tsx` names them in prose), so a JSX prop, a spread object or a props variable all
 * trip it. Per `docs/lessons.md`'s "a grep gate that cannot fail is not a gate", the detector is
 * exercised against planted fixture text below, not just against the real file.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const componentsDir = fileURLToPath(new URL(".", import.meta.url));
const sourcePath = join(componentsDir, "ProductionGantt.tsx");

function productionGanttSource(): string {
  return readFileSync(sourcePath, "utf8");
}

/**
 * Line-preserving comment strip, same shape as `testing/test-seam.guard.test.ts`'s: block comments
 * (including JSX `{/* … *\/}`) and whole-line `//` comments. A trailing `//` comment after code is
 * left in place — that can only make this guard stricter, never blind it.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat((match.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const FORBIDDEN_GANTT_PROPS = ["canDropEvent", "enforceCanDrop", "onEventsChange"] as const;

/** Which forbidden `<Gantt>` settings the source's code (not its comments) mentions, sorted. */
export function findForbiddenGanttProps(source: string): string[] {
  const code = stripComments(source);
  return FORBIDDEN_GANTT_PROPS.filter((name) => new RegExp(`\\b${name}\\b`).test(code));
}

describe("guard: ProductionGantt.tsx keeps the #221 write boundary", () => {
  it("self-test: fires on each forbidden prop passed as JSX", () => {
    expect(findForbiddenGanttProps("<Gantt onEventsChange={setEvents} />")).toEqual(["onEventsChange"]);
    expect(findForbiddenGanttProps("<Gantt canDropEvent={(u) => ok(u)} />")).toEqual(["canDropEvent"]);
    expect(findForbiddenGanttProps("<Gantt enforceCanDrop />")).toEqual(["enforceCanDrop"]);
    expect(findForbiddenGanttProps("<Gantt enforceCanDrop={true} canDropEvent={f} onEventsChange={g} />")).toEqual(["canDropEvent", "enforceCanDrop", "onEventsChange"]);
  });

  it("self-test: fires on a spread object or a props variable, not only on a JSX attribute", () => {
    expect(findForbiddenGanttProps("<Gantt {...{ onEventsChange }} />")).toEqual(["onEventsChange"]);
    expect(findForbiddenGanttProps("const props = { canDropEvent: allow };\n<Gantt {...props} />")).toEqual(["canDropEvent"]);
  });

  it("self-test: ignores the names in comments, and ignores the allowed write props", () => {
    expect(findForbiddenGanttProps("/** `onEventsChange` is deliberately never passed. */\n<Gantt />")).toEqual([]);
    expect(findForbiddenGanttProps("// canDropEvent / enforceCanDrop are never passed\n<Gantt />")).toEqual([]);
    expect(findForbiddenGanttProps("<Gantt>{/* no onEventsChange here */}</Gantt>")).toEqual([]);
    expect(findForbiddenGanttProps("<Gantt onEventUpdate={handle} dropWarning={warn} onSelectSlot={place} canSelectSlot={placeable} />")).toEqual([]);
  });

  it("self-test: a comment strip keeps line numbers (block comments become blank lines)", () => {
    expect(stripComments("a\n/* x\ny */\nb").split("\n")).toHaveLength(4);
  });

  it("ProductionGantt.tsx is the writable surface this guard means (it passes onEventUpdate)", () => {
    expect(stripComments(productionGanttSource())).toMatch(/\bonEventUpdate=\{/);
  });

  it("ProductionGantt.tsx never passes onEventsChange, canDropEvent or enforceCanDrop", () => {
    const offenders = findForbiddenGanttProps(productionGanttSource());
    expect(
      offenders,
      [
        "ProductionGantt.tsx mentions a <Gantt> setting the #221 write boundary forbids:",
        "  - onEventsChange would let the vendor commit a range the server may refuse; every write is",
        "    \"deferred\" to the scheduling controller instead.",
        "  - canDropEvent / enforceCanDrop would block drops; production only warns (dropWarning).",
        ...offenders.map((name) => `  ${name}`),
      ].join("\n"),
    ).toEqual([]);
  });
});
