import * as React from "react";
import { cn } from "@/lib/utils";

/* Explicit ARIA roles are mandatory, not decorative: at <=720px the table switches to
   display:block, which strips the native table semantics the roles then restore. */

function TableWrap({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-wrap"
      className={cn(
        "w-full min-[721px]:overflow-x-auto",
        "min-[721px]:border-solid min-[721px]:border-[length:var(--border-width-hair)] min-[721px]:border-border min-[721px]:bg-card",
        className,
      )}
      {...props}
    />
  );
}

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <table
      role="table"
      data-slot="table"
      className={cn(
        "w-full border-collapse",
        "min-[721px]:min-w-[820px]",
        "max-[721px]:block",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead role="rowgroup" data-slot="table-head" className={cn("max-[721px]:sr-only", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      role="rowgroup"
      data-slot="table-body"
      className={cn("max-[721px]:block min-[721px]:[&>tr:last-child>td]:border-b-0", className)}
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
        "max-[721px]:block max-[721px]:mb-[var(--space-4)] max-[721px]:p-[var(--space-4)]",
        "max-[721px]:border-solid max-[721px]:border-[length:var(--border-width-hair)] max-[721px]:border-border max-[721px]:bg-card",
        className,
      )}
      {...props}
    />
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      role="columnheader"
      scope="col"
      data-slot="table-header"
      className={cn(
        "px-[var(--space-4)] py-[12px] text-left align-bottom",
        "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary",
        "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      role="cell"
      data-slot="table-cell"
      className={cn(
        "align-middle text-foreground-secondary",
        "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]",
        "min-[721px]:px-[var(--space-4)] min-[721px]:py-[13px]",
        "min-[721px]:[border-bottom-style:solid] min-[721px]:border-b-[length:var(--border-width-hair)] min-[721px]:border-b-border",
        "[&>strong]:text-foreground [&>strong]:font-[var(--weight-regular)]",
        // Stacked-card mode: the column name is restated from the cell's own data-label.
        "max-[721px]:block max-[721px]:px-0 max-[721px]:py-[var(--space-2)]",
        "max-[721px]:before:content-[attr(data-label)] max-[721px]:before:block max-[721px]:before:mb-[var(--space-1)]",
        "max-[721px]:before:[font:var(--type-eyebrow)] max-[721px]:before:uppercase",
        "max-[721px]:before:tracking-[var(--tracking-wide)] max-[721px]:before:text-foreground-secondary",
        className,
      )}
      {...props}
    />
  );
}

export { TableWrap, Table, TableHead, TableBody, TableRow, TableHeader, TableCell };
