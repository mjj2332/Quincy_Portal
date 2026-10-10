import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import type { MarkerExportFormat, MarkerExportStatus, VideoNoteThreadDto } from "@quincy/shared";
import { ApiError } from "../../lib/api";
import { onPrincipalTerminal } from "../../lib/principal-terminal";
import { useOptionalProjectQueryClient, useProjectAccessTermination } from "../../lib/project-data";
import {
  DEFAULT_MARKER_EXPORT_OPTIONS, EDL_LIMIT, MARKER_EXPORT_EMPTY, MARKER_EXPORT_PREPARING, markerExportCount, markerExportFailureMessage, markerExportPreviewName, requestMarkerExport, saveBlob,
  type MarkerExportFailure, type MarkerExportOptions,
} from "../../lib/video-marker-export";
import { Button } from "../quincy/Button";
import { MENU_ITEM, MenuPrimitive } from "../quincy/menu";
import { Notice } from "../quincy/Notice";

/**
 * NLE marker export in the notes panel's ⋯ menu (#741 9). The options live here, per Version on screen, never persisted and never shared with the panel's filters.
 * Anything that changes who or what the export is for (Version, Project, person, the part going off, the viewer closing) aborts the request and fences its completion,
 * so a late file is never saved.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; message: string }
  | { kind: "error"; failure: MarkerExportFailure; format: MarkerExportFormat; options: MarkerExportOptions };

const STATUS_CHOICES: Array<{ value: MarkerExportStatus; label: string }> = [{ value: "all", label: "All" }, { value: "open", label: "Open only" }, { value: "resolved", label: "Resolved only" }];
const FORMATS: Array<{ format: MarkerExportFormat; label: string; testId: string }> = [
  { format: "edl", label: "DaVinci Resolve markers (.edl)", testId: "video-export-edl" },
  { format: "fcpxml", label: "Final Cut Pro markers (.fcpxml)", testId: "video-export-fcpxml" },
];
const OPTION_ITEM = "relative pe-[var(--space-6)]";
const LABEL_TEXT = "[font:var(--type-label)]";
const SECONDARY = `text-foreground-secondary ${LABEL_TEXT}`;

export type MarkerExport = ReturnType<typeof useMarkerExport>;

export function useMarkerExport({ enabled, projectId, assetId, userId, title, version, threads }: {
  enabled: boolean; projectId: string; assetId: string; userId: string | null; title: string; version: number; threads: readonly VideoNoteThreadDto[] | undefined;
}) {
  const queryClient = useOptionalProjectQueryClient();
  const terminate = useProjectAccessTermination();
  const identity = `${enabled ? "on" : "off"}|${projectId}|${assetId}|${userId ?? ""}`;
  const [held, setHeld] = useState({ identity, options: DEFAULT_MARKER_EXPORT_OPTIONS, phase: { kind: "idle" } as Phase });
  // The person, Project, Version or gate changed: the options and any message belong to the old one.
  if (held.identity !== identity) setHeld({ identity, options: DEFAULT_MARKER_EXPORT_OPTIONS, phase: { kind: "idle" } });
  const live = held.identity === identity ? held : { identity, options: DEFAULT_MARKER_EXPORT_OPTIONS, phase: { kind: "idle" } as Phase };

  const identityRef = useRef(identity);
  identityRef.current = identity;
  const controller = useRef<AbortController | null>(null);
  const abort = useCallback(() => { controller.current?.abort(); controller.current = null; }, []);
  useEffect(() => abort, [identity, abort]); // leaving this identity (or unmounting) aborts what it started
  useEffect(() => onPrincipalTerminal((terminated) => { if (terminated === undefined || terminated === queryClient) abort(); }), [abort, queryClient]);

  const set = useCallback((phase: Phase) => { setHeld((current) => (current.identity === identityRef.current ? { ...current, phase } : current)); }, []);
  const setOptions = useCallback((next: Partial<MarkerExportOptions>) => { setHeld((current) => (current.identity === identityRef.current ? { ...current, options: { ...current.options, ...next } } : current)); }, []);

  const count = useMemo(() => (threads ? markerExportCount(threads, live.options) : null), [threads, live.options]);
  const pending = live.phase.kind === "pending";

  const start = useCallback(async (format: MarkerExportFormat, options: MarkerExportOptions) => {
    if (!enabled || controller.current !== null) return; // one request at a time, decided synchronously
    const mine = new AbortController();
    controller.current = mine;
    const captured = identityRef.current;
    set({ kind: "pending" });
    const result = await requestMarkerExport({ projectId, assetId, title, version, format, options, signal: mine.signal });
    if (controller.current === mine) controller.current = null;
    // Fence: the Version, Project, person or gate moved on, or the request was cancelled: nothing is saved and nothing is said.
    if (mine.signal.aborted || identityRef.current !== captured) return;
    if (!result.ok) {
      if (result.aborted) return;
      if (result.failure.kind === "unauthorized") terminate(new ApiError("Unauthorized", 401));
      set({ kind: "error", failure: result.failure, format, options });
      return;
    }
    saveBlob(result.blob, result.filename);
    set({ kind: "done", message: result.count === 0 || result.blob.size === 0 ? MARKER_EXPORT_EMPTY : "" });
  }, [enabled, projectId, assetId, title, version, set, terminate]);

  return { enabled, options: live.options, setOptions, phase: live.phase, pending, count, title, version, start };
}

/** The "Export markers" group inside the ⋯ menu. */
export function MarkerExportMenuItems({ exp }: { exp: MarkerExport }) {
  const { options, setOptions, count, pending, start } = exp;
  const overflow = count !== null && count > EDL_LIMIT;
  return <MenuPrimitive.Group data-testid="video-export-group">
    <MenuPrimitive.GroupLabel className={`px-[var(--space-3)] pt-[var(--space-2)] text-foreground-secondary ${LABEL_TEXT}`}>Export markers</MenuPrimitive.GroupLabel>
    <MenuPrimitive.CheckboxItem
      className={`${MENU_ITEM} ${OPTION_ITEM}`}
      data-testid="video-export-internal"
      checked={options.includeInternal}
      onCheckedChange={(checked) => { setOptions({ includeInternal: checked }); }}
    >
      Include internal notes
      <MenuPrimitive.CheckboxItemIndicator className="absolute end-[var(--space-3)]"><CheckIcon aria-hidden="true" className="size-4" /></MenuPrimitive.CheckboxItemIndicator>
    </MenuPrimitive.CheckboxItem>
    <MenuPrimitive.RadioGroup value={options.status} onValueChange={(value) => { setOptions({ status: value as MarkerExportStatus }); }} aria-label="Notes to export">
      {STATUS_CHOICES.map((choice) => <MenuPrimitive.RadioItem key={choice.value} value={choice.value} data-testid={`video-export-status-${choice.value}`} className={`${MENU_ITEM} ${OPTION_ITEM}`}>
        {choice.label}
        <MenuPrimitive.RadioItemIndicator className="absolute end-[var(--space-3)]"><CheckIcon aria-hidden="true" className="size-4" /></MenuPrimitive.RadioItemIndicator>
      </MenuPrimitive.RadioItem>)}
    </MenuPrimitive.RadioGroup>
    <MenuPrimitive.Separator className="my-[var(--space-1)] h-px bg-border" />
    <div data-testid="video-export-count" className={`px-[var(--space-3)] pb-[var(--space-1)] ${SECONDARY}`}>{count === null ? "Counting markers…" : `${count} ${count === 1 ? "marker" : "markers"}`}</div>
    {FORMATS.map(({ format, label, testId }) => {
      const blocked = format === "edl" && overflow;
      const hintId = `${testId}-hint`;
      return <MenuPrimitive.Item
        key={format}
        data-testid={testId}
        className={`${MENU_ITEM} !flex-col !items-start gap-[var(--space-1)]`}
        disabled={pending || blocked}
        aria-describedby={blocked ? hintId : undefined}
        onClick={() => { void start(format, options); }}
      >
        <span>{label}</span>
        <span data-testid={`${testId}-name`} className={`${SECONDARY} [overflow-wrap:anywhere]`}>{markerExportPreviewName(exp.title, exp.version, format, options)}</span>
        {blocked && <span id={hintId} data-testid="video-export-edl-hint" className={`text-signal-critical ${LABEL_TEXT}`}>{`Resolve EDL supports up to ${EDL_LIMIT} markers (${count} selected). Use FCPXML or choose fewer notes.`}</span>}
      </MenuPrimitive.Item>;
    })}
  </MenuPrimitive.Group>;
}

/** Pending, empty and failure messages, outside the menu (which has closed by then). */
export function MarkerExportNotices({ exp, className }: { exp: MarkerExport; className?: string }): ReactNode {
  const { phase, start } = exp;
  if (phase.kind === "pending") return <Notice tone="caution" role="status" data-testid="video-export-status" className={className}>{MARKER_EXPORT_PREPARING}</Notice>;
  if (phase.kind === "done") return phase.message === "" ? null : <Notice tone="caution" role="status" data-testid="video-export-status" className={className}>{phase.message}</Notice>;
  if (phase.kind !== "error") return null;
  const { failure, format, options } = phase;
  return <Notice tone="critical" role="alert" data-testid="video-export-error" className={`flex flex-wrap items-center justify-between gap-[var(--space-2)] ${className ?? ""}`}>
    <span>{markerExportFailureMessage(failure)}</span>
    {failure.kind === "overflow" && <Button type="button" variant="text" data-testid="video-export-recover" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={() => { void start("fcpxml", options); }}>Download FCPXML</Button>}
    {failure.kind === "failed" && <Button type="button" variant="text" data-testid="video-export-retry" className="pointer-coarse:min-h-11 max-[721px]:min-h-11" onClick={() => { void start(format, options); }}>Try again</Button>}
  </Notice>;
}
