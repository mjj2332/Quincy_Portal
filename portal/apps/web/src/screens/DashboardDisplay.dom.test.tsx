/**
 * #431 -- the Display menu's view-supplied content and the Table's per-viewer preferences hook.
 * `DashboardViewBar` owns the trigger and popup; the view passes its content through the `display`
 * slot. Queried by role and accessible name only (test-seam F).
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardViewBar } from "./DashboardViewBar";
import { BoardDisplayContent, TableDisplayContent } from "./DashboardDisplay";
import { chooseGroupBy, columnCheckboxLabels, columnCheckboxes, displayMenu, displayTrigger, groupByRadios, openDisplay, sortRadioLabels, toggleColumn } from "./dashboard-display-test-helpers";
import { hideableColumnsFor, tablePrefsKey, type TableGroupBy, type HideableColumnId } from "../lib/dashboard-table-model";
import { useDashboardTablePrefs } from "../lib/use-dashboard-table-prefs";
import { __resetDashboardSearchStoreForTest } from "../lib/dashboard-search-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

let storageValues: Map<string, string>;
let storageBroken = false;

function installStorage() {
  storageValues = new Map();
  storageBroken = false;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => { if (storageBroken) throw new Error("denied"); return storageValues.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (storageBroken) throw new Error("denied"); storageValues.set(key, value); },
      removeItem: (key: string) => void storageValues.delete(key),
    },
  });
}

function Bar({ principalId, role = "admin", view = "table" }: { principalId: string; role?: "admin" | "external_editor"; view?: "table" | "board" | "calendar" }) {
  const { prefs, update } = useDashboardTablePrefs(principalId);
  const [sort, setSort] = useState<"board" | "priority" | "shootDate-asc" | "shootDate-desc">("board");
  const hideable = hideableColumnsFor(role);
  const display = view === "table"
    ? <TableDisplayContent groupBy={prefs.groupBy} onGroupByChange={(groupBy: TableGroupBy) => update({ groupBy })} hiddenColumns={prefs.hiddenColumns} hideableColumns={hideable}
        onColumnVisibilityChange={(column: HideableColumnId, visible) => update({ hiddenColumns: visible ? prefs.hiddenColumns.filter((id) => id !== column) : [...prefs.hiddenColumns, column] })} />
    : view === "board" ? <BoardDisplayContent sort={sort} canSortByPriority={false} onSortChange={setSort} /> : undefined;
  return (
    <div>
      <DashboardViewBar renderedView={view} canViewProductionCalendar disabled={false} onSelectView={() => undefined} principalId={principalId} searchFocusRequest={null} onSearchFocusHandled={() => undefined} display={display} />
      <output data-testid="prefs">{JSON.stringify(prefs)}</output>
    </div>
  );
}

describe("Display menu content and Table preferences (#431)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installStorage();
    __resetDashboardSearchStoreForTest();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
  });

  const render = async (node: React.ReactNode) => { await act(async () => { root.render(node); await Promise.resolve(); }); };
  const prefsText = () => JSON.parse(host.querySelector('[data-testid="prefs"]')!.textContent!) as { groupBy: string; hiddenColumns: string[] };

  it("offers Group by None/Stage/Client and every column but Address, with Group by defaulting to None", async () => {
    await render(<Bar principalId="u1" />);
    await openDisplay();
    expect(groupByRadios().map((radio) => radio.textContent)).toEqual(["None", "Stage", "Client"]);
    expect(groupByRadios().find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent).toBe("None");
    expect(columnCheckboxLabels()).toEqual(["Stage", "Client", "Shoot date", "Deadline", "Editors", "Priority", "RAW received"]);
    expect(columnCheckboxes().every((item) => item.getAttribute("aria-checked") === "true")).toBe(true);
  });

  it("keeps the menu open across a Group by change and several column toggles, and persists them per viewer", async () => {
    await render(<Bar principalId="u1" />);
    await chooseGroupBy("Client");
    expect(displayMenu()).not.toBeNull();
    await toggleColumn("Editors");
    await toggleColumn("Priority");
    expect(displayMenu()).not.toBeNull();
    expect(prefsText()).toEqual({ groupBy: "client", hiddenColumns: ["editors", "priority"] });
    expect(JSON.parse(storageValues.get(tablePrefsKey("u1"))!)).toEqual({ groupBy: "client", hiddenColumns: ["editors", "priority"] });
    expect(storageValues.has(tablePrefsKey("u2"))).toBe(false);
  });

  it("offers an External Editor no Priority column", async () => {
    await render(<Bar principalId="u1" role="external_editor" />);
    await openDisplay();
    expect(columnCheckboxLabels()).not.toContain("Priority");
    expect(columnCheckboxLabels()).not.toContain("Address");
  });

  it("restores the stored choice for the same viewer and reads another viewer's key on an identity switch", async () => {
    storageValues.set(tablePrefsKey("u1"), JSON.stringify({ groupBy: "stage", hiddenColumns: ["raw"] }));
    await render(<Bar principalId="u1" />);
    expect(prefsText()).toEqual({ groupBy: "stage", hiddenColumns: ["raw"] });
    await render(<Bar principalId="u2" />);
    expect(prefsText()).toEqual({ groupBy: "none", hiddenColumns: [] });
    // Nothing was written for u2 by merely arriving, and u1's value is untouched.
    expect(storageValues.has(tablePrefsKey("u2"))).toBe(false);
    expect(JSON.parse(storageValues.get(tablePrefsKey("u1"))!)).toEqual({ groupBy: "stage", hiddenColumns: ["raw"] });
    await chooseGroupBy("Client");
    expect(JSON.parse(storageValues.get(tablePrefsKey("u2"))!)).toEqual({ groupBy: "client", hiddenColumns: [] });
    expect(JSON.parse(storageValues.get(tablePrefsKey("u1"))!)).toEqual({ groupBy: "stage", hiddenColumns: ["raw"] });
  });

  it("reads a corrupt stored value as the defaults", async () => {
    storageValues.set(tablePrefsKey("u1"), JSON.stringify({ groupBy: "weird", hiddenColumns: ["address", "nope", "raw"] }));
    await render(<Bar principalId="u1" />);
    expect(prefsText()).toEqual({ groupBy: "none", hiddenColumns: ["raw"] });
    storageValues.set(tablePrefsKey("u1"), "{not json");
    await render(<Bar principalId="u9" />);
    await render(<Bar principalId="u1" />);
    expect(prefsText()).toEqual({ groupBy: "none", hiddenColumns: [] });
  });

  it("still works in memory when storage throws", async () => {
    storageBroken = true;
    await render(<Bar principalId="u1" />);
    expect(prefsText()).toEqual({ groupBy: "none", hiddenColumns: [] });
    await chooseGroupBy("Stage");
    expect(prefsText().groupBy).toBe("stage");
  });

  it("the Board slot holds the sort radios and no Group by, and a view with no slot disables Display", async () => {
    await render(<Bar principalId="u1" view="board" />);
    await openDisplay();
    expect(sortRadioLabels()).toEqual(["Board order", "Shoot date, earliest first", "Shoot date, latest first"]);
    expect(groupByRadios()).toHaveLength(0);
    await render(<Bar principalId="u1" view="calendar" />);
    expect(displayTrigger()!.disabled).toBe(true);
    expect(document.getElementById(displayTrigger()!.getAttribute("aria-describedby") ?? "")?.textContent).toContain("#430");
  });
});
