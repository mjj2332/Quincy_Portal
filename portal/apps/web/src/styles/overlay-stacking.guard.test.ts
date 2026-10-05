import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
const z = (css: string, name: string) => Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(css)?.[1]);

/** #463: the Calendar/Timeline item menu opens from inside the "+N more" popover (--z-popover), so a menu must stack above a popover and below a dialog. */
describe("overlay stacking contract", () => {
  const tokens = read("./tokens/spacing.css");
  it("orders popover < menu < dialog < toast", () => {
    expect(z(tokens, "menu")).toBeGreaterThan(z(tokens, "popover"));
    expect(z(tokens, "menu")).toBeLessThan(z(tokens, "dialog"));
    expect(z(tokens, "dialog")).toBeLessThan(z(tokens, "toast"));
  });
  it("the dropdown-menu positioner and popup use the menu token, not a magic number", () => {
    const src = read("../components/reui/dropdown-menu.tsx");
    const content = src.slice(src.indexOf("function DropdownMenuContent"), src.indexOf("function DropdownMenuGroup"));
    expect(content).toContain("z-[var(--z-menu)]");
    expect(content).not.toMatch(/\bz-50\b/);
  });
  it("the dialog overlay and content use the dialog token, never the registry's bare z-50 (a dialog opened from a sheet must stack above it)", () => {
    const src = read("../components/reui/dialog.tsx");
    const overlay = src.slice(src.indexOf("function DialogOverlay"), src.indexOf("function DialogContent"));
    const content = src.slice(src.indexOf("function DialogContent"), src.indexOf("function DialogHeader"));
    for (const part of [overlay, content]) {
      expect(part).toContain("z-[var(--z-dialog)]");
      expect(part).not.toMatch(/\bz-50\b/);
    }
  });
  it("the dialog overlay forces its Backdrop (every dialog sits inside a sheet Root, so Base UI treats it as nested and skips the scrim otherwise; #221, #493)", () => {
    const src = read("../components/reui/dialog.tsx");
    const overlay = src.slice(src.indexOf("function DialogOverlay"), src.indexOf("function DialogContent"));
    expect(overlay).toMatch(/\bforceRender\b/);
  });

  it("the base sheet keeps the registry's z-50: raising it would lift every sheet (calendar dialogs, the mobile sidebar) above the impersonation banner's Exit (#531, #500)", () => {
    const src = read("../components/reui/sheet.tsx");
    const overlay = src.slice(src.indexOf("function SheetOverlay"), src.indexOf("function SheetContent"));
    const content = src.slice(src.indexOf("function SheetContent"), src.indexOf("function SheetHeader"));
    for (const part of [overlay, content]) {
      expect(part).toMatch(/\bz-50\b/);
      expect(part).not.toContain("--z-dialog");
    }
  });

  it("the whiteboard History sheet (opened from inside the Project Workspace sheet, --z-dialog) passes the dialog token to its popup and scrim, and starts below the banner while impersonating (#500, #531)", () => {
    const src = read("../components/reui/whiteboard/board-panel.tsx");
    const sheet = src.slice(src.indexOf("<Sheet open"), src.indexOf("</SheetContent>"));
    const popupClass = /\n\s*className="([^"]*)"/.exec(sheet)?.[1] ?? "";
    const overlayClass = /overlayProps=\{\{[^}]*className: "([^"]*)"/.exec(sheet)?.[1] ?? "";
    for (const [name, cls] of [["popup", popupClass], ["scrim", overlayClass]] as const) {
      expect(cls, name).toContain("z-[var(--z-dialog)]");
      expect(cls, name).toContain("top-[var(--impersonation-banner-height)]");
    }
  });

  /** #531: the Impersonation banner must stay readable under a Project sheet / rail sheet scrim. */
  describe("impersonation banner (#531)", () => {
    const banner = read("../components/ImpersonationBanner.tsx");
    const appCss = read("./app.css");
    const bannerClasses = /const BANNER = ([\s\S]*?);\n/.exec(banner)?.[1] ?? "";
    it("the banner height comes from --impersonation-banner-height, never a literal 42px", () => {
      expect(bannerClasses).toContain("h-[var(--impersonation-banner-height)]");
      expect(bannerClasses).not.toContain("42px");
    });
    it("the banner stays below the dialog token (raising it would expose Exit to a modal's mouse users only)", () => {
      const literal = /z-\[(\d+)\]/.exec(bannerClasses)?.[1];
      const named = /z-\[var\(--z-([a-z]+)\)\]/.exec(bannerClasses)?.[1];
      const value = literal ? Number(literal) : named ? z(tokens, named) : NaN;
      expect(value).toBeLessThan(z(tokens, "dialog"));
    });
    it("no banner offset in app.css is a literal 42px", () => {
      const rules = appCss.replace(/\/\*[\s\S]*?\*\//g, "");
      const offenders = rules.split("\n").filter((line) => /impersonat/.test(line) && /42px/.test(line));
      expect(offenders).toEqual([]);
    });
    it("both scrims start below the banner while impersonating and keep a transparent shield over the strip", () => {
      for (const file of ["../components/quincy/ProjectSheet.tsx", "../components/quincy/RailSheet.tsx"]) {
        const src = read(file);
        expect(src, file).toContain("data-[impersonating]:top-[var(--impersonation-banner-height)]");
        expect(src, file).toContain("data-[impersonating]:before:h-[var(--impersonation-banner-height)]");
      }
    });

    /** #541: Exit is 44px tall at <=721px; the global ring (width + offset tokens) must fit inside the strip. */
    it("the banner is tall enough for the focus ring around Exit at every width", () => {
      const num = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(tokens)?.[1]);
      const ringSpace = 2 * (num("border-width-bold") + 2); // base.css `:focus-visible` offset is 2px
      const buttonSrc = read("../components/reui/button.tsx");
      const mobileButton = Number(/BUTTON_HEIGHT_CLASS = "[^"]*max-\[721px\]:min-h-\[(\d+)px\]/.exec(buttonSrc)?.[1]);
      const textButton = Number(/TEXT_BUTTON = "min-h-\[(\d+)px\]/.exec(read("../components/quincy/Button.tsx"))?.[1]);
      expect(mobileButton).toBe(44);
      const css = tokens.replace(/\/\*[\s\S]*?\*\//g, "");
      const base = Number(/--impersonation-banner-height:\s*(\d+)px/.exec(css)?.[1]);
      expect(base).toBeGreaterThanOrEqual(textButton + ringSpace);
      const media = /@media \(width < 721px\)\s*\{\s*:root\s*\{\s*--impersonation-banner-height:\s*(\d+)px/.exec(css);
      expect(media, "spacing.css needs `@media (width < 721px) { :root { --impersonation-banner-height: Npx } }`").not.toBeNull();
      expect(Number(media![1])).toBeGreaterThanOrEqual(mobileButton + ringSpace);
      expect(Number(media![1]), "phone banner is 56px: 44px Exit + ring + ~2px ink clearance each side").toBe(56);
    });
  });
});
