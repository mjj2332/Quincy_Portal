import { createContext, useCallback, useContext, useId, useMemo, useRef, type ReactNode } from "react";
import { useTable, type ColumnDef, type ColumnVisibilityState, type Row, type SortingState, type Updater } from "@tanstack/react-table";
import { Link2, Lock, MessageSquare, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOwnWidth } from "../../lib/use-own-width";
import { LazyImage } from "../LazyImage";
import { Badge } from "../reui/badge";
import { DataGrid, DataGridContainer, dataGridFeatures, type DataGridFeatures } from "../reui/data-grid/data-grid";
import { DataGridColumnHeader } from "../reui/data-grid/data-grid-column-header";
import { DataGridScrollArea } from "../reui/data-grid/data-grid-scroll-area";
import { DataGridTable } from "../reui/data-grid/data-grid-table";
import { Frame, FramePanel } from "../reui/frame";
import { formatDuration, formatVideoDate } from "../video/video-format";
import { Checkbox } from "./Checkbox";
import { useFileDropTarget, type FileDropTargetProps } from "./FileDropzone";
import { InitialsAvatar } from "./InitialsAvatar";
import { StatusPill } from "./StatusPill";
import { VideoOpenControl, videoTileSummary, type VideoTileOpen, type VideoTileStatus } from "./VideoTile";

/**
 * The Video row (#933, glossary): the list form of a Video tile, one presentation for the staff Video tab (#938, #939), the guest Review link page (#940) and the client
 * Delivery page (#941), each with its own column set. It takes plain values like `VideoTile` and imports nothing staff-only (no `lib/api`, `lib/auth`, router or query client),
 * so the guest and delivery trees can use it. Composed on the installed ReUI `data-grid` (TanStack Table) and styled like the Dashboard Table view (#923,
 * `components/DashboardTable.tsx`): sentence-case 12px headers, 16px table edges, 8px each side of a column, 52px rows on the surface paper.
 *
 * ## Opening
 * The title cell holds the tile's own open control (`VideoOpenControl`, a link with `href`, else a button calling `onOpen`), whose `::after` stretches over the whole row (`tr`/`li`
 * are `relative`), so a click anywhere on the row opens it and Enter on the control does too. Never the grid's `onRowClick` (a bare `<tr onClick>` has no keyboard path, and a
 * popup portalled out of a row bubbles through React to it; lesson "#431 Dashboard Table on the ReUI data-grid"). The tick, the "⋯" menu and the footer sit in `relative z-[1]`
 * wrappers above that stretched box, each its own control. `caption` stays beneath it: text that belongs to the one control (a locked film's "Request unlock").
 *
 * ## Columns
 * `columns` is the screen's set, in order. Column definitions are built once per set; every cell reads the row's item and this grid's settings from context, so a refetch never
 * remounts a row (lesson #431). Width (#933 S8): the grid measures its own width and drops uploader, then uploaded, then notes until the rest fit with the title at its 240px
 * floor; an unmeasured width (0) drops nothing. The title takes whatever width the others leave, so a table that fits is exactly the panel's width. Where even the floor does
 * not fit (narrower than the Project sheet at 768, whose 652px panel the staff set fills exactly: F10), the table sits in the data-grid's horizontal scroll area, as the
 * Dashboard Table does, so no column is ever clipped.
 *
 * ## Compact
 * `compact` (the phone: staff and guest pass `PHONE_VIEWPORT_QUERY`, delivery its container width, S9) draws a list of two-line rows instead of the table, as the Dashboard's phone
 * list (`TablePhoneList.tsx`): [tick] poster, the title, then "v3 · 1:24 · In review · [note] 2" (the status only when the set has a status column, the open-note count only when it
 * has a notes column and the count is above zero, drawn and read as the Notes cell: F9, a row carries its tile's facts), and "⋯". No uploader or date.
 *
 * ## Slots
 * `select` (the tick), `menu` ("⋯"), `footer` (upload progress and refusals), `caption`, `drop` (a file dropped anywhere on the row is the next Version, through FileDropzone's
 * `useFileDropTarget`; drag events stop at the row, so the collection body's own drop, which makes a new film, never sees it), `rowAttrs` (extra `data-*` on the row), `dataVideoId`
 * (on the row and its open control, as the tile). `sort` turns the sortable columns' headers into the grid's sort buttons: the header shows `key`/`dir`, and a press reports the
 * column it was pressed on to `onSort`, which owns what that means (the vendor's third, clearing press included).
 */
export type VideoRowColumn = "select" | "poster" | "title" | "status" | "notes" | "duration" | "uploaded" | "uploader" | "menu";
export type VideoRowSortKey = "title" | "status" | "uploaded";
export type VideoRowsSort = { key: VideoRowSortKey; dir: "asc" | "desc"; sortable: readonly VideoRowSortKey[]; onSort: (key: VideoRowSortKey) => void };

export type VideoRowItem = VideoTileOpen & {
  /** Unique within the list: the grid's row id and the drop target's key. */
  id: string;
  title: string;
  posterUrl: string | null;
  /** Null where the screen does not know or must not say (a locked film): no badge, no words. */
  version: number | null;
  durationMs: number | null;
  /** Open notes on `version`; null when unknown. Shown only above zero. */
  openNotes: number | null;
  /** The open control's accessible name when the row does something other than open the film (a locked film requests an unlock). Default: the title. */
  openLabel?: string;
  /** The `onOpen` button does nothing and says so (`aria-disabled`), staying focusable. */
  openDisabled?: boolean;
  /** A locked Premium film: a lock in the poster's place, no Version, duration or count. */
  locked?: boolean;
  premium?: boolean;
  /** The Premium mark the screen's tile draws (story 54: both layouts match), shown on a premium or locked row in place of the neutral outline "Premium". */
  premiumBadge?: ReactNode;
  /** On an active Review link (staff). */
  linked?: boolean;
  status?: VideoTileStatus;
  /** ISO time of the newest live Version's upload (the Uploaded column). */
  uploadedAt?: string;
  /** Who uploaded the newest live Version (the Uploader column, staff only). */
  uploader?: { name: string } | null;
  select?: { selected: boolean; onToggle: () => void };
  menu?: ReactNode;
  /** Under the title, part of the row's one control: text only, never a control. */
  caption?: ReactNode;
  /** Under the title, above the stretched control: upload progress, Cancel upload, refusals. */
  footer?: ReactNode;
  /** Dropping a file on the row uploads it as the next Version. */
  drop?: { nextVersion: number; onFile: (file: File) => void; disabled: boolean };
  rowAttrs?: Record<`data-${string}`, string>;
  dataVideoId?: string;
};

type Settings = { testIds: { row: string; open: string }; compact: boolean; showStatus: boolean };
const SettingsContext = createContext<Settings>({ testIds: { row: "video-row", open: "video-row-open" }, compact: false, showStatus: false });

type Column = ColumnDef<DataGridFeatures, VideoRowItem>;
type CellProps = { row: Row<DataGridFeatures, VideoRowItem> };

/**
 * Widths in px of a column between two others, its 8px each side included: the tick's 44px target, the 64px poster, 60px for the widest duration ("1:02:05" is at most 51px in
 * text-sm tabular Apfel Grotezk), 112px for the widest status pill (~71px), the 36px "⋯". The title's is its size before the width is known. The first and last shown column
 * gain EDGE_EXTRA for the table's 16px edge (`EDGE_CELL`): the poster is 80 inside the staff set and 88 where it opens the guest and delivery sets (#933 F10).
 */
const SIZES: Record<VideoRowColumn, number> = { select: 60, poster: 80, title: 280, status: 128, notes: 80, duration: 76, uploaded: 120, uploader: 180, menu: 52 };
/** The 16px table edge less the column's own 8px. */
const EDGE_EXTRA = 8;
/** S8 / plan D5: the title never narrows below this; columns are dropped to keep it. */
const TITLE_FLOOR = 240;
/** S8: what a narrow panel gives up first. */
const FIT_DROP_ORDER: readonly VideoRowColumn[] = ["uploader", "uploaded", "notes"];
/** A column's width among the shown `set`: its size, plus the table edge when it is the first or last. */
const columnSize = (column: VideoRowColumn, set: readonly VideoRowColumn[]) => SIZES[column] + (set[0] === column ? EDGE_EXTRA : 0) + (set[set.length - 1] === column ? EDGE_EXTRA : 0);
/** The width `set` needs at the least: every column's size, the title at its floor. */
const leastWidth = (set: readonly VideoRowColumn[]) => set.reduce((sum, column) => sum + (column === "title" ? TITLE_FLOOR : columnSize(column, set)), 0);
const LABELS: Record<VideoRowColumn, string> = { select: "Select", poster: "Poster", title: "Title", status: "Status", notes: "Notes", duration: "Duration", uploaded: "Uploaded", uploader: "Uploader", menu: "Actions" };
/** Columns whose header names a control column, not a fact: read aloud, not drawn. */
const UNLABELLED = new Set<VideoRowColumn>(["select", "poster", "menu"]);
const SORT_COLUMN: Partial<Record<VideoRowColumn, VideoRowSortKey>> = { title: "title", status: "status", uploaded: "uploaded" };

/** The columns of `columns` that fit `width` (px) with the title at its 240px floor, dropping uploader, uploaded, then notes (S8). An unmeasured width (0) drops nothing. */
export function videoRowColumnsToFit(columns: readonly VideoRowColumn[], width: number): VideoRowColumn[] {
  let fitted = [...columns];
  if (width <= 0) return fitted;
  for (const column of FIT_DROP_ORDER) {
    if (leastWidth(fitted) <= width) break;
    fitted = fitted.filter((kept) => kept !== column);
  }
  return fitted;
}

/**
 * The title column's width among `fitted` at `width` (px): every pixel the other columns leave, so a table that fits is exactly the panel's width, and never below the 240px
 * floor (the table is then wider than the panel, and scrolls). Unmeasured (0): its 280px size.
 */
export function videoRowTitleSize(fitted: readonly VideoRowColumn[], width: number): number {
  if (width <= 0) return SIZES.title;
  const others = fitted.reduce((sum, column) => (column === "title" ? sum : sum + columnSize(column, fitted)), 0);
  return Math.max(TITLE_FLOOR, Math.floor(width - others));
}

/** Every shown column's width among `fitted` at `width`: each its size at its place (edge or not), the title what the others leave. */
function videoRowColumnSizes(fitted: readonly VideoRowColumn[], width: number): Record<string, number> {
  return Object.fromEntries(fitted.map((column) => [column, column === "title" ? videoRowTitleSize(fitted, width) : columnSize(column, fitted)]));
}

// The Dashboard Table's metrics (#923): 8px each side of a column, no vertical padding (the row's height centres it), 16px at the table's edges, sentence-case 12px headers.
const CELL_X = "px-[var(--space-2)] py-0";
const EDGE_CELL = "first:ps-[var(--space-4)] last:pe-[var(--space-4)]";
const HEADER_TYPE = "normal-case tracking-[var(--tracking-normal)] text-xs";
const MONO = "[font-family:var(--font-mono)]";
const META = "text-xs text-foreground-secondary tabular-nums";
/** Raised above the open control's stretched box: a control of its own. */
const RAISED = "relative z-[1]";
const ROW_DROP = "group/row";
const DROP_OVERLAY = "pointer-events-none absolute inset-0 z-[2] hidden items-center justify-center gap-[var(--space-2)] bg-[var(--scrim-badge)] text-invert-foreground outline-dashed outline-[length:var(--border-width-bold)] -outline-offset-4 outline-invert-foreground text-sm group-data-[dragging=true]/row:flex";

function Thumb({ item }: { item: VideoRowItem }) {
  const { testIds } = useContext(SettingsContext);
  if (item.locked) {
    return <div data-testid={`${testIds.row}-locked`} className="flex aspect-video w-16 shrink-0 items-center justify-center bg-surface-sunken text-foreground-secondary"><Lock aria-hidden="true" className="size-4" /></div>;
  }
  return <div className="relative aspect-video w-16 shrink-0 overflow-hidden bg-invert">
    {item.posterUrl && <LazyImage src={item.posterUrl} alt={`Poster of ${item.title}`} className="h-full w-full object-contain !bg-invert !text-invert-foreground" />}
  </div>;
}

function Tick({ item }: { item: VideoRowItem }) {
  if (!item.select) return null;
  const { selected, onToggle } = item.select;
  return <label className={cn(RAISED, "flex size-11 shrink-0 cursor-pointer items-center justify-center")}>
    <Checkbox aria-label={`Select ${item.title}`} checked={selected} onChange={onToggle} />
  </label>;
}

function Menu({ item }: { item: VideoRowItem }) {
  return item.menu ? <div className={cn(RAISED, "flex shrink-0 justify-end")}>{item.menu}</div> : null;
}

function Badges({ item, withVersion }: { item: VideoRowItem; withVersion: boolean }) {
  return <>
    {withVersion && !item.locked && item.version !== null && <Badge variant="outline" data-testid="video-row-version" className={cn(MONO, "shrink-0 normal-case text-foreground-secondary")}>{`v${item.version}`}</Badge>}
    {(item.premium || item.locked) && (item.premiumBadge ?? <Badge variant="outline" className="shrink-0 text-foreground-secondary">Premium</Badge>)}
    {item.linked && <Badge variant="outline" className="shrink-0 text-foreground-secondary"><Link2 aria-hidden="true" /><span className="sr-only">On a Review link</span></Badge>}
  </>;
}

/** The title, its open control (stretched over the row), the badges, caption and footer, and the drop state. */
function TitleBlock({ item, withVersion, meta }: { item: VideoRowItem; withVersion: boolean; /** The compact row's second line, under the title. */ meta?: ReactNode }) {
  const { testIds } = useContext(SettingsContext);
  const summaryId = useId();
  const summary = videoTileSummary({ locked: item.locked === true, version: item.version, durationMs: item.durationMs, openNotes: item.openNotes, status: item.status });
  const open = item.href !== undefined
    ? <VideoOpenControl variant="row" href={item.href} title={item.title} openLabel={item.openLabel} testId={testIds.open} dataVideoId={item.dataVideoId} describedBy={summaryId} />
    : <VideoOpenControl variant="row" onOpen={item.onOpen} title={item.title} openLabel={item.openLabel} openDisabled={item.openDisabled} testId={testIds.open} dataVideoId={item.dataVideoId} describedBy={summaryId} />;
  return <>
    <div className="flex min-w-0 items-center gap-[var(--space-2)]">{open}<Badges item={item} withVersion={withVersion} /></div>
    {meta}
    <span id={summaryId} className="sr-only">{summary}</span>
    {item.caption && <div className="text-xs">{item.caption}</div>}
    {item.footer && <div className={cn(RAISED, "grid gap-[var(--space-2)]")}>{item.footer}</div>}
    {item.drop && <div aria-hidden="true" className={DROP_OVERLAY}><Upload className="size-4" />{`Drop to upload v${item.drop.nextVersion}`}</div>}
  </>;
}

function TitleCell({ row }: CellProps) {
  const item = row.original;
  // Vertical room only when a second line shows, so a plain row keeps the 52px the row height gives it.
  return <div className={cn("flex min-w-0 flex-col gap-[var(--space-1)]", (item.caption || item.footer) && "py-[var(--space-2)]")}><TitleBlock item={item} withVersion /></div>;
}

function StatusCell({ row }: CellProps) {
  const status = row.original.status;
  if (!status) return null;
  return <><StatusPill tone={status.tone} aria-hidden="true">{status.short}</StatusPill><span className="sr-only">{status.full}</span></>;
}

/** The open-note count to show, or null: above zero, and never on a locked film. */
const openNotesShown = ({ openNotes, locked }: VideoRowItem) => (!locked && openNotes !== null && openNotes > 0 ? openNotes : null);

/** The open-note count, the Notes cell's and the compact meta line's alike: the note icon and the number drawn, "2 open notes on v3" read. */
function OpenNotes({ item, className }: { item: VideoRowItem; className?: string }) {
  const { testIds } = useContext(SettingsContext);
  const count = openNotesShown(item);
  if (count === null) return null;
  return <span data-testid={`${testIds.row}-open-notes`} className={cn(META, "inline-flex items-center gap-[var(--space-1)]", className)}>
    <MessageSquare aria-hidden="true" className="size-3.5 text-foreground-secondary" /><span aria-hidden="true">{count}</span>
    <span className="sr-only">{`${count} open ${count === 1 ? "note" : "notes"}${item.version !== null ? ` on v${item.version}` : ""}`}</span>
  </span>;
}

function NotesCell({ row }: CellProps) {
  return <OpenNotes item={row.original} className="text-sm text-foreground" />;
}

function DurationCell({ row }: CellProps) {
  const { durationMs, locked } = row.original;
  // The body sans with tabular figures, as the Dashboard Table's numbers (F11); the tile's duration chip keeps its own type.
  return locked || durationMs === null ? null : <span className="text-sm tabular-nums">{formatDuration(durationMs)}</span>;
}

function UploadedCell({ row }: CellProps) {
  const { uploadedAt } = row.original;
  return uploadedAt ? <span className="block truncate text-sm tabular-nums">{formatVideoDate(uploadedAt)}</span> : null;
}

function UploaderCell({ row }: CellProps) {
  const uploader = row.original.uploader;
  if (!uploader) return null;
  return <span className="flex min-w-0 items-center gap-[var(--space-2)]"><InitialsAvatar name={uploader.name} className="size-6 shrink-0" /><span className="min-w-0 truncate text-sm">{uploader.name}</span></span>;
}

const CELLS: Record<VideoRowColumn, Column["cell"]> = {
  select: ({ row }: CellProps) => <Tick item={row.original} />,
  poster: ({ row }: CellProps) => <Thumb item={row.original} />,
  title: TitleCell,
  status: StatusCell,
  notes: NotesCell,
  duration: DurationCell,
  uploaded: UploadedCell,
  uploader: UploaderCell,
  menu: ({ row }: CellProps) => <Menu item={row.original} />,
};

function buildColumns(columns: readonly VideoRowColumn[], sortable: readonly VideoRowSortKey[]): Column[] {
  return columns.map((id): Column => {
    const sortKey = SORT_COLUMN[id];
    return {
      id,
      accessorFn: (item) => item.id,
      header: UNLABELLED.has(id) ? () => <span className="sr-only">{LABELS[id]}</span> : ({ column }) => <DataGridColumnHeader column={column} title={LABELS[id]} className={HEADER_TYPE} />,
      cell: CELLS[id],
      size: columnSize(id, columns),
      meta: { headerClassName: CELL_X, cellClassName: CELL_X },
      enableSorting: sortKey !== undefined && sortable.includes(sortKey),
      enableHiding: id !== "title",
    };
  });
}

const getRowId = (item: VideoRowItem) => item.id;

/** The attributes every row carries, table or list: test id, video id, selection, the caller's `rowAttrs`, and the drop target's handlers. */
function useRowAttributes(testId: string) {
  const { targetProps } = useFileDropTarget();
  return useCallback((item: VideoRowItem): Record<`data-${string}`, string | undefined> & Partial<FileDropTargetProps> & { className: string } => ({
    "data-testid": testId,
    ...(item.dataVideoId !== undefined ? { "data-video-id": item.dataVideoId } : {}),
    ...(item.select ? { "data-selected": item.select.selected ? "true" : "false" } : {}),
    ...item.rowAttrs,
    ...(item.drop ? targetProps(item.id, { disabled: item.drop.disabled, onFiles: (files) => { item.drop?.onFile(files[0]!); } }) : {}),
    className: ROW_DROP,
  }), [targetProps, testId]);
}

export function VideoRows({ items, columns, compact = false, tone = "default", label, testIds, sort }: {
  items: readonly VideoRowItem[];
  /** The screen's column set, in order. */
  columns: readonly VideoRowColumn[];
  /** Two-line list rows (the phone) in place of the table. */
  compact?: boolean;
  /** `paper`: the light Delivery page (#941). */
  tone?: "default" | "paper";
  /** The list's accessible name. */
  label: string;
  testIds: { row: string; open: string };
  sort?: VideoRowsSort;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const width = useOwnWidth(panelRef);
  const showStatus = columns.includes("status");
  const settings = useMemo<Settings>(() => ({ testIds, compact, showStatus }), [testIds, compact, showStatus]);
  const rowAttributes = useRowAttributes(testIds.row);
  return <section aria-label={label} data-testid="video-rows" data-tone={tone}>
    <SettingsContext.Provider value={settings}>
      <Frame dense className={cn("min-w-0", tone === "paper" && "bg-background")}>
        <FramePanel className="flex min-w-0 flex-col p-0">
          {/* Measured inside the panel's hairlines: the width the table has. */}
          <div ref={panelRef} className="min-w-0">
            {compact
              ? <CompactList items={items} columns={columns} rowAttributes={rowAttributes} />
              : <RowsGrid items={items} columns={columns} width={width} sort={sort} rowAttributes={rowAttributes} />}
          </div>
        </FramePanel>
      </Frame>
    </SettingsContext.Provider>
  </section>;
}

function RowsGrid({ items, columns, width, sort, rowAttributes }: {
  items: readonly VideoRowItem[]; columns: readonly VideoRowColumn[]; /** The panel's measured width, 0 until known. */ width: number; sort: VideoRowsSort | undefined;
  rowAttributes: (item: VideoRowItem) => ReturnType<ReturnType<typeof useRowAttributes>>;
}) {
  const columnsKey = columns.join(",");
  const sortableKey = sort?.sortable.join(",") ?? "";
  // Built once per column set (lesson #431: a new column array remounts every row).
  const definitions = useMemo(() => buildColumns(columnsKey.split(",") as VideoRowColumn[], sortableKey === "" ? [] : sortableKey.split(",") as VideoRowSortKey[]), [columnsKey, sortableKey]);
  const fitted = useMemo(() => videoRowColumnsToFit(columnsKey.split(",") as VideoRowColumn[], width), [columnsKey, width]);
  const visibility = useMemo<ColumnVisibilityState>(() => Object.fromEntries(columnsKey.split(",").map((id) => [id, fitted.includes(id as VideoRowColumn)])), [columnsKey, fitted]);
  // The title takes the width the others leave, so a table that fits is exactly the panel's width (no spread over every column).
  const sizing = useMemo(() => videoRowColumnSizes(fitted, width), [fitted, width]);
  const sorting = useMemo<SortingState>(() => (sort ? [{ id: sort.key, desc: sort.dir === "desc" }] : []), [sort]);
  const onSortingChange = (updater: Updater<SortingState>) => {
    if (!sort) return;
    const next = typeof updater === "function" ? updater(sorting) : updater;
    const picked = next[0]?.id;
    // A press on the sorted column may come back cleared (the vendor's third step): it was still a press on that column.
    sort.onSort(picked === "title" || picked === "status" || picked === "uploaded" ? picked : sort.key);
  };
  const data = useMemo(() => [...items], [items]);
  const table = useTable({
    features: dataGridFeatures,
    // Every row is shown and already in order (`arrangeVideos` is the one sorter): without these v9 would page at 10 rows and sort again.
    manualPagination: true,
    manualSorting: true,
    data,
    columns: definitions,
    getRowId,
    state: { sorting, columnVisibility: visibility, columnSizing: sizing },
    onSortingChange,
  });
  const rowProps = useCallback((row: Row<DataGridFeatures, VideoRowItem>) => rowAttributes(row.original), [rowAttributes]);
  return <DataGrid
    table={table}
    recordCount={data.length}
    tableLayout={{ rowBorder: true, headerBorder: true, width: "fixed", headerSticky: false, columnsResizable: false, columnsVisibility: false, columnsMovable: false, columnsPinnable: false }}
    tableClassNames={{
      edgeCell: EDGE_CELL,
      headerRow: "[&>th]:h-10 bg-background",
      // `relative` is the containing block of the open control's stretched ::after and the drop state.
      bodyRow: "relative h-13 bg-card",
    }}
  >
    {/* As the Dashboard Table: where even the title's floor does not fit (narrower than the Project sheet at 768), the table scrolls sideways instead of the container clipping Actions. */}
    <DataGridContainer>
      <DataGridScrollArea orientation="horizontal" data-testid="video-rows-scroll"><DataGridTable rowProps={rowProps} /></DataGridScrollArea>
    </DataGridContainer>
  </DataGrid>;
}

/** The phone list (frame 4g's pattern, `TablePhoneList.tsx`): one two-line row per item. */
function CompactList({ items, columns, rowAttributes }: { items: readonly VideoRowItem[]; columns: readonly VideoRowColumn[]; rowAttributes: (item: VideoRowItem) => ReturnType<ReturnType<typeof useRowAttributes>> }) {
  return <ul className="m-0 list-none p-0">
    {items.map((item) => <CompactRow key={item.id} item={item} columns={columns} attributes={rowAttributes(item)} />)}
  </ul>;
}

function CompactRow({ item, columns, attributes }: { item: VideoRowItem; columns: readonly VideoRowColumn[]; attributes: ReturnType<ReturnType<typeof useRowAttributes>> }) {
  const { showStatus } = useContext(SettingsContext);
  const { className, ...rest } = attributes;
  const meta = item.locked ? [] : [item.version !== null ? `v${item.version}` : null, item.durationMs !== null ? formatDuration(item.durationMs) : null].filter((part): part is string => part !== null);
  const status = !item.locked && showStatus && item.status ? item.status.short : null;
  const notes = columns.includes("notes") && openNotesShown(item) !== null;
  return <li {...rest} className={cn(className, "relative flex items-start gap-[var(--space-3)] border-b border-border bg-card px-[var(--space-4)] py-[var(--space-3)] last:border-b-0")}>
    {columns.includes("select") && item.select && <div className="-my-[var(--space-2)] -ms-[var(--space-2)]"><Tick item={item} /></div>}
    {columns.includes("poster") && <Thumb item={item} />}
    <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-1)]">
      <TitleBlock item={item} withVersion={false} meta={meta.length > 0 || status !== null || notes
        // One line, so the row stays two (S9): the Version and duration give way to an ellipsis before the status or the note count does.
        ? <span data-testid="video-row-meta" className={cn(META, "flex min-w-0 items-center whitespace-pre")}>
          {meta.length > 0 && <span className="min-w-0 truncate">{meta.join(" · ")}</span>}
          {/* The separators sit outside the truncating text, whose `nowrap` would collapse their spaces at its edge. */}
          {meta.length > 0 && (status !== null || notes) && <span className="shrink-0">{" · "}</span>}
          {status !== null && <span data-testid="video-row-meta-status" className="shrink-0">{status}</span>}
          {status !== null && notes && <span className="shrink-0">{" · "}</span>}
          {notes && <OpenNotes item={item} className="shrink-0" />}
        </span>
        : null} />
    </div>
    {columns.includes("menu") && <div className="-my-[var(--space-2)]"><Menu item={item} /></div>}
  </li>;
}
