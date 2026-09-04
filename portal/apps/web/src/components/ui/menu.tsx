import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "@/lib/utils";
import { OverlayContainerContext } from "@/components/OverlayContainerContext";

// Built on @base-ui/react's Menu primitives — not @floating-ui/react. See TB8-02 plan §2.1 for
// why the two shared overlay primitives (`Modal`, `AnchoredPopover`) stay on floating-ui while
// this one deliberately does not: Menu.Root ships the full role="menu" keyboard contract
// (roving focus, wrap-around, Home/End, typeahead, Escape-with-focus-return, outside-dismiss)
// complete, so nothing here hand-assembles it — the same reasoning TB8-01 §2.2 applied to
// `Select`. Consumers needing the item-level parts (`Menu.Item`, `Menu.LinkItem`, …) import
// `{ Menu as MenuPrimitive } from "@base-ui/react/menu"` directly, alongside this wrapper.

export type MenuSide = "top" | "bottom" | "left" | "right";
export type MenuAlign = "start" | "center" | "end";

// Trigger reset only — bespoke per-consumer visuals (notification bell, hamburger button) come
// through `triggerClassName`; this supplies just the shared focus-visible ring and removes
// native button chrome.
const TRIGGER = cn(
  "inline-flex items-center justify-center bg-transparent border-0 cursor-pointer",
  "disabled:cursor-not-allowed disabled:opacity-60",
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid",
  "focus-visible:outline-ring focus-visible:outline-offset-2",
);

// §7.3's shared popover paint, reused for the app's two menus (§8.2).
const PANEL = cn(
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

export type MenuProps = {
  trigger: React.ReactNode;
  triggerLabel: string;
  label: string;
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  triggerClassName?: string;
  panelClassName?: string;
  side?: MenuSide;
  align?: MenuAlign;
  sideOffset?: number;
  popupRef?: React.Ref<HTMLDivElement>;
  /**
   * Dim the page behind the open menu. Off by default: a dropdown list under an icon (the
   * notification bell) should not dim the page, while a full-height phone navigation surface must,
   * or the page shows through beside the panel and reads as a rendering fault (D-01).
   */
  backdrop?: boolean;
};

/**
 * The app's shared dropdown-menu primitive. `modal={false}` is deliberate — these are dropdown
 * menus in a sticky bar, not modal surfaces (`modal` would `aria-hidden` the page behind a
 * notification list).
 */
export function Menu({
  trigger,
  triggerLabel,
  label,
  children,
  open,
  defaultOpen,
  onOpenChange,
  disabled,
  triggerClassName,
  panelClassName,
  side = "bottom",
  align = "end",
  sideOffset = 10,
  popupRef,
  backdrop = false,
}: MenuProps) {
  // §4.2a nested-overlay container: null at page level — both Topbar menus render there today,
  // so this is wiring for a future candidate (notification bell/preferences/Admin delivery UI)
  // that puts a menu inside a dialog, not a behavior change here. Normalised to `undefined` —
  // the portal treats an explicit `null` as "wait forever", never falling back to `body`.
  const container = React.useContext(OverlayContainerContext) ?? undefined;
  return (
    <MenuPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} modal={false} disabled={disabled}>
      <MenuPrimitive.Trigger className={cn(TRIGGER, triggerClassName)} aria-label={triggerLabel}>
        {trigger}
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal container={container}>
        {backdrop && (
          <MenuPrimitive.Backdrop className={cn(
            // Same z-index as the Positioner below, deliberately: the Backdrop is rendered first, and
            // equal z-index resolves by DOM order, so the panel paints above its own scrim without a
            // new stacking token. `tokens/spacing.css:58-63` defines only --z-popover (90), --z-dialog
            // (95) and --z-toast (98) — there is nothing below 90, and inventing one for a single
            // sibling pair would be a token with no second consumer.
            "fixed inset-0 z-[var(--z-popover)] bg-[var(--scrim-overlay)] backdrop-blur-[3px]",
            "motion-safe:[transition:opacity_var(--overlay-exit)]",
            "data-open:motion-safe:[transition:opacity_var(--overlay-enter)]",
            "opacity-0 data-open:opacity-100",
          )} />
        )}
        <MenuPrimitive.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          positionMethod={container ? "fixed" : "absolute"}
          className="z-[var(--z-popover)] outline-none"
        >
          <MenuPrimitive.Popup ref={popupRef} className={cn(PANEL, panelClassName)} aria-label={label}>
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

export { MenuPrimitive };
