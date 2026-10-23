import { useCallback, useRef, useState, type ReactElement } from "react";
import { useMediaQuery } from "../../lib/use-media-query";
import { Tooltip, TooltipContent, TooltipTrigger } from "../reui/tooltip";

/**
 * A cut-off title's full text in a tooltip (#934, spec #933 "Tooltip"): the Video tile's open control today, the Video row's title next (#938). Built on the installed ReUI `Tooltip`, with
 * Base UI's own timing (hover opens after 600ms of rest, keyboard focus opens at once, closes at once), the same as the Gantt's.
 *
 * It measures when the tooltip asks to open, not ahead of time (settled plan #933 S2): `scrollWidth > clientWidth` on the child's `[data-title-text]` node, or the child itself when it carries
 * the attribute or has no such node. A measurement taken at that moment is always current after a resize, a font load or a sidebar change, so no tile needs a ResizeObserver. A node with no
 * width (not laid out) fits. A title that fits never opens the tooltip.
 *
 * A coarse pointer (a phone, a touch tablet) gets no tooltip at all: the child is returned as it was, so a tap only ever acts. Same `(pointer: coarse)` feature as the CSS `pointer-coarse:`
 * variant (lesson #692: key JS on the same feature as the CSS). Base UI's tooltip trigger adds no `aria-describedby` or label, so the control's accessible name and description stay its own.
 */
export function TruncatedTitleTip({ text, children }: { text: string; /** One element (a link or a button) that renders the title and accepts a ref. */ children: ReactElement }) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const triggerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  // A callback ref: the trigger renders the child, a link or a button, so Base UI types it as its default button though it may be either.
  const setTrigger = useCallback((node: HTMLElement | null) => { triggerRef.current = node; }, []);
  if (coarse) return children;
  return <Tooltip open={open} onOpenChange={(next) => { setOpen(next && !fits(triggerRef.current)); }}>
    <TooltipTrigger ref={setTrigger} render={children} />
    <TooltipContent data-testid="truncated-title-tip">{text}</TooltipContent>
  </Tooltip>;
}

/** True unless the title's node is laid out and its text runs past its box. */
function fits(trigger: HTMLElement | null): boolean {
  if (!trigger) return true;
  const title = trigger.hasAttribute("data-title-text") ? trigger : trigger.querySelector<HTMLElement>("[data-title-text]") ?? trigger;
  return !(title.scrollWidth > title.clientWidth);
}
