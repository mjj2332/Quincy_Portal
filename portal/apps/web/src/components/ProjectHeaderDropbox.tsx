import { useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/reui/popover";
import { buttonClasses } from "./quincy/Button";
import { StatusPill } from "./quincy/StatusPill";
import { cn } from "../lib/utils";
import type { ProjectDetail } from "../lib/project-data";
import { DASHED_TRIGGER, HEADER_KV_KEY, HEADER_KV_VALUE, POPOVER_CONTENT, TRIGGER_CHEVRON } from "./project-header-popover";

/**
 * #205 — the header's Dropbox control (then a `<section>` in the rail, since #213 a cell in the flat
 * control row) is a dashed trigger that opens the
 * same content (raw-monitored, raw-tonomo-secondary, the sync button, the Blocked status line)
 * inside a `reui/popover.tsx` popover. No `keepMounted`: the unmount-on-close is intentional, same
 * rationale as `ProjectHeaderDeadline.tsx`, though this popover holds no draft state to discard —
 * it simply keeps the closed DOM empty.
 *
 * #213 — laid out as prototype 2a draws it: the trigger is the state pill and a chevron (the
 * "Dropbox" label is the header cell's); the popover opens with a title row "Dropbox · pill",
 * then the folder facts, then one button row — Open in Dropbox (secondary, only with a web URL)
 * beside Sync from Dropbox (primary). When nothing is monitored the popover says so in one line
 * rather than offering a bare Sync button. The gating is unchanged from the rail: no monitored or
 * Tonomo block without a ready Editor mapping, and never the legacy RAW link.
 */

function dropboxState(project: ProjectDetail, autohdrBlocked: boolean): { tone: "caution" | "positive" | "neutral"; label: string } {
  if (autohdrBlocked) return { tone: "caution", label: "Blocked" };
  if (project.monitoredRawFolder) return { tone: "positive", label: "Monitored" };
  return { tone: "neutral", label: "Not monitored" };
}

export function ProjectHeaderDropbox({ project, isSyncing, autohdrBlocked, onSyncDropbox }: {
  project: ProjectDetail;
  isSyncing: boolean;
  autohdrBlocked: boolean;
  onSyncDropbox: () => void;
}) {
  const [open, setOpen] = useState(false);
  const state = dropboxState(project, autohdrBlocked);

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger
      type="button"
      data-testid="project-dropbox-trigger"
      aria-label={`Dropbox: ${state.label}`}
      className={DASHED_TRIGGER}
    >
      <StatusPill tone={state.tone}>{state.label}</StatusPill>
      <ChevronDown aria-hidden="true" className={TRIGGER_CHEVRON} />
    </PopoverTrigger>
    <PopoverContent align="start" aria-label="Dropbox" className={POPOVER_CONTENT}>
      <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-3)]">
        <PopoverTitle className="!font-medium">Dropbox</PopoverTitle>
        <StatusPill tone={state.tone}>{state.label}</StatusPill>
      </div>
      {project.monitoredRawFolder
        ? <div data-testid="raw-monitored" className="mb-[var(--space-3)]">
          <div className="grid gap-[var(--space-1)] py-[var(--space-2)]">
            <span className={HEADER_KV_KEY}>Monitored RAW folder</span>
            <span className={cn(HEADER_KV_VALUE, "[font-family:var(--font-mono)]")}>{project.monitoredRawFolder.path}</span>
          </div>
          {project.monitoredRawFolder.extraPaths.length > 0 && <div className="grid gap-[var(--space-1)] py-[var(--space-2)]">
            <span className={HEADER_KV_KEY}>Also monitored</span>
            {project.monitoredRawFolder.extraPaths.map((path) => (
              <span key={path} className={cn(HEADER_KV_VALUE, "[font-family:var(--font-mono)] block")}>{path}</span>
            ))}
          </div>}
        </div>
        : <p className="m-0 mb-[var(--space-3)] text-foreground-secondary
                        [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">
          No Editor Input folder is monitored for this project.
        </p>}
      {(project.rawFolderPath || project.rawFolderLink) && project.monitoredRawFolder && <div data-testid="raw-tonomo-secondary" className="mb-[var(--space-3)]">
        {project.rawFolderPath && <div className="grid gap-[var(--space-1)] py-[var(--space-2)]">
          <span className={HEADER_KV_KEY}>Tonomo folder path</span>
          <span className={HEADER_KV_VALUE}>{project.rawFolderPath}</span>
        </div>}
        {project.rawFolderLink && <div className="grid gap-[var(--space-1)] py-[var(--space-2)]">
          <span className={HEADER_KV_KEY}>Tonomo folder link</span>
          <span className={HEADER_KV_VALUE}>{project.rawFolderLink}</span>
        </div>}
        <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
          <StatusPill tone="neutral">Not monitored</StatusPill>
        </div>
        <p className="m-0 text-foreground-secondary
                      [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]">
          RAW is read from the Editor Input folder. This folder is kept for Tonomo change detection and AutoHDR naming.
        </p>
      </div>}
      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        {project.monitoredRawFolder?.webUrl
          ? <a href={project.monitoredRawFolder.webUrl} target="_blank" rel="noreferrer" className={buttonClasses("secondary", { className: "min-h-[44px]" })}>Open in Dropbox</a>
          : null}
        <button
          type="button" disabled={isSyncing} aria-busy={isSyncing || undefined} data-testid="dropbox-sync"
          className={buttonClasses("primary", { className: "min-h-[44px]" })}
          onClick={onSyncDropbox}
        >
          <RefreshCw aria-hidden="true" className="size-[var(--space-4)] shrink-0 stroke-[1.5]" />
          <span>{isSyncing ? "Syncing Dropbox…" : "Sync from Dropbox"}</span>
        </button>
      </div>
      {autohdrBlocked && (
        <p role="status" className="mt-[var(--space-2)] m-0
             [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
             uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-caution-text)]">Blocked</p>
      )}
    </PopoverContent>
  </Popover>;
}
