import type { Ref } from "react";
import { Button } from "../reui/button";
import { Progress, ProgressValue } from "../reui/progress";
import { Notice } from "./Notice";

/** One running upload as the tray shows it. */
export type EmbeddedUpload = { key: number; name: string; percent: number; kind: "image" | "video" };

/**
 * The tray under an editor that uploads Embedded media (#493, #494; moved out of `QuincyRichTextEditor` for the whiteboard, #501): one ReUI
 * `Progress` row per running upload (a video's row also has Cancel, since it can run for minutes) and a critical `Notice` per problem.
 * Renders nothing when there is nothing to show. The owner keeps the uploads, their abort controllers and the errors.
 */
export function EmbeddedUploadTray({ uploads, errors, onCancel, trayRef, testId = "rich-text-upload-tray", className }: {
  uploads: readonly EmbeddedUpload[];
  errors: readonly string[];
  onCancel: (key: number) => void;
  trayRef?: Ref<HTMLDivElement>;
  testId?: string;
  className?: string;
}) {
  if (uploads.length === 0 && errors.length === 0) return null;
  return <div ref={trayRef} data-testid={testId} className={className ?? "grid gap-[var(--space-2)]"}>
    {uploads.map((entry) => <div key={entry.key} className="flex flex-wrap items-center justify-between gap-[var(--space-1)]">
      <Progress value={entry.percent} aria-label={`Uploading ${entry.name}`} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-[var(--space-1)]"><span className="[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary [overflow-wrap:anywhere]">Uploading {entry.name}…</span><ProgressValue data-testid="upload-progress-value" className="[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary" /></Progress>
      {entry.kind === "video" && <Button type="button" variant="ghost" aria-label={`Cancel upload of ${entry.name}`} onClick={() => onCancel(entry.key)}>Cancel</Button>}
    </div>)}
    {errors.map((message, index) => <Notice key={index} tone="critical" role="alert">{message}</Notice>)}
  </div>;
}
