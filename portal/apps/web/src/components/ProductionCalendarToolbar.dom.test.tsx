import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardCalendarState } from "@quincy/shared";
import { ProductionCalendarToolbar } from "./ProductionCalendarToolbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calendar = (subview: DashboardCalendarState["subview"] = "month", date = "2026-08-12"): DashboardCalendarState => ({
  view: "calendar", date, subview, layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [],
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
});

describe("ProductionCalendarToolbar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  function renderToolbar(value = calendar(), range = { start: "2026-07-27", end: "2026-09-07" }, now: Date | number | string = "2026-08-12T00:00:00.000Z") {
    const onNavigate = vi.fn();
    act(() => { root.render(<ProductionCalendarToolbar calendar={value} range={range} now={now} onNavigate={onNavigate} />); });
    return onNavigate;
  }

  it("emits month previous/next and Sydney Today dates", () => {
    const onNavigate = renderToolbar();
    (host.querySelector('button[aria-label="Previous period"]') as HTMLButtonElement).click();
    (host.querySelector('button[aria-label="Next period"]') as HTMLButtonElement).click();
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Today")?.click();
    expect(onNavigate.mock.calls.map(([next]) => next.date)).toEqual(["2026-07-01", "2026-09-01", "2026-08-12"]);
  });

  it("uses seven-day Week and fourteen-day Agenda navigation", () => {
    const week = renderToolbar(calendar("week"), { start: "2026-08-10", end: "2026-08-17" });
    (host.querySelector('button[aria-label="Previous period"]') as HTMLButtonElement).click();
    expect(week.mock.calls[0]?.[0].date).toBe("2026-08-05");
    act(() => { root.render(<ProductionCalendarToolbar calendar={calendar("agenda")} range={{ start: "2026-08-12", end: "2026-08-26" }} onNavigate={week} />); });
    (host.querySelector('button[aria-label="Next period"]') as HTMLButtonElement).click();
    expect(week.mock.calls[1]?.[0].date).toBe("2026-08-26");
  });

  it("emits subview changes", () => {
    const onNavigate = renderToolbar();
    host.querySelector('button[aria-pressed="false"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNavigate.mock.calls[0]?.[0].subview).toBe("week");
  });

  it.each([
    [{ start: "2026-07-27", end: "2026-09-07" }, "AEST"],
    [{ start: "2026-01-05", end: "2026-01-19" }, "AEDT"],
    [{ start: "2026-03-30", end: "2026-04-13" }, "AEST/AEDT"],
    [{ start: "2026-09-28", end: "2026-10-12" }, "AEST/AEDT"],
  ])("labels the active Sydney range (%o)", (range, expected) => {
    renderToolbar(calendar(), range);
    const toolbar = host.querySelector('[role="toolbar"]')!;
    expect(toolbar.textContent).toContain(`Sydney time · ${expected}`);
    expect(toolbar.getAttribute("aria-label")).toContain(`Sydney time · ${expected}`);
  });
});
