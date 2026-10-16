import { useRef, type RefObject } from "react";
import { Button } from "../reui/button";
import { Check } from "lucide-react";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "../reui/item";
import { Sheet, SheetContent, SheetTitle } from "../reui/sheet";
import { ACTION_ROW, ACTION_ROW_TITLE, PHONE_SHEET_CHROME, SHEET_SCRIM } from "../quincy/ReviewActionSheet";
import { SheetCloseButton } from "../quincy/SheetCloseButton";
import { formatVideoDate } from "./video-format";

/** One Version in the phone Versions sheet. The date and the count fill in when the sheet's read answers; until then (or if it fails) the row shows what it has. */
export type VersionSheetRow = {
  assetId: string;
  version: number;
  createdAt?: string | undefined;
  /** Open root notes; `null` or absent shows no count. */
  openNoteCount?: number | null | undefined;
};

/** The sheet's rows from the Versions the screen already holds, with the read's dates and counts laid over them by Asset id. */
export function withSummaries<Row extends { assetId: string; version: number; createdAt?: string | undefined }>(
  rows: readonly Row[], summaries: ReadonlyArray<{ assetId: string; createdAt: string; openNoteCount: number | null }> | undefined,
): VersionSheetRow[] {
  const byAsset = new Map((summaries ?? []).map((summary) => [summary.assetId, summary] as const));
  return rows.map((row) => ({ assetId: row.assetId, version: row.version, createdAt: byAsset.get(row.assetId)?.createdAt ?? row.createdAt, openNoteCount: byAsset.get(row.assetId)?.openNoteCount ?? null }));
}

/**
 * The phone's Version chooser (#879, D16, P8): a bottom sheet of Versions, newest first, each an easy-to-tap row with its number, upload date and open-note count, and a check on the
 * one on screen. Staff also see the latest Version's Review status. Choosing a row hands the Asset id to the screen's own Version path, so the URL and the deep link are unchanged.
 * Reuse: `reui/sheet` (`side="bottom"`, portalled into the viewer's slot as the guest drawer was), `reui/item` rows, lucide `Check`.
 * P8 (#879 PR 3b): "Version" in label type and secondary ink above rows of P9's size (`ACTION_ROW`), each one line: the number left; the date, the open count and (staff, latest)
 * the Review status right, truncating first, then the check on the Version on screen. No fill marks the current row; the check and `aria-current` do.
 */
export function VideoVersionsSheet({ open, onOpenChange, container, rows, currentAssetId, onChoose, latestStatus, returnFocusTo }: {
  /** What takes focus when the sheet closes (the Version chip). */
  returnFocusTo?: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  container: HTMLElement | null;
  /** Newest first. */
  rows: readonly VersionSheetRow[];
  currentAssetId: string;
  onChoose: (assetId: string) => void;
  /** Staff: the latest Version's Review status label. */
  latestStatus?: string | undefined;
}) {
  const newest = Math.max(0, ...rows.map((row) => row.version));
  // P8's chrome (#879 PR 3b): the sheet itself takes focus on open, and the close is drawn only on keyboard focus.
  const popupRef = useRef<HTMLDivElement | null>(null);
  // The viewer Dialog's `restoreFocus: "popup"` reclaims homeless focus a frame after a nested sheet closes (lessons, P3 / #669): the chip takes focus synchronously, before the close.
  const changeOpen = (next: boolean) => { if (!next) returnFocusTo?.current?.focus({ preventScroll: true }); onOpenChange(next); };
  return <Sheet open={open} onOpenChange={changeOpen}>
    <SheetContent ref={popupRef} side="bottom" container={container} showCloseButton={false} overlayProps={{ className: SHEET_SCRIM, forceRender: true, "data-testid": "review-sheet-overlay" }} initialFocus={() => popupRef.current ?? true} {...(returnFocusTo ? { finalFocus: () => returnFocusTo.current ?? true } : {})} data-testid="video-versions-sheet" className={`max-h-[70dvh] ${PHONE_SHEET_CHROME}`}>
      <SheetTitle data-testid="video-versions-title" className="m-0 px-[calc(var(--space-4)+var(--space-1))] pt-[var(--space-2)] pb-[var(--space-2)] text-foreground-secondary [font:var(--type-label)]">Version</SheetTitle>
      <ItemGroup role="group" aria-label="Versions" className="min-h-0 gap-0 overflow-y-auto">
        {rows.map((row) => {
          const current = row.assetId === currentAssetId;
          const latest = row.version === newest;
          const meta = [row.createdAt !== undefined ? formatVideoDate(row.createdAt) : null, typeof row.openNoteCount === "number" ? `${row.openNoteCount} open` : null, latest ? latestStatus ?? null : null]
            .filter((part): part is string => part !== null).join(" · ");
          return <Item
            key={row.assetId}
            size="sm"
            // The row's geometry sits on the Item: its `sm` padding and wrap are merged after whatever the rendered Button carries.
            className={`${ACTION_ROW} flex-nowrap`}
            render={<Button type="button" variant="ghost" data-testid="video-version-row" data-asset-id={row.assetId} aria-current={current ? "true" : undefined} className="h-auto justify-start font-normal normal-case" onClick={() => { onChoose(row.assetId); changeOpen(false); }} />}
          >
            <ItemContent className="flex-none">
              <ItemTitle data-testid="video-version-label" className={`${ACTION_ROW_TITLE} whitespace-nowrap`}>{`v${row.version}${latest ? " · latest" : ""}`}</ItemTitle>
            </ItemContent>
            <ItemActions className="ms-auto min-w-0 gap-[var(--space-2)]">
              {meta !== "" && <span data-testid="video-version-meta" className="truncate text-foreground-secondary tabular-nums [font:var(--type-label)]">{meta}</span>}
              {current && <Check aria-hidden="true" data-testid="video-version-check" className="size-4 flex-none" />}
            </ItemActions>
          </Item>;
        })}
      </ItemGroup>
      <SheetCloseButton label="Close versions" data-testid="video-versions-close" visuallyHidden />
    </SheetContent>
  </Sheet>;
}
