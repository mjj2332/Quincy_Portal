/**
 * Container-focus guard (#598 #607 #599). Base UI focuses a popup/sheet container (tabIndex -1) on open, and
 * after a keyboard open Chrome treats that as `:focus-visible`; `tokens/base.css`'s unlayered global ring
 * would outline the whole container. The container carries `focus-visible:!outline-none` (the `!` beats the
 * unlayered rule), following `NotificationBell`'s panel. Controls inside keep their own ring.
 * Source-text guard: happy-dom resolves no cascade, so no DOM test can see this.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { constInitialiser, functionBody, openingTag } from "@/testing/source-extract";

const webSrc = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(webSrc, rel), "utf8");
const RING_OFF = "focus-visible:!outline-none";

describe("programmatically focused containers carry focus-visible:!outline-none", () => {
  it("DateTimePopoverContent", () => {
    const tag = openingTag(read("components/quincy/DateTimeField.tsx"), "PopoverContent", "aria-describedby={zoneId}");
    expect(tag, "DateTimePopoverContent's PopoverContent not found").not.toBeNull();
    expect(tag).toContain(RING_OFF);
  });
  it("ProjectSheet's SheetContent", () => {
    const tag = openingTag(read("components/quincy/ProjectSheet.tsx"), "SheetContent", 'data-testid="project-sheet"');
    expect(tag, "ProjectSheet's SheetContent not found").not.toBeNull();
    expect(tag).toContain(RING_OFF);
  });
  it("POPOVER_CONTENT", () => {
    const init = constInitialiser(read("components/project-header-popover.ts"), "POPOVER_CONTENT");
    expect(init, "POPOVER_CONTENT not found").not.toBeNull();
    expect(init).toContain(RING_OFF);
  });
  it("NotificationBell's panel", () => {
    const tag = openingTag(read("components/quincy/NotificationBell.tsx"), "PopoverContent", 'data-testid="rail-notifications-panel"');
    expect(tag, "NotificationBell's PopoverContent not found").not.toBeNull();
    expect(tag).toContain(RING_OFF);
  });
  it("RailSheet's SheetContent", () => {
    const tag = openingTag(read("components/quincy/RailSheet.tsx"), "SheetContent", 'data-testid="rail-sheet"');
    expect(tag, "RailSheet's SheetContent not found").not.toBeNull();
    expect(tag).toContain(RING_OFF);
  });
  it("Modal's panelClasses", () => {
    const body = functionBody(read("components/Modal.tsx"), "panelClasses");
    expect(body, "panelClasses not found").not.toBeNull();
    expect(body).toContain(RING_OFF);
    expect(body, "dead `focus:outline-none` loses to the unlayered ring").not.toMatch(/(?<![-\w])focus:outline-none/);
  });

  describe("function-body extractor fixtures", () => {
    const BROKEN = 'function panelClasses(a: X | undefined, b: boolean): string {\n  return cn("w-full", "focus:outline-none");\n}\nfunction other() { return "focus-visible:!outline-none"; }';
    const FIXED = 'function panelClasses(a: X | undefined, b: boolean): string {\n  return cn("w-full", "focus-visible:!outline-none");\n}';
    it("fails on a body without the class, and does not read the next function", () => {
      expect(functionBody(BROKEN, "panelClasses")).not.toContain(RING_OFF);
    });
    it("passes with the class", () => {
      expect(functionBody(FIXED, "panelClasses")).toContain(RING_OFF);
    });
    it("ignores the class when it is only in a comment", () => {
      const inComment = 'function panelClasses(a: X): string {\n  // focus-visible:!outline-none\n  /* focus-visible:!outline-none */\n  return cn("focus:outline-none");\n}';
      expect(functionBody(inComment, "panelClasses")).not.toContain(RING_OFF);
    });
    it("does not match a function whose name merely starts with the target", () => {
      const prefixed = 'function panelClassesX(a: X): string {\n  return cn("focus:outline-none");\n}\nfunction panelClasses(a: X): string {\n  return cn("focus-visible:!outline-none");\n}';
      expect(functionBody(prefixed, "panelClasses")).toContain(RING_OFF);
      expect(functionBody('function panelClassesX() { return 1; }', "panelClasses")).toBeNull();
    });
    it("returns null when the function is gone", () => {
      expect(functionBody("const x = 1;", "panelClasses")).toBeNull();
    });
  });

  describe("extractor fixtures", () => {
    const BROKEN = '<SheetContent data-testid="project-sheet" className="gap-0 p-0">child</SheetContent>';
    const FIXED = '<SheetContent data-testid="project-sheet" className="gap-0 p-0 focus-visible:!outline-none">child</SheetContent>';
    it("fails on a container without the class", () => {
      expect(openingTag(BROKEN, "SheetContent", 'data-testid="project-sheet"')).not.toContain(RING_OFF);
    });
    it("passes with it, and ignores the class when it is only in the children", () => {
      expect(openingTag(FIXED, "SheetContent", 'data-testid="project-sheet"')).toContain(RING_OFF);
      const inChild = '<SheetContent data-testid="project-sheet" className="p-0"><b className="focus-visible:!outline-none"/></SheetContent>';
      expect(openingTag(inChild, "SheetContent", 'data-testid="project-sheet"')).not.toContain(RING_OFF);
    });
    it("ignores the class when it is only in a comment inside the tag (Sol)", () => {
      const inComment =
        '<SheetContent data-testid="project-sheet"\n  // `focus-visible:!outline-none`: see NotificationBell.\n  /* focus-visible:!outline-none */\n  className="p-0">x</SheetContent>';
      expect(openingTag(inComment, "SheetContent", 'data-testid="project-sheet"')).not.toContain(RING_OFF);
    });
    it("returns null when the marker is gone", () => {
      expect(openingTag("<div/>", "SheetContent", "x")).toBeNull();
      expect(constInitialiser("const OTHER = 'x';", "POPOVER_CONTENT")).toBeNull();
    });
  });
});
