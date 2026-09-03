import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useFloating,
  useTransitionStatus,
} from "@floating-ui/react";
import { useContext, useEffect } from "react";

import { cn } from "../lib/utils";
import { OverlayContainerContext } from "./OverlayContainerContext";

// Duplicated from `--dur-base`/`--dur-fast` (tokens/spacing.css) — `useTransitionStatus` cannot
// read a CSS custom property. Exported so a plain unit test can assert the two stay in sync
// (Modal.motion.test.ts) rather than trusting the comment; criterion 21.
export const POPOVER_DURATION_OPEN_MS = 220; // === --dur-base
export const POPOVER_DURATION_CLOSE_MS = 120; // === --dur-fast

type AnchoredPopoverOptions = {
  open: boolean;
  onClose: () => void;
  placement?: "top" | "top-start" | "top-end" | "bottom" | "bottom-start" | "bottom-end";
};

// §7.3 shared popover paint, applied by `AnchoredPopover` itself, replacing the four
// hand-written CSS panels (`.project-team-picker`, `.kanban-move-popover`, `.subtask-popover`
// panel-level properties). Consumers' own scoped class (e.g. "kanban-move-popover") stays as a
// content-selector/test hook; it no longer carries panel-level CSS.
const PANEL = cn(
  "z-[var(--z-popover)] w-max",
  "max-w-[min(320px,calc(100vw-var(--space-4)))]",
  "max-h-[min(420px,calc(100dvh-var(--space-5)))] overflow-auto",
  "bg-popover border-solid border-[length:var(--border-width-hair)] border-border",
  "rounded-none shadow-[var(--shadow-md)]",
  // `--overlay-enter`/`--overlay-exit` (§4.3) — the arbitrary-property form consumes the named
  // composite token directly, rather than splitting it back into separate duration/ease utilities.
  "motion-safe:[transition:opacity_var(--overlay-exit),translate_var(--overlay-exit)]",
  "data-open:motion-safe:[transition:opacity_var(--overlay-enter),translate_var(--overlay-enter)]",
  "opacity-0 translate-y-[var(--space-1)] data-open:opacity-100 data-open:translate-y-0",
);

/**
 * The content stack inside a `PANEL`. Padding lives here, not on the panel — the panel is
 * `overflow: auto`, and padding on a scroll container clips its own last child's ring.
 */
const POPOVER_CONTENT = "grid gap-[var(--space-2)] p-[var(--space-3)] min-w-0";

/** A labelled control inside `POPOVER_CONTENT`. The eyebrow treatment `FieldLabel` uses. */
const POPOVER_LABEL =
  "grid gap-[var(--space-1)] min-w-0 " +
  "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

/**
 * The action row that closes a popover or a composer.
 *
 * Deliberately NOT `justify-end`. Both consumers align by content, not by the container:
 * the checklist composer pushes its buttons right with an existing `<span className="flex-1" />`
 * spacer (which `max-[601px]:hidden` collapses), and the schedule popover's actions are
 * left-aligned under a left-aligned form. `justify-end` here would fight the spacer.
 *
 * Wrapping starts at <=600px only — that is where `app.css`'s `@media (max-width: 600px)` block
 * puts it today, and TB8-07 preserves that breakpoint rather than folding it into the app's
 * usual 721px.
 */
const POPOVER_ACTIONS = "flex items-center gap-[var(--space-2)] min-w-0 max-[601px]:flex-wrap";

/**
 * Every control rendered inside a `PANEL` needs an INWARD focus ring: the panel is bordered and
 * `overflow: auto`, so an outward ring is clipped at the edge. And it must be `!`-prefixed —
 * `tokens/base.css`'s unlayered `:focus-visible { outline: … }` is a shorthand, which resets
 * `outline-offset`, and unlayered author CSS beats `@layer utilities` regardless of specificity.
 * Writing only the offset utility silently loses on both counts (TB8-07 §4.3; `docs/lessons.md`,
 * "A shorthand always resets its longhands").
 */
const RING_IN =
  "focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-[-2px]";

/** Small checklist-facing positioning and close-boundary helper, not an app-wide menu system. */
export function useAnchoredPopover({ open, onClose, placement = "bottom-end" }: AnchoredPopoverOptions) {
  // §4.2a: the other half of the nested-overlay mechanism (`Select`/`Menu` both set this). A
  // popover opened from inside a dialog must resolve its position against the viewport, not
  // against `.modal__scroll`'s scroll box, which `strategy: "absolute"` (the default) would clip
  // it against. Normalised to `undefined` at page level for the same reason `root` is below —
  // `undefined` means "no explicit strategy", not "force absolute".
  const container = useContext(OverlayContainerContext) ?? undefined;
  const floating = useFloating({
    open,
    onOpenChange(nextOpen) { if (!nextOpen) onClose(); },
    placement,
    strategy: container ? "fixed" : "absolute",
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  // Exit motion (defect D). The consumer's JSX gate must switch from `open &&` to `mounted &&` —
  // `mounted` stays true through the close transition so the popover can animate out instead of
  // vanishing on the boolean, exactly the reason `Modal` needed the same split (§6.0).
  const { isMounted: mounted, status } = useTransitionStatus(floating.context, {
    duration: { open: POPOVER_DURATION_OPEN_MS, close: POPOVER_DURATION_CLOSE_MS },
  });

  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null, includeFocusBoundary = false) => {
      const node = target as Node | null;
      const reference = floating.refs.reference.current as HTMLElement | null;
      const floatingNode = floating.refs.floating.current;
      if (!node || reference?.contains(node) || floatingNode?.contains(node)) return false;
      if (node instanceof Element && node.closest("[data-confirm-modal-root]")) return false;
      if (!includeFocusBoundary || !(node instanceof Element)) return true;
      if (node.matches("[data-floating-ui-focus-guard]") || node.closest("[data-floating-ui-focus-guard]")) return false;
      return !floatingNode?.closest("[data-floating-ui-portal]")?.contains(node);
    };
    const onPointerDown = (event: PointerEvent) => { if (outside(event.target)) onClose(); };
    const onFocusIn = (event: FocusEvent) => { if (outside(event.target, true)) onClose(); };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("focusin", onFocusIn);
    return () => { window.removeEventListener("pointerdown", onPointerDown); window.removeEventListener("focusin", onFocusIn); };
  }, [floating.refs.floating, floating.refs.reference, onClose, open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    onClose();
    // TB0 fix (08f4653): synchronous, no setTimeout/queueMicrotask/requestAnimationFrame/effect —
    // see docs/lessons.md. A deferred call here can steal focus from a popover opened afterwards.
    (floating.refs.reference.current as HTMLElement | null)?.focus();
  };
  return { ...floating, onKeyDown, mounted, status };
}

export function AnchoredPopover({
  children,
  context,
  floatingStyles,
  initialFocus = 0,
  onKeyDown,
  className = "subtask-popover",
  modal = false,
  label,
  status,
  role,
}: {
  children: React.ReactNode;
  context: ReturnType<typeof useFloating>["context"];
  floatingStyles: React.CSSProperties;
  initialFocus?: number | React.MutableRefObject<HTMLElement | null>;
  onKeyDown: (event: React.KeyboardEvent) => void;
  className?: string;
  modal?: boolean;
  /** Renders `aria-label` on the floating div — for a consumer (e.g. the absorbed team picker)
   *  that labels the floating div itself rather than wrapping an inner `role="group"`. */
  label?: string;
  /** `useAnchoredPopover`'s `status`, so entrance/exit motion (`data-open`) can render. */
  status?: "unmounted" | "initial" | "open" | "close";
  /** The absorbed team picker labels its floating div `role="dialog"` (it composes a search
   *  input with a listbox, which is not a plain listbox). Other consumers leave this unset. */
  role?: string;
}) {
  // §4.2a: a popover opened from inside a dialog portals into the dialog's nested-overlay slot
  // instead of `document.body`. `null` at every call site in this release (none sit inside a
  // dialog today), so this compiles to today's behavior exactly. NOTE: `FloatingPortal`'s `root`
  // treats an explicit `null` as "wait for a container to resolve" and never falls back to
  // `document.body` (floating-ui.react.mjs's `useFloatingPortalNode`) — only `undefined` does
  // that — so the page-level `null` from the context must be normalised to `undefined` here.
  const container = useContext(OverlayContainerContext) ?? undefined;
  return <FloatingPortal root={container}>
    <FloatingFocusManager context={context} modal={modal} returnFocus={false} order={["reference", "floating", "content"]} initialFocus={initialFocus}>
      <div
        ref={context.refs.setFloating}
        className={cn(className, PANEL)}
        style={floatingStyles}
        role={role}
        aria-label={label}
        data-open={status === "open" ? "" : undefined}
        onKeyDown={onKeyDown}
      >{children}</div>
    </FloatingFocusManager>
  </FloatingPortal>;
}

export { POPOVER_CONTENT, POPOVER_LABEL, POPOVER_ACTIONS, RING_IN };
