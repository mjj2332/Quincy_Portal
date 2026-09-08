/**
 * Scroll-selector guard — pins the `.kanban` class to the semantic board root as SOURCE TEXT,
 * not a DOM query.
 *
 * `ProjectKanbanBoard.tsx` reaches its scroll container through
 * `document.querySelector<HTMLElement>(".kanban")` at three runtime sites — `restoreBoardScroll`
 * and the drag-start scroll snapshot (two call sites). The literal class token `kanban` is
 * declared exactly once, on the board root, buried mid-way through a ~40-token Tailwind class
 * string on the element that also carries `data-focus-key="board"` and
 * `aria-label="Project pipeline board"`.
 *
 * Nothing else in the suite pins those two facts together. Every board `.dom.test.tsx` test
 * locates the root by aria-label or `data-focus-key` — deliberately, per issue #50, which forbids
 * DOM tests from selecting elements by Quincy class name (`test-seam.guard.test.ts`, guard A). A
 * `.dom.test.tsx` assertion equivalent to this one was tried first and rejected for exactly that
 * reason (issue #55, round 1) — it collided head-on with guard A's permanent, shrink-only
 * baseline. This file is the route around that: guard A only walks `*.dom.test.tsx`, and this is
 * a `.test.ts` that reads component source as text and never touches the DOM, so it is outside
 * guard A's scope by construction — the same technique `test-seam.guard.test.ts` and
 * `src/config/reui-registry.guard.test.ts` already use for their own source-text checks.
 *
 * Without this guard, a re-skin that rewrites the board root's class string and drops `kanban`
 * leaves every DOM test green while silently breaking drag scroll capture and restore. No error,
 * no console warning — the board just forgets its scroll position on every drop.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const componentSourcePath = join(fileURLToPath(new URL(".", import.meta.url)), "ProjectKanbanBoard.tsx");

function componentSource(): string {
  return readFileSync(componentSourcePath, "utf8");
}

/** A `querySelector`/`querySelectorAll` call whose selector literal is exactly `.kanban`. */
const KANBAN_QUERY_SELECTOR = /\.querySelector(?:All)?\s*(?:<[^>]*>)?\s*\(\s*(["'`])\.kanban\1\s*\)/g;

function countKanbanQuerySelectors(source: string): number {
  return [...source.matchAll(KANBAN_QUERY_SELECTOR)].length;
}

/**
 * Extracts the full JSX opening tag that contains `marker` in its source text — scanning from the
 * nearest preceding `<` to the matching `>`, tracking `{…}` depth so a JSX expression container
 * holding a stray `>` (a generic, a comparison) cannot end the tag early. Does NOT hard-code a
 * line number: a line number in an assertion is a guard that breaks on reformatting rather than on
 * the defect it exists to catch.
 */
function findTagContaining(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) throw new Error(`marker not found in component source: ${marker}`);
  const tagStart = source.lastIndexOf("<", markerIndex);
  if (tagStart === -1) throw new Error(`no opening \`<\` found before marker: ${marker}`);

  let depth = 0;
  for (let index = tagStart; index < source.length; index++) {
    const char = source[index];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0) return source.slice(tagStart, index + 1);
  }
  throw new Error(`no matching \`>\` found for tag starting at index ${tagStart} (marker: ${marker})`);
}

/**
 * Does this JSX opening tag's `className` carry `kanban` as a standalone, whitespace-delimited
 * token? A substring match would pass on `kanban-column` or `kanban-card` — both real class/
 * data-testid fragments elsewhere in this file — so the token is split on whitespace first.
 *
 * Exported so the "prove a gate can fail before trusting it" fixtures below (and any future
 * consumer) can exercise it directly, per this repo's rule (lessons.md, "A grep gate that cannot
 * fail is not a gate — twice in two releases").
 */
export function tagHasKanbanClass(tagSource: string): boolean {
  const match = tagSource.match(/\bclassName\s*=\s*"([^"]*)"/);
  if (!match) return false;
  return match[1]!.split(/\s+/).includes("kanban");
}

describe("guard: the `.kanban` runtime scroll selector still has something to select", () => {
  it("finds at least one `document.querySelector(\".kanban\")` call in ProjectKanbanBoard.tsx", () => {
    const count = countKanbanQuerySelectors(componentSource());
    expect(
      count,
      [
        "No `querySelector(\".kanban\")` call sites remain in ProjectKanbanBoard.tsx.",
        "",
        "`restoreBoardScroll` and the drag-start scroll snapshot used to reach the scroll container",
        "through this literal class selector. If every call site has been rewritten to use a stable",
        "identifier instead (e.g. a ref, or a data-focus-key lookup), this guard has nothing left to",
        "protect and should be DELETED, not weakened — do not lower this assertion to `>= 0`.",
      ].join("\n"),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("guard: the `.kanban` selector and the semantic board root are the same element", () => {
  it("keeps `kanban` as a standalone class token on the element carrying data-focus-key=\"board\"", () => {
    const tag = findTagContaining(componentSource(), 'data-focus-key="board"');
    expect(
      tagHasKanbanClass(tag),
      [
        "The board root (the element with data-focus-key=\"board\" and",
        "aria-label=\"Project pipeline board\") no longer carries the literal `kanban` class token.",
        "",
        "`restoreBoardScroll` and the drag-start scroll snapshot in ProjectKanbanBoard.tsx locate the",
        "scroll container with `document.querySelector<HTMLElement>(\".kanban\")`. Every DOM test in",
        "this suite finds the board by aria-label or data-focus-key instead (issue #50), so dropping",
        "the `kanban` token from this element's class string leaves the entire DOM suite green while",
        "silently breaking drag scroll capture and restore. Put `kanban` back on the board root's",
        "className, or — if the runtime selector itself has moved off `.kanban` — update BOTH the",
        "call sites and this guard together.",
        "",
        `Tag inspected: ${tag}`,
      ].join("\n"),
    ).toBe(true);
  });
});

describe("guard: tagHasKanbanClass can fail — proof against fixtures", () => {
  const TAG_WITH_TOKEN =
    '<div className="kanban grid grid-flow-col auto-cols-[minmax(244px,1fr)]" data-focus-key="board" tabIndex={-1} aria-label="Project pipeline board">';
  const TAG_WITHOUT_TOKEN =
    '<div className="grid grid-flow-col auto-cols-[minmax(244px,1fr)]" data-focus-key="board" tabIndex={-1} aria-label="Project pipeline board">';
  const TAG_WITH_SUBSTRING_ONLY =
    '<div className="kanban-column grid grid-flow-col auto-cols-[minmax(244px,1fr)]" data-focus-key="board" tabIndex={-1} aria-label="Project pipeline board">';

  it("returns true for a tag whose className carries the bare `kanban` token", () => {
    expect(tagHasKanbanClass(TAG_WITH_TOKEN)).toBe(true);
  });

  it("returns false once the `kanban ` token is removed from the same tag", () => {
    expect(tagHasKanbanClass(TAG_WITHOUT_TOKEN)).toBe(false);
  });

  it("returns false for a className that contains `kanban-column` but not bare `kanban` (the substring trap)", () => {
    expect(tagHasKanbanClass(TAG_WITH_SUBSTRING_ONLY)).toBe(false);
  });
});
