import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, shift, useFloating } from "@floating-ui/react";
import { useEffect } from "react";

type AnchoredPopoverOptions = {
  open: boolean;
  onClose: () => void;
  placement?: "top" | "top-start" | "top-end" | "bottom" | "bottom-start" | "bottom-end";
};

/** Small checklist-facing positioning and close-boundary helper, not an app-wide menu system. */
export function useAnchoredPopover({ open, onClose, placement = "bottom-end" }: AnchoredPopoverOptions) {
  const floating = useFloating({
    open,
    onOpenChange(nextOpen) { if (!nextOpen) onClose(); },
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null, includeFocusBoundary = false) => {
      const node = target as Node | null;
      const reference = floating.refs.reference.current as HTMLElement | null;
      const floatingNode = floating.refs.floating.current;
      if (!node || reference?.contains(node) || floatingNode?.contains(node)) return false;
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
    window.setTimeout(() => (floating.refs.reference.current as HTMLElement | null)?.focus(), 0);
  };
  return { ...floating, onKeyDown };
}

export function AnchoredPopover({ children, context, floatingStyles, initialFocus = 0, onKeyDown }: {
  children: React.ReactNode;
  context: ReturnType<typeof useFloating>["context"];
  floatingStyles: React.CSSProperties;
  initialFocus?: number | React.MutableRefObject<HTMLElement | null>;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  return <FloatingPortal><FloatingFocusManager context={context} modal={false} returnFocus={false} order={["reference", "floating", "content"]} initialFocus={initialFocus}>
    <div ref={context.refs.setFloating} className="subtask-popover" style={floatingStyles} onKeyDown={onKeyDown}>{children}</div>
  </FloatingFocusManager></FloatingPortal>;
}
