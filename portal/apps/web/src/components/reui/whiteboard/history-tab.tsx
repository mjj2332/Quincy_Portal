/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #500 from the sandbox
 * (`tmp/ReUI-Test-1/src/components/vendor-498/history-tab.tsx`), never `shadcn add` in apps/web. Mechanical edits as in
 * `board-panel.tsx`: `cn` from `@/lib/utils`, imports repointed to `@/components/reui/`, the Skin guard's strips,
 * `noUncheckedIndexedAccess` narrowing.
 *
 * This file: The History tab. VENDORED-EDIT (#500): the registry's demo had a "Save Version" popover (name a version by hand), a "Working
 * Copy" row, a demo `BoardVersion`/`Person` model and an in-memory restore. Quincy's versions are automatic (30 s after a change, on the last
 * person leaving, and a backup before every restore), so the popover and the Working Copy row are DROPPED (with the `field`, `input` and
 * `popover` imports they needed). The rows now take the server's `WhiteboardVersionSummary` (newest first: reason, author, time, element
 * count); loading is the panel's `PanelRowSkeletons`, empty and error are `reui/empty`. A view-only board omits the Restore action
 * entirely (no `actions`, not a disabled button). There is no preview before restore: the confirmation lives in the host.
 */
import { useMemo } from "react"
import { initials } from "@/lib/initials"
import { formatAbsoluteTimeWithSeconds, formatDistinctTimes } from "@/lib/date-format"
import type { WhiteboardVersionReason, WhiteboardVersionSummary } from "@quincy/shared"

import {
  Avatar,
  AvatarFallback,
} from "@/components/reui/avatar"
import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/reui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/reui/empty"
import {
  PanelList,
  PanelRow,
  PanelRowSkeletons,
  PanelScroll,
  RowAction,
} from "./board-panel"
import {
  ArchiveRestoreIcon,
  ClockIcon,
  DoorOpenIcon,
  HistoryIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react"

const REASONS: Record<WhiteboardVersionReason, { label: string; icon: React.ReactNode }> = {
  interval: { label: "Autosaved", icon: <ClockIcon aria-hidden="true" /> },
  last_leave: { label: "Last person left", icon: <DoorOpenIcon aria-hidden="true" /> },
  pre_restore: { label: "Before restore", icon: <ArchiveRestoreIcon aria-hidden="true" /> },
}

const RESTORE_ICON = <RotateCcwIcon aria-hidden="true" />

/** Who and when as meta line parts. The whole name, the one the avatar's initials come from (`lib/initials`); a long one slides like any row text. `when` is the row's own time label (#559: `formatDistinctTimes`, Sydney time like the rest of the Portal). */
function byline(version: WhiteboardVersionSummary, when: string) {
  const who = version.createdBy?.name.trim() ? version.createdBy.name : null
  return [
    <span key="who" className="flex items-center gap-1.5">
      <Avatar className="size-4 shrink-0" aria-hidden="true">
        <AvatarFallback className="text-[8px]">{who ? initials(who) : "A"}</AvatarFallback>
      </Avatar>
      {who ?? "Automatic"}
    </span>,
    when,
  ]
}

/** The element count rides the title's badge slot, not the meta line, so a 320px row that truncates the byline cannot push it out. */
function countBadge(version: WhiteboardVersionSummary, current: boolean) {
  return (
    <>
      {current ? <Badge variant="primary-light" data-testid="whiteboard-version-current">Current</Badge> : null}
      <span data-testid="whiteboard-version-count" className="text-xs font-normal text-muted-foreground tabular-nums">
        {`${version.elementCount} element${version.elementCount === 1 ? "" : "s"}`}
      </span>
    </>
  )
}

export type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  /** `currentVersionId` (#559): the newest version equal to the live board right now, or null when the board has changed since its last snapshot. */
  | { status: "ready"; versions: readonly WhiteboardVersionSummary[]; currentVersionId?: string | null }

export function HistoryTab({
  state,
  readOnly,
  onRestore,
  onRetry,
  restoreRef,
}: {
  state: HistoryState
  readOnly: boolean
  onRestore: (version: WhiteboardVersionSummary) => void
  onRetry: () => void
  /** Each row's Restore button by version id, where Cancel returns focus. */
  restoreRef: (id: string) => React.Ref<HTMLButtonElement>
}) {
  const versions = state.status === "ready" ? state.versions : null
  // Newest first, each with its own time label; the labels are computed together so two rows that read alike can be told apart.
  const rows = useMemo(() => {
    if (!versions) return []
    const newestFirst = [...versions].sort((a, b) => b.createdAt - a.createdAt)
    const labels = formatDistinctTimes(newestFirst.map((version) => version.createdAt), Date.now())
    return newestFirst.map((version, index) => ({ version, when: labels[index]! }))
  }, [versions])
  if (state.status === "loading") {
    return (
      <PanelScroll>
        <div data-testid="whiteboard-history-loading" role="status" aria-label="Loading history">
          <PanelRowSkeletons widths={[120, 96, 132, 104]} />
        </div>
      </PanelScroll>
    )
  }
  if (state.status === "error") {
    return (
      <PanelScroll>
        <Empty data-testid="whiteboard-history-error" role="alert">
          <EmptyHeader>
            <EmptyMedia variant="icon"><TriangleAlertIcon aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>History Unavailable</EmptyTitle>
            <EmptyDescription>{state.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" variant="outline" data-testid="whiteboard-history-retry" onClick={onRetry}>Try Again</Button>
          </EmptyContent>
        </Empty>
      </PanelScroll>
    )
  }
  if (state.versions.length === 0) {
    return (
      <PanelScroll>
        <Empty data-testid="whiteboard-history-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon"><HistoryIcon aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>No History Yet</EmptyTitle>
            <EmptyDescription>Versions appear here a short while after the board changes.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PanelScroll>
    )
  }
  return (
    <PanelScroll>
      <PanelList>
        {rows.map(({ version, when }) => {
          const reason = REASONS[version.reason]
          // The version the board still equals: marked, and not offered for Restore (restoring it would change nothing).
          const current = state.currentVersionId === version.id
          return (
            <PanelRow
              key={version.id}
              rowAttrs={{ "data-testid": "whiteboard-version-row", "data-version-id": version.id }}
              icon={reason.icon}
              title={reason.label}
              badge={countBadge(version, current)}
              meta={byline(version, when)}
              current={current}
              actions={
                readOnly || current ? undefined : (
                  <RowAction
                    label={`Restore ${reason.label.toLowerCase()} version from ${formatAbsoluteTimeWithSeconds(version.createdAt)}`}
                    tooltip="Restore"
                    icon={RESTORE_ICON}
                    buttonRef={restoreRef(version.id)}
                    onClick={() => onRestore(version)}
                  />
                )
              }
            />
          )
        })}
      </PanelList>
    </PanelScroll>
  )
}
