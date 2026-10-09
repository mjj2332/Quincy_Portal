import { useEffect, useRef, useState, type Ref } from "react";
import { Button } from "./Button";
import { Progress, ProgressValue } from "../reui/progress";
import { Spinner } from "../reui/spinner";
import { Notice } from "./Notice";

/** Where an upload is: its bytes going up, its HEIC display copy being made by the server (#495), or that copy failing. */
export type EmbeddedUploadPhase = "uploading" | "finishing" | "preparing" | "failed" | "done" | "cancelling";
/** One running upload as the tray shows it. `phase` is `uploading` when absent. */
export type EmbeddedUpload = {
  key: number; name: string; percent: number; kind: "image" | "video"; phase?: EmbeddedUploadPhase;
  /** A failed row's own words (the default is the HEIC "Couldn't prepare" line) and its Retry button's name (#741: a film upload). */
  message?: string; retryLabel?: string; /** A failed row with nothing to retry (the file itself was refused). */ noRetry?: boolean;
  /** Non-blocking cautions shown under the row (#741: a film that is not fast-start). */
  cautions?: readonly string[];
};

const ROW_TEXT = "[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary [overflow-wrap:anywhere]";
/** How long a HEIC may be preparing before the row admits it is slow. */
export const PREPARING_SLOW_AFTER_MS = 60_000;

/** An indeterminate row: the server's progress is unknown, so it shows a spinner (the vendored Progress has no indeterminate look) in a polite status. After a minute the copy says it can take a few minutes. `focusRemove` puts focus on Remove as the row mounts (after a Retry, whose button has just gone). */
function PreparingRow({ name, onRemove, focusRemove }: { name: string; onRemove: () => void; focusRemove: boolean }) {
  const [slow, setSlow] = useState(false);
  const removeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (focusRemove) removeRef.current?.focus(); }, [focusRemove]);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), PREPARING_SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return <div className="flex flex-wrap items-center justify-between gap-[var(--space-1)]">
    <div role="status" aria-live="polite" aria-label={`Preparing ${name}`} className="flex min-w-0 flex-1 items-start gap-[var(--space-1)]"><Spinner aria-hidden="true" role="presentation" className="mt-[calc((var(--text-xs)*var(--leading-normal)-0.875rem)/2)] size-3.5 shrink-0 text-foreground-secondary" /><span className={ROW_TEXT}>{slow ? `Still preparing ${name}… this can take a few minutes` : `Preparing ${name}…`}</span></div>
    <Button ref={removeRef} type="button" variant="text" aria-label={`Remove ${name}`} onClick={onRemove}>Remove</Button>
  </div>;
}

/**
 * The tray under an editor that uploads Embedded media (#493, #494; moved out of `QuincyRichTextEditor` for the whiteboard, #501): one ReUI
 * `Progress` row per running upload (a video's row also has Cancel, since it can run for minutes) and a critical `Notice` per problem.
 * A HEIC (#495) goes on to a `preparing` row (a `Spinner` with Remove) and, if its JPEG cannot be made, a `failed` row
 * (a critical `Notice` with Retry and Remove). Renders nothing when there is nothing to show. The owner keeps the uploads, their abort controllers and the errors.
 */
export function EmbeddedUploadTray({ uploads, errors, onCancel, onRemove = onCancel, onRetry, testId = "rich-text-upload-tray", className }: {
  uploads: readonly EmbeddedUpload[];
  errors: readonly string[];
  /** Cancel a running video upload. */
  onCancel: (key: number) => void;
  /** Remove a preparing or failed row, which is not a cancellation. Defaults to `onCancel`. */
  onRemove?: (key: number) => void;
  /** Retry a failed one. */
  onRetry?: (key: number) => void;
  testId?: string;
  className?: string;
}) {
  // The failed row's Retry unmounts when it is pressed; the preparing row that replaces it takes focus.
  const retried = useRef<number | null>(null);
  if (uploads.length === 0 && errors.length === 0) return null;
  return <div data-testid={testId} className={className ?? "grid gap-[var(--space-2)]"}>
    {uploads.map((entry) => {
      if (entry.phase === "preparing") return <PreparingRow key={entry.key} name={entry.name} onRemove={() => onRemove(entry.key)} focusRemove={retried.current === entry.key} />;
      // #741: a film that went up with a caution the person has not seen yet (one only the server raised). It stays until dismissed.
      if (entry.phase === "done") return <Notice key={entry.key} tone="caution" role="status" className="flex flex-wrap items-center justify-between gap-[var(--space-1)]">
        <span className="grid min-w-0 gap-[var(--space-1)] [overflow-wrap:anywhere]"><span>{entry.name} uploaded, with a warning.</span>{entry.cautions?.map((caution) => <span key={caution}>{caution}</span>)}</span>
        <Button type="button" variant="text" aria-label={`Dismiss warning for ${entry.name}`} onClick={() => onRemove(entry.key)}>Dismiss</Button>
      </Notice>;
      // #741: Cancel pressed, the server not yet confirmed. The row stays so the person knows the reservation may still be held.
      if (entry.phase === "cancelling") return <div key={entry.key} role="status" aria-live="polite" className={ROW_TEXT}>{`Cancelling ${entry.name}…`}</div>;
      if (entry.phase === "failed") return <Notice key={entry.key} tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-1)]">
        <span className="min-w-0 [overflow-wrap:anywhere]">{entry.message ?? `Couldn't prepare ${entry.name}`}</span>
        <span className="flex flex-wrap items-center gap-[var(--space-1)]">
          {onRetry && !entry.noRetry && <Button type="button" variant="text" aria-label={entry.retryLabel ? `${entry.retryLabel} ${entry.name}` : `Retry preparing ${entry.name}`} onClick={() => { retried.current = entry.key; onRetry(entry.key); }}>{entry.retryLabel ?? "Retry"}</Button>}
          <Button type="button" variant="text" aria-label={`Remove ${entry.name}`} onClick={() => onRemove(entry.key)}>Remove</Button>
        </span>
      </Notice>;
      const verb = entry.phase === "finishing" ? "Finishing" : "Uploading";
      return <div key={entry.key} className="grid gap-[var(--space-1)]"><div className="flex flex-wrap items-center justify-between gap-[var(--space-1)]">
        <Progress value={entry.percent} aria-label={`${verb} ${entry.name}`} className="flex min-w-0 flex-1 flex-wrap items-baseline gap-[var(--space-1)]"><span className={ROW_TEXT}>{verb} {entry.name}…</span><ProgressValue data-testid="upload-progress-value" className="[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary" /></Progress>
        {entry.kind === "video" && <Button type="button" variant="text" aria-label={`Cancel upload of ${entry.name}`} onClick={() => onCancel(entry.key)}>Cancel</Button>}
      </div>{entry.cautions?.map((caution) => <Notice key={caution} tone="caution" role="status">{caution}</Notice>)}</div>;
    })}
    {errors.map((message, index) => <Notice key={index} tone="critical" role="alert">{message}</Notice>)}
  </div>;
}
