/**
 * TB8-07 regression guards.
 *
 * Each test here locks in one defect this release fixed, at the level the defect actually lived.
 * They are deliberately collected in one file rather than scattered: every one of them guards a
 * bug that was *invisible* until it was measured — an invisible control, an inherited `inherit`,
 * a class that looked dead but was a live focus hook — and a future sweep reading any single
 * component will not see why the current shape matters. See
 * `docs/plans/TB8-07-Collaboration-Checklist-Discussion-Visual-Plan.md` §12.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

describe("TB8-07 — the schedule/assignee triggers are visible without hover (§2.2)", () => {
  // The defect: `.subtask-checklist__metadata-trigger { opacity: .06 }` revealed only on
  // `:hover`/`:focus-within`. That is 1.10:1 — indistinguishable from the row background — and a
  // phone has no hover, so at 390px there was NO visible way to schedule or assign a subtask.
  // The fix was to delete the hover-reveal mechanic outright rather than tune its opacity.
  const source = read("./SubtaskChecklist.tsx");

  it("never dims a metadata trigger with an opacity utility", () => {
    expect(source).not.toMatch(/opacity-\[?\.?0?6/);
    expect(source).not.toMatch(/opacity-\[\.72\]/);
  });

  it("keeps no hover-reveal class on any element, or in the stylesheet", () => {
    // Matched against `className=` values rather than the whole file: a prose comment mentioning
    // the retired class by name is fine (and useful), a live one is not.
    for (const value of source.match(/className=\{?[^}\n]*/g) ?? []) {
      expect(value).not.toContain("subtask-checklist__metadata-trigger");
    }
    expect(read("../styles/app.css")).not.toContain("metadata-trigger");
  });
});

describe("TB8-07 — the schedule conflict paints as a warning (§2.4)", () => {
  // The defect: `.subtask-schedule__conflict { color: var(--signal-warning) }`, and
  // `--signal-warning` is defined NOWHERE. Because `color` is inherited, an invalid value falls
  // back to `inherit` — NOT to the `--signal-critical` set on the line above — so the
  // "someone else edited this first" warning rendered as ordinary ink body text.
  // Generalised at TB8-09: --signal-warm and --panel were the same bug, found on the Lightbox.
  // Each was used and defined nowhere, surviving only because it carried a literal fallback that
  // happened to be correct. --signal-warning had no fallback and so rendered as inherited ink for
  // its whole life. A list, so the next one is a one-line addition rather than a new test.
  it.each(["--signal-warning", "--signal-warm", "--panel"])(
    "still has no %s token anywhere (the fix is never to define it)",
    (token) => {
      for (const file of ["../styles/tokens/colors.css", "../styles/app.css"]) {
        expect(read(file)).not.toContain(token);
      }
    },
  );

  it("renders the conflict through Notice's caution tone", () => {
    expect(read("./SubtaskChecklist.tsx")).toContain('<Notice tone="caution"');
  });

  it("gives Notice a caution tone that splits text from border and wash", () => {
    // `--signal-caution` is the one signal too light to carry small text; the darkened
    // `--signal-caution-text` is 6.65:1 on white while the border and wash keep the brand ochre.
    const notice = read("./quincy/Notice.tsx");
    expect(notice).toContain("caution:");
    expect(notice).toContain("text-signal-caution-text");
    expect(notice).toContain("border-signal-caution/");
  });
});

describe("TB8-07 — the unavailable collaboration page is in flow (§2.5)", () => {
  // The defect: `CollaborationOnlyUnavailable` rendered
  // `className="project-collaboration project-collaboration--unavailable"`. `--unavailable` has
  // no rule of its own, so it inherited the real panel's `position: fixed`, `z-index: 70`,
  // `width: min(460px,…)` and `box-shadow` — while the `--project-collaboration-*` custom
  // properties those rules consume are declared on `__wrap`, which is not an ancestor of this
  // page. `top`/`bottom`/`max-height` therefore fell back to `auto`, leaving a 460px
  // hard-shadowed fixed panel floating over the one screen that exists to say "this is gone".
  const source = read("../screens/ProjectWorkspace.tsx");
  const unavailable = source.slice(source.indexOf("function CollaborationOnlyUnavailable"));
  const body = unavailable.slice(0, unavailable.indexOf("\n}"));

  it("does not borrow the fixed overlay's class", () => {
    expect(body).not.toContain('className="project-collaboration');
    expect(body).not.toContain("project-collaboration--unavailable");
  });

  it("retires the --unavailable modifier from the stylesheet too", () => {
    expect(read("../styles/app.css")).not.toContain("project-collaboration--unavailable");
  });
});

describe("TB8-07 — retired classes that are still load-bearing", () => {
  it("keeps .subtask-checklist__title-trigger on the element for focus restoration", () => {
    // Its CSS rule is retired, but `remove()` does
    // `querySelector(".subtask-checklist__title-trigger").focus()` to restore focus to the next
    // row after a delete. Retiring the class as well would break that silently — no error, no
    // failing type, just focus landing on <body>.
    const source = read("./SubtaskChecklist.tsx");
    expect(source).toContain('"subtask-checklist__title-trigger"');
    expect(source).toContain('querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")');
    expect(read("../styles/app.css")).not.toContain("subtask-checklist__title-trigger");
  });

  it("keeps rich-text__editor-content on the ProseMirror element", () => {
    // Nine retained prose selectors in app.css are scoped THROUGH this class. Replacing it with
    // the utility string (rather than appending) would unstyle every heading, list and task item
    // inside the composer while leaving them correct in the posted comment — the exact
    // two-renderer divergence the retained CSS block exists to prevent.
    expect(read("./RichTextEditor.tsx")).toContain('class: "rich-text__editor-content "');
    expect(read("../styles/app.css")).toContain(".rich-text__editor-content ul[data-type=\"taskList\"]");
  });
});

describe("TB8-07 — ARIA that was deliberately NOT changed", () => {
  it("keeps the rich-text validation region polite, never an alert", () => {
    // `FieldError` would have been the tidy substitution, but it injects `role="alert"`, turning
    // a polite live region into an assertive one that interrupts a screen-reader user mid-typing.
    const source = read("./RichTextEditor.tsx");
    const validation = source.slice(source.indexOf("min-h-[1.2em]"));
    expect(validation.slice(0, 200)).toContain('aria-live="polite"');
    expect(validation.slice(0, 200)).not.toContain('role="alert"');
  });

  it("keeps <time dateTime> as a real time element in both ledgers", () => {
    // `<Eyebrow>` is hard-coded to a `<span>`; substituting it would have dropped `dateTime`.
    for (const file of ["./ProjectDiscussionThread.tsx", "./ProjectActivityView.tsx"]) {
      expect(read(file)).toMatch(/<time[^>]*dateTime=/);
    }
  });
});

describe("TB8-07 — the app.css retirement is complete (§8c)", () => {
  const css = read("../styles/app.css");

  it("leaves no collaboration, checklist, mention or rich-text-chrome selector behind", () => {
    for (const dead of [
      "subtask-checklist", "subtask-popover", "subtask-schedule",
      "mention-autocomplete", "rich-text__toolbar", "rich-text__counter",
      "rich-text__validation", "rich-text-editor", "project-activity-view",
      "project-collaboration__head", "project-collaboration__scroll",
      "project-collaboration__tabs", "project-collaboration__panel",
      "project-collaboration__unread", "project-collaboration__comment",
      "project-collaboration__state", "project-collaboration__read-anchor",
      "project-collaboration-summary", "project-collaboration-only",
    ]) {
      expect(css, `${dead} should be retired`).not.toContain(dead);
    }
  });

  it("keeps the two blocks that are deliberately still CSS, with their reasons recorded", () => {
    // The prose block (two renderers must agree on one stored document) and the panel geometry
    // (eight interacting env()/custom-property declarations). Both carry a comment saying so, so
    // the next sweep reads them as decisions rather than leftovers.
    expect(css).toContain(".rich-text__task-item");
    expect(css).toContain(".project-collaboration__wrap");
    expect(css).toContain("KEPT AS CSS DELIBERATELY");
    expect(css).toContain("kept as CSS deliberately");
  });
});

afterEach(() => { /* these tests read source files only — nothing to tear down */ });
