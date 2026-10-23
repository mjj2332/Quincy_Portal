import { useCallback, useEffect, useRef, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { hasOpenAlertDialog } from "../../lib/alert-dialog-press";
import { Button } from "../reui/button";
import { IconTip } from "./IconTip";
import { hasOpenModalAboveHost } from "./project-sheet-layers";

/** Back (`-1`) or on (`1`) one film. */
export type StepDelta = -1 | 1;
/** What asked for the step: a host moves focus differently after a button press than after a key (#936). */
export type StepVia = "button" | "key";

/** A text field, a select, or a list a combobox owns: it types or moves with `[` / `]` itself. */
const FIELD = "input, textarea, select, [contenteditable], [role=listbox], [role=combobox]";
/** A layer that owns the keys typed inside it, unless it is the dialog this control lives in. */
const LAYER = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox]";
const HOST_DIALOG = "[role=dialog]";
/** The guest header's touch sizing (#741), kept for the full control. */
const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/**
 * The step a key asks for, or null when something else owns it: a modifier, composition (IME, `keyCode` 229), a field or list, a dialog / alert dialog / menu that is
 * not the host's own dialog, an open confirm, or a modal opened above the host. `anchor` is an element inside the host (the control's own root); with none, the key's
 * target stands in, so a page host (the guest viewer) treats every open modal as above it. A tooltip is none of these, so an open one never blocks a step (#933 Codex).
 */
function stepFor(event: KeyboardEvent, anchor: HTMLElement | null): StepDelta | null {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return null;
  if (event.key !== "[" && event.key !== "]") return null;
  const target = event.target instanceof Element ? event.target : null;
  const hostDialog = anchor?.closest(HOST_DIALOG) ?? null;
  if (target?.closest(FIELD)) return null;
  const layer = target?.closest(LAYER) ?? null;
  if (layer !== null && layer !== hostDialog) return null;
  if (hasOpenAlertDialog(document)) return null;
  if (hasOpenModalAboveHost(anchor ?? (target instanceof HTMLElement ? target : document.body), document)) return null;
  return event.key === "]" ? 1 : -1;
}

/**
 * `[` and `]` step through the films from anywhere on the host while `enabled` (window listener, as the guest viewer had since #741). `hostRef` points inside the dialog
 * that hosts the stepping, so keys typed in that dialog still step while every other layer keeps them; leave it out on a page. `VideoStepControl` calls this for itself;
 * a host that steps by key while it draws no control (the guest's phone bar) calls it directly and gives the control `keys={false}`.
 */
export function useVideoStepKeys(onStep: (delta: StepDelta, via: StepVia) => void, { enabled = true, hostRef }: { enabled?: boolean; hostRef?: RefObject<HTMLElement | null> } = {}) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const delta = stepFor(event, hostRef?.current ?? null);
      if (delta !== null) onStep(delta, "key");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [enabled, hostRef, onStep]);
}

export type VideoStepControlProps = {
  /** 0-based place of the open film in the list being stepped; null when it is not in that list (filtered out): no position is shown. */
  position: number | null;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onStep: (delta: StepDelta, via: StepVia) => void;
  /** "Previous video" / "Next film": the review screens say video, the delivery player says film. */
  noun: "video" | "film";
  /** Icons only at 44px, for the phone review bar; the host shows the position itself. */
  compact?: boolean;
  /** Test id of the "n of N" text; the guest viewer keeps `guest-video-position`. */
  positionTestId?: string;
  /** Own the `[` / `]` keys (default). Off while the host must not step (Full screen, pen down) or when it listens itself. */
  keys?: boolean;
  className?: string;
};

/**
 * Previous / next film (#935, spec #933 "One shared control"): "‹ n of N ›", the ends disabled, each button's tooltip naming its key, and the `[` / `]` keys. The guest
 * viewer, the staff review viewer (#936) and the delivery film player (#937) share it. Inside a dialog the control exempts that dialog from its key rule by itself: it reads
 * the dialog from its own root, so no host passes a ref. The buttons carry `data-testid` `video-step-previous` / `video-step-next` so a host that remounts on a step can put
 * focus back on the same button (`via: "button"`). Composed from the installed `reui/button` (outline icon, ghost 44px when compact) and `quincy/IconTip`.
 */
export function VideoStepControl({ position, total, canPrev, canNext, onStep, noun, compact = false, positionTestId = "video-step-position", keys = true, className }: VideoStepControlProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useRef({ canPrev, canNext, onStep });
  useEffect(() => { live.current = { canPrev, canNext, onStep }; });
  // A key steps only where the matching button is enabled; read through a ref so the window listener is not re-added on every render.
  const stepByKey = useCallback((delta: StepDelta, via: StepVia) => {
    const { canPrev: prev, canNext: next, onStep: step } = live.current;
    if (delta === -1 ? prev : next) step(delta, via);
  }, []);
  useVideoStepKeys(stepByKey, { enabled: keys, hostRef: rootRef });

  const variant = compact ? "ghost" : "outline";
  const buttonClass = compact ? "min-h-11 min-w-11 flex-none text-foreground" : TOUCH;
  const previous = `Previous ${noun}`;
  const next = `Next ${noun}`;
  return <div ref={rootRef} data-testid="video-step-control" className={cn("flex flex-none items-center", compact ? "gap-0" : "gap-[var(--space-2)]", className)}>
    <IconTip label={previous} keys="[">
      <Button type="button" variant={variant} size="icon" aria-label={previous} aria-keyshortcuts="[" data-testid="video-step-previous" className={buttonClass} disabled={!canPrev} onClick={() => { onStep(-1, "button"); }}><ChevronLeft aria-hidden="true" /></Button>
    </IconTip>
    {!compact && (position !== null
      ? <span data-testid={positionTestId} className="text-foreground-secondary tabular-nums [font:var(--type-label)]">{`${position + 1} of ${total}`}</span>
      : <span className="sr-only">Not in the current list</span>)}
    <IconTip label={next} keys="]">
      <Button type="button" variant={variant} size="icon" aria-label={next} aria-keyshortcuts="]" data-testid="video-step-next" className={buttonClass} disabled={!canNext} onClick={() => { onStep(1, "button"); }}><ChevronRight aria-hidden="true" /></Button>
    </IconTip>
  </div>;
}
