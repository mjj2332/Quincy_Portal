import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/reui/popover";
import { buttonClasses } from "./quincy/Button";
import { StatusPill } from "./quincy/StatusPill";
import { cn } from "../lib/utils";
import type { ProjectDetail } from "../lib/project-data";
import { DASHED_TRIGGER, HEADER_KV_KEY, HEADER_KV_VALUE, POPOVER_CONTENT } from "./project-header-popover";

/**
 * #205 — the Dropbox `<section>`'s always-visible content becomes a dashed trigger that opens the
 * same content (raw-monitored, raw-tonomo-secondary, the sync button, the Blocked status line)
 * inside a `reui/popover.tsx` popover, moved verbatim and in the same order. No `keepMounted`: the
 * unmount-on-close is intentional, same rationale as `ProjectHeaderDeadline.tsx`, though this
 * popover holds no draft state to discard — it simply keeps the closed DOM empty.
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
      <span className="grid gap-[var(--space-1)]">
        <span className={HEADER_KV_KEY}>Dropbox</span>
      </span>
      <span className="w-fit"><StatusPill tone={state.tone}>{state.label}</StatusPill></span>
    </PopoverTrigger>
    <PopoverContent align="start" aria-label="Dropbox" className={POPOVER_CONTENT}>
      <PopoverTitle className="!font-medium">Dropbox</PopoverTitle>
      {project.monitoredRawFolder && <div data-testid="raw-monitored" className="mb-[var(--space-4)]">
        <div className="grid gap-[var(--space-1)] py-[var(--space-2)]">
          <span className={HEADER_KV_KEY}>Monitored RAW folder</span>
          <span className={cn(HEADER_KV_VALUE, "[font-family:var(--font-mono)]")}>{project.monitoredRawFolder.path}</span>
        </div>
        <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
          <StatusPill tone="positive">Monitored</StatusPill>
        </div>
        {project.monitoredRawFolder.webUrl
          ? <a href={project.monitoredRawFolder.webUrl} target="_blank" rel="noreferrer" className={buttonClasses("secondary", { className: "min-h-[44px]" })}>Open in Dropbox</a>
          : null}
        {project.monitoredRawFolder.extraPaths.length > 0 && <div className="grid gap-[var(--space-1)] py-[var(--space-2)]">
          <span className={HEADER_KV_KEY}>Also monitored</span>
          {project.monitoredRawFolder.extraPaths.map((path) => (
            <span key={path} className={cn(HEADER_KV_VALUE, "[font-family:var(--font-mono)] block")}>{path}</span>
          ))}
        </div>}
      </div>}
      {(project.rawFolderPath || project.rawFolderLink) && project.monitoredRawFolder && <div data-testid="raw-tonomo-secondary" className="mb-[var(--space-4)]">
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
      <button
        type="button" disabled={isSyncing} aria-busy={isSyncing || undefined} data-testid="dropbox-sync"
        className={buttonClasses("secondary", { className: "min-h-[44px]" })}
        onClick={onSyncDropbox}
      >
        <RefreshCw aria-hidden="true" className="size-[var(--space-4)] shrink-0 stroke-[1.5]" />
        <span>{isSyncing ? "Syncing Dropbox…" : "Sync from Dropbox"}</span>
      </button>
      {autohdrBlocked && (
        <p role="status" className="mt-[var(--space-2)] m-0
             [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
             uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-caution-text)]">Blocked</p>
      )}
    </PopoverContent>
  </Popover>;
}
