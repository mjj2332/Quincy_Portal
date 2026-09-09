import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useFloating,
  useTransitionStatus,
} from "@floating-ui/react";
import { useId, useRef, useState, type JSX, type MutableRefObject, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { Eyebrow } from "./quincy/Eyebrow";
import { OverlayContainerContext } from "./OverlayContainerContext";

export type ModalSize = "wide" | "prose";

// Duplicated from `--dur-base`/`--dur-fast` (tokens/spacing.css) — `useTransitionStatus` cannot
// read a CSS custom property. Exported so a plain unit test can assert the two stay in sync
// (Modal.motion.test.ts) rather than trusting the comment; criterion 21.
export const MODAL_DURATION_OPEN_MS = 220; // === --dur-base
export const MODAL_DURATION_CLOSE_MS = 120; // === --dur-fast

export type ModalProps = {
  open: boolean;
  title: string;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  size?: ModalSize;
  describedBy?: string;
  returnFocus?: boolean;
  testId?: string;
  variant?: string;
  initialFocus?: MutableRefObject<HTMLElement | null> | number;
};

// Overlay elevation/scrim/motion. §10.1 (elevation ladder), §6.2.
// `scrim` is kept as a literal class name alongside the Tailwind utilities — it has no CSS rule
// of its own any more, but ConfirmDialog.dom.test.tsx queries it directly (§12.2's grep rule: a
// querySelector in a test file is a consumer).
// `--overlay-enter`/`--overlay-exit` (§4.3, tokens/spacing.css) pack duration+easing into one
// named value; consumed here via Tailwind's arbitrary-property form (a raw `transition:`
// declaration) rather than split across separate `duration-*`/`ease-*` utilities, so the token
// is the actual, single owner of both overlay motion phases — not just a comment.
const SCRIM = cn(
  "fixed inset-0 z-[var(--z-dialog)] grid place-items-center",
  "p-[var(--space-6)] max-[721px]:p-0 max-[721px]:items-end",
  "bg-[var(--scrim-overlay)] backdrop-blur-[3px]",
  "motion-safe:[transition:opacity_var(--overlay-exit)]",
  "data-open:motion-safe:[transition:opacity_var(--overlay-enter)]",
  "opacity-0 data-open:opacity-100",
);

function panelClasses(size: ModalSize | undefined, wide: boolean): string {
  // `wide` (existing prop) and `size` (new) both resolve to the same max-width ladder; `wide`
  // keeps its exact historical meaning (560px) when no `size` is given.
  const maxWidth = size === "prose" ? "max-w-[820px]" : size === "wide" || wide ? "max-w-[560px]" : "max-w-[460px]";
  return cn(
    "w-full",
    maxWidth,
    // The panel no longer scrolls — `.modal__scroll` does, so the §4.2a nested-overlay slot can
    // sit inside the panel (for stacking and focus) while staying outside any scroll box.
    "max-h-[min(100%,calc(100dvh-var(--space-7)))]",
    "flex flex-col",
    // bg-background (--paper-050), NOT bg-card (--paper-000, pure white) — the dialog stays warm
    // paper. See §6.3: writing bg-card here would visibly lift the dialog off the canvas.
    "bg-background border-solid border-[length:var(--border-width-hair)] border-border",
    "rounded-none shadow-[var(--shadow-lg)]",
    "focus:outline-none",
    // Named overlay-motion tokens (§4.3) — see the note on `SCRIM` above.
    "motion-safe:[transition:opacity_var(--overlay-exit),translate_var(--overlay-exit)]",
    "data-open:motion-safe:[transition:opacity_var(--overlay-enter),translate_var(--overlay-enter)]",
    "opacity-0 translate-y-[var(--space-3)] data-open:opacity-100 data-open:translate-y-0",
    "max-[721px]:max-w-none max-[721px]:max-h-[85dvh]",
  );
}

const PANEL_SCROLL = "flex-1 min-h-0 overflow-auto flex flex-col";

const HEAD = "p-[var(--space-6)] pb-[var(--space-4)]";

const TITLE = "[font:var(--type-h3)] tracking-[var(--tracking-tight)] text-pretty";

// `.modal__body` is kept as a literal class name — no CSS rule of its own, but
// ConfirmDialog.dom.test.tsx queries it directly (same reasoning as `.scrim` above).
const BODY = "flex flex-col gap-[var(--space-4)] px-[var(--space-6)] pb-[var(--space-5)]";

const FOOT = cn(
  "flex flex-wrap justify-end gap-[var(--space-3)] px-[var(--space-6)] py-[var(--space-5)]",
  "[border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border",
  "max-[721px]:flex-col-reverse max-[721px]:[&>*]:w-full max-[721px]:[&>*]:min-h-[44px]",
);

/**
 * The shared dialog primitive. `open` is a real prop, not a mount guard — `Modal` delays its own
 * unmount by `isMounted` so exit motion can render (§6.0). Durations are JS numbers here and CSS
 * values in the classes above; they MUST stay in sync: 220 === --dur-base, 120 === --dur-fast
 * (spacing.css). `useTransitionStatus` cannot read a CSS custom property, so this duplication is
 * unavoidable — acceptance criterion 21 asserts the two agree.
 */
export function Modal({
  open,
  title,
  eyebrow,
  children,
  footer,
  onClose,
  wide = false,
  size,
  describedBy,
  returnFocus = true,
  testId,
  variant,
  initialFocus,
}: ModalProps): JSX.Element | null {
  const titleId = `modal-title-${useId()}`;
  const { context, refs } = useFloating({
    open,
    onOpenChange: (next) => { if (!next) onClose(); },
  });
  const { isMounted, status } = useTransitionStatus(context, {
    duration: { open: MODAL_DURATION_OPEN_MS, close: MODAL_DURATION_CLOSE_MS },
  });
  const dataOpen = status === "open" ? "" : undefined;
  const pressStartedOutside = useRef(false);
  const [nestedSlot, setNestedSlot] = useState<HTMLDivElement | null>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  if (!isMounted) return null;

  return <FloatingPortal>
    <div data-confirm-modal-root={testId === "confirm-modal" ? "" : undefined}>
      <FloatingOverlay
        lockScroll
        className={SCRIM}
        data-testid="modal-scrim"
        data-open={dataOpen}
        onPointerDown={(event) => { pressStartedOutside.current = event.target === event.currentTarget; }}
        onClick={(event) => { if (event.target === event.currentTarget && pressStartedOutside.current) onClose(); }}
      >
        <FloatingFocusManager context={context} modal returnFocus={returnFocus} initialFocus={initialFocus}>
          <div
            ref={refs.setFloating}
            className={panelClasses(size, wide)}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={describedBy}
            tabIndex={-1}
            data-testid={testId}
            data-modal-variant={variant}
            data-open={dataOpen}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            <OverlayContainerContext.Provider value={nestedSlot}>
              <div className={PANEL_SCROLL}>
                {(eyebrow || title) && <div className={HEAD}>
                  {eyebrow && <Eyebrow className="mb-[var(--space-3)]">{eyebrow}</Eyebrow>}
                  {title && <h3 className={TITLE} id={titleId}>{title}</h3>}
                </div>}
                <div className={BODY} data-testid="modal-body">{children}</div>
                {footer && <div className={FOOT}>{footer}</div>}
              </div>
            </OverlayContainerContext.Provider>
            {/* §4.2a: nested-overlay slot. Outside the scroller, inside the panel and the focus
                trap. A popup portaled here (Select/Menu/AnchoredPopover opened from inside this
                dialog) paints inside the FloatingOverlay's z-95 stacking context and stays
                reachable by Tab. */}
            <div ref={setNestedSlot} />
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </div>
  </FloatingPortal>;
}
