import * as React from "react";

import { cn } from "@/lib/utils";
import { Table as ReuiTable } from "@/components/reui/table";

// Name-inversion trap: shadcn's `TableHeader` is `<thead>` and its `TableHead` is `<th>`.
// Quincy's are the exact opposite — `TableHead` is `<thead>`, `TableHeader` is `<th>`. Keeping
// Quincy's names in this wrapper (and mapping them onto ReUI's own, oppositely-named parts
// internally) is what kills the trap. Do not "align" these with the vendor.

/* Explicit ARIA roles are mandatory, not decorative: at <=720px the table switches to
   display:block, which strips the native table semantics the roles then restore. ReUI's table
   ships no roles at all. */

type TableDensity = "default" | "compact";
const TableDensityContext = React.createContext<TableDensity>("default");

/** `stackBelow` picks where the grid collapses into stacked cards: "md" = 721px (default), "lg" = 1024px. */
function TableWrap({ className, stackBelow = "md", ...props }: React.ComponentProps<"div"> & { stackBelow?: "md" | "lg" }) {
  return (
    <div
      data-slot="table-wrap"
      data-stack={stackBelow}
      className={cn(
        // `relative` is load-bearing: the sr-only "Actions" header label is absolutely positioned, and
        // an overflow clip only contains absolute descendants when the clipping box is itself
        // positioned. Without it the label escaped and the whole page scrolled sideways at 721-1000px.
        "relative w-full table-grid:overflow-x-auto",
        "table-grid:border-solid table-grid:border-[length:var(--border-width-hair)] table-grid:border-border table-grid:bg-card",
        className,
      )}
      {...props}
    />
  );
}

/** `density="compact"` narrows the cell gutters from 16px to 12px at the grid breakpoint (#640). */
function Table({ className, density = "default", ...props }: React.ComponentProps<"table"> & { density?: TableDensity }) {
  return (
    <TableDensityContext.Provider value={density}>
    <ReuiTable
      role="table"
      data-slot="table"
      data-density={density}
      // ReUI's `Table` hardcodes its own `<div className="relative w-full overflow-x-auto">`
      // wrapper; `containerClassName` (a Stage A addition) is used here to render nothing extra
      // — Quincy's own `TableWrap` above is the wrapping element Admin composes with.
      containerClassName="contents"
      className={cn(
        "w-full border-collapse",
        "table-grid:min-w-[820px]",
        "table-stacked:block",
        className,
      )}
      {...props}
    />
    </TableDensityContext.Provider>
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead role="rowgroup" data-slot="table-head" className={cn("table-stacked:sr-only", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      role="rowgroup"
      data-slot="table-body"
      className={cn("table-stacked:block table-grid:[&>tr:last-child>td]:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      role="row"
      data-slot="table-row"
      className={cn(
        "table-stacked:block table-stacked:mb-[var(--space-4)] table-stacked:p-[var(--space-4)]",
        "table-stacked:border-solid table-stacked:border-[length:var(--border-width-hair)] table-stacked:border-border table-stacked:bg-card",
        className,
      )}
      {...props}
    />
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"th">) {
  const compact = React.useContext(TableDensityContext) === "compact";
  return (
    <th
      role="columnheader"
      scope="col"
      data-slot="table-header"
      className={cn(
        compact ? "px-[var(--space-3)]" : "px-[var(--space-4)]",
        "py-[12px] text-left align-bottom",
        "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary",
        "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  const compact = React.useContext(TableDensityContext) === "compact";
  return (
    <td
      role="cell"
      data-slot="table-cell"
      className={cn(
        "align-middle text-foreground-secondary",
        "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]",
        compact ? "table-grid:px-[var(--space-3)]" : "table-grid:px-[var(--space-4)]",
        "table-grid:py-[13px]",
        "table-grid:[border-bottom-style:solid] table-grid:border-b-[length:var(--border-width-hair)] table-grid:border-b-border",
        "[&>strong]:text-foreground [&>strong]:font-[var(--weight-regular)]",
        // Stacked-card mode: the column name is restated from the cell's own data-label.
        "table-stacked:block table-stacked:px-0 table-stacked:py-[var(--space-2)]",
        "table-stacked:before:content-[attr(data-label)] table-stacked:before:block table-stacked:before:mb-[var(--space-1)]",
        "table-stacked:before:[font:var(--type-eyebrow)] table-stacked:before:uppercase",
        "table-stacked:before:tracking-[var(--tracking-wide)] table-stacked:before:text-foreground-secondary",
        className,
      )}
      {...props}
    />
  );
}

/** Row of action buttons in a cell: right-aligned in the grid, start-aligned in stacked cards, wraps with gaps. */
function TableActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-actions"
      className={cn(
        "flex flex-wrap justify-end gap-x-[var(--space-3)] gap-y-[var(--space-2)]",
        "table-stacked:justify-start table-stacked:pt-[var(--space-3)]",
        className,
      )}
      {...props}
    />
  );
}

export { TableWrap, TableActions, Table, TableHead, TableBody, TableRow, TableHeader, TableCell };
