// happy-dom does not prove PointerSensor / TouchSensor / KeyboardSensor activation, real collision geometry, autoscroll, scroll containers, link-click suppression, screen-reader delivery, browser focus timing, or active-drag DragOverlay rendering; those are QA-phase real-browser acceptance items.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanCardPreview } from "./ProjectKanbanBoard";
import type { ProjectSummary } from "../lib/kanban-interaction";

// The card renders "Due" or "Overdue" by comparing the deadline against `Date.now()`, so wall-clock
// time decides which word appears. Freeze it before the fixture deadline; otherwise this test passes
// until that date and then fails forever.
const testNow = new Date("2026-08-27T00:00:00.000Z");

const project: ProjectSummary = {
  id: "preview-project",
  street: "12 Preview Street",
  suburb: "Newtown",
  postcode: "2042",
  agencyName: "Quincy Realty",
  agentName: null,
  stageKey: "raw_review",
  shootDate: null,
  coverAssetId: null,
  receivedCount: 0,
  expectedCount: null,
  priority: null,
  boardRevision: 7,
  deadlineAt: Date.parse("2026-09-01T22:00:00.000Z"),
  deadlineLocalCivil: "2026-09-02T08:00",
  deadlineZone: "Australia/Sydney",
};

describe("KanbanCardPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: testNow });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a non-interactive copy with the card's street and deadline", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(KanbanCardPreview, { project }));
    expect(host.querySelector(".kcard__addr")?.textContent).toBe("12 Preview Street");
    expect(host.querySelector("time")?.textContent).toContain("Due 2026-09-02 08:00 Sydney");
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector("[data-focus-key]")).toBeNull();
    expect(host.querySelector("[id]")).toBeNull();
  });
});
