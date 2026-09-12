import { describe, expect, it } from "vitest";
import { initializeDashboardCalendarState, initializeDashboardView, type DashboardView } from "./dashboard-helpers";
import { shouldInterceptInternalLink } from "../lib/router";

// #83: the card-level markup suite this file used to carry (anchor/retry-button siblings, ordering
// controls outside the link) was ported onto `KanbanCard2` in commit A — see
// `components/kanban2/board.dom.test.tsx`'s "KanbanCard2 — anchor and interactive-control siblings
// (#83)" describe, specifically "keeps the cover-retry button a sibling of the project link, not
// inside it" and "keeps the Board's non-drag controls (arrows, Move to…) outside the project link".
//
// The 4-case priority × reorder matrix this file also carried is retired, not ported, because the
// capability split moved off the card onto the Board: `components/kanban2/board.tsx:184,463` gate
// the arrows and `:458` gates priority, and both halves are covered by
// `components/kanban2/board.dom.test.tsx:216` and `:576`. Porting it as written would require
// `KanbanCard2` to re-acquire a `canReorder` prop it deliberately does not have.

describe("TB6 Slice 0 dashboard routing characterization", () => {
  it("reads and remembers List/Kanban preferences in quincy:dashboard:view while Calendar remains a URL state", () => {
    const writes: Array<[string, string]> = [];
    const storage = {
      read: () => "list",
      write: (view: DashboardView) => writes.push(["quincy:dashboard:view", view]),
    };
    expect(initializeDashboardView(storage)).toBe("list");
    expect(writes).toEqual([["quincy:dashboard:view", "list"]]);

    expect(initializeDashboardView({ read: () => "kanban", write: storage.write })).toBe("kanban");
    expect(initializeDashboardView({ read: () => "calendar", write: storage.write })).toBe("calendar");
    expect(initializeDashboardView({ read: () => null, write: storage.write })).toBe("kanban");
  });

  it("lets a parsed Calendar route own date/subview and otherwise reads remembered Calendar preferences", () => {
    const writes: Array<[string, string]> = [];
    const storage = {
      read: (key: string) => key.endsWith("subview") ? "agenda" : "2026-08-31",
      write: (key: string, value: string) => writes.push([key, value]),
    };
    const fromUrl = {
      kind: "dashboard" as const,
      calendar: {
        view: "calendar" as const, date: "2026-09-01", subview: "week" as const, layers: ["project"] as ["project"],
        editorIds: [], includeUnassigned: false, stageKeys: [], showCompletedChecklist: false,
        showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
      },
    };
    expect(initializeDashboardCalendarState(fromUrl, storage, { now: "2026-08-01T00:00:00Z", isPhone: false })).toEqual(fromUrl.calendar);
    expect(writes).toEqual([]);
    expect(initializeDashboardCalendarState({ kind: "dashboard" }, storage, { now: "2026-08-01T00:00:00Z", isPhone: false })).toMatchObject({ date: "2026-08-31", subview: "agenda", view: "calendar" });
    expect(writes).toHaveLength(2);
  });

  it("keeps modified-click and keyboard detail=0 clicks native", () => {
    const click = (overrides: Partial<Parameters<typeof shouldInterceptInternalLink>[0]> = {}) => ({
      button: 0, detail: 1, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      currentTarget: { href: "https://portal.test/projects/123e4567-e89b-42d3-a456-426614174000", target: "", download: "" },
      ...overrides,
    });
    expect(shouldInterceptInternalLink(click(), "https://portal.test")).toBe(true);
    expect(shouldInterceptInternalLink(click({ detail: 0 }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ metaKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ ctrlKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ shiftKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ altKey: true }), "https://portal.test")).toBe(false);
    expect(shouldInterceptInternalLink(click({ button: 1 }), "https://portal.test")).toBe(false);
  });
});
