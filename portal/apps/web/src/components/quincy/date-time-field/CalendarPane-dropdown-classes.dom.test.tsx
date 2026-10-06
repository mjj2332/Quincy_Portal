import { act } from "react";
import { createRoot } from "react-dom/client";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it } from "vitest";
import { CalendarPane } from "./CalendarPane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => document.body.replaceChildren());

/**
 * #602: a `\_` in a plain JS string is just `_`, which Tailwind reads as a space in an arbitrary value, so
 * `[.rdp-dropdown_root]` never matched react-day-picker's `.rdp-dropdown_root`. The rendered class is
 * compiled through the installed Tailwind and must emit that exact selector for every sizing utility.
 */
describe("CalendarPane Month/Year select sizing classes (#602)", () => {
  it("compile to a selector on .rdp-dropdown_root, not on a descendant of .rdp-dropdown", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await act(async () => {
      createRoot(host).render(<CalendarPane selection={{ mode: "single", day: null }} today="2026-10-01" month={new Date(2026, 9, 1)} onMonthChange={() => {}} onPickDay={() => {}} startYear={2020} endYear={2030} />);
    });
    const classes = new Set<string>();
    for (const match of host.innerHTML.matchAll(/[^\s"]*\[\.rdp-dropdown[^\s"]*/g)) classes.add(match[0]);
    expect(classes.size).toBe(4);
    const compiler = await compile("@tailwind utilities;");
    const css = compiler.build([...classes]);
    expect(css).toContain(".rdp-dropdown_root");
    expect(css).not.toMatch(/\.rdp-dropdown root/);
    for (const utility of ["flex", "items-center", "min-h-"]) expect(css).toContain(utility);
  });
});
