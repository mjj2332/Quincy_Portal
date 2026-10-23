import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTable, type ColumnDef } from "@tanstack/react-table";
import { DataGrid, DataGridContainer, dataGridFeatures, type DataGridFeatures } from "./data-grid";
import { DataGridTable, type DataGridTableRowProps } from "./data-grid-table";

/**
 * The Quincy `rowProps` seam on `DataGridTable` (#938, adaptation note in `data-grid-table.tsx`): a caller may put attributes and drag handlers on each body `<tr>`
 * (the Video row's file drop and its data attributes). Without it a row renders exactly as before, which is what the Dashboard Table relies on.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Item = { id: string; name: string };
const COLUMNS: ColumnDef<DataGridFeatures, Item>[] = [{ id: "name", accessorFn: (item) => item.name, header: "Name", cell: ({ row }) => row.original.name }];
const DATA: Item[] = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];

function Grid({ rowProps }: { rowProps?: DataGridTableRowProps<Item> }) {
  const table = useTable({ features: dataGridFeatures, manualPagination: true, manualSorting: true, data: DATA, columns: COLUMNS, getRowId: (item) => item.id });
  return <DataGrid table={table} recordCount={DATA.length} tableClassNames={{ bodyRow: "bg-muted" }}>
    <DataGridContainer><DataGridTable {...(rowProps ? { rowProps } : {})} /></DataGridContainer>
  </DataGrid>;
}

let root: Root | null = null; let host: HTMLElement | null = null;
async function mount(rowProps?: DataGridTableRowProps<Item>) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<Grid {...(rowProps ? { rowProps } : {})} />); });
}
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); host?.remove(); root = null; host = null; });
const bodyRows = () => [...document.querySelectorAll<HTMLTableRowElement>("tbody tr")];

describe("DataGridTable rowProps (#938)", () => {
  it("renders a body row as before when no rowProps is given (the Dashboard Table's case)", async () => {
    await mount();
    const row = bodyRows()[0]!;
    expect(row.getAttributeNames().sort()).toEqual(["class", "data-row-id"]);
    expect(row.className).toContain("bg-muted");
  });

  it("spreads each row's attributes and handlers on its <tr>, keeping the grid's own class and id", async () => {
    const onDrop = vi.fn();
    await mount((row) => ({ "data-testid": `row-${row.original.id}`, className: "ring-2", onDrop }));
    const [first, second] = bodyRows();
    expect(first!.getAttribute("data-testid")).toBe("row-a");
    expect(second!.getAttribute("data-testid")).toBe("row-b");
    expect(first!.getAttribute("data-row-id")).toBe("a");
    expect(first!.className).toContain("bg-muted");
    expect(first!.className).toContain("ring-2");
    await act(async () => { first!.dispatchEvent(new Event("drop", { bubbles: true })); });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});
