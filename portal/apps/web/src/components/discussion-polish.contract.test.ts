/**
 * #604 as source contracts: happy-dom applies no stylesheet, so these read the component source.
 * 1 the read-only notice is `w-fit` (its focus ring must hug the text, not span the column).
 * 2 the rail-layout grid gives a spanning rail's extra height to the panels row, not the tabs strip.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const notice = readFileSync(join(here, "archived-notice.ts"), "utf8");
const panel = readFileSync(join(here, "ProjectCollaborationPanel.tsx"), "utf8");

describe("discussion polish (#604)", () => {
  it("1: ARCHIVED_NOTICE_CLASS is w-fit", () => {
    expect(notice).toMatch(/ARCHIVED_NOTICE_CLASS = "[^"]*\bw-fit\b/);
  });
  it("2: in the rail layout the panels row is the flexible row, so a tall rail cannot stretch the tabs strip", () => {
    expect(panel).toContain("data-[checklist-layout=rail]:[grid-template-rows:auto_auto_1fr]");
    expect(panel).toContain("data-[checklist-layout=rail]:[grid-template-rows:auto_1fr]");
  });
});

describe("EditProject Danger-zone dialogs (#604)", () => {
  const edit = readFileSync(join(here, "../screens/EditProject.tsx"), "utf8");
  const dialog = readFileSync(join(here, "ConfirmDeleteDialog.tsx"), "utf8");
  it("Restore and Delete permanently both use size=\"default\" (the 'sm' two-column footer clips the uppercase label)", () => {
    expect(edit).toContain('<AlertDialogContent size="default" data-testid="restore-project-confirm">');
    expect(edit).toMatch(/<ConfirmDeleteDialog[\s\S]*?testIdPrefix="project-delete" size="default" \/>/);
    expect(edit).not.toContain('size="sm"');
  });
  it("ConfirmDeleteDialog defaults to sm and forwards size", () => {
    expect(dialog).toContain('size = "sm"');
    expect(dialog).toContain("<AlertDialogContent size={size}");
  });
});
