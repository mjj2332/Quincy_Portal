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
  /**
   * Required unless `triggerRender` is given — #122's `triggerRender` supplies its own content
   * (e.g. a full `SidebarMenuButton`), so a second, redundant `trigger` node has nothing to add.
   */
  trigger?: React.ReactNode;
  triggerLabel: string;
  label: string;
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  triggerClassName?: string;
  triggerTestId?: string;
  /**
   * #122: renders the trigger AS this element (Base UI's `render` prop) instead of the default
   * `<button>` — how `NavigationRail`'s collapsed parents make the whole `SidebarMenuButton` the
   * menu's own trigger, so `Menu`'s own focus/aria/data-testid props (`triggerLabel`,
   * `triggerTestId`, `triggerClassName`) still land where they always did, merged onto whatever
   * `triggerRender` provides. Additive — every existing caller that omits it keeps the default
   * `<button>` unchanged.
   *
   * `TRIGGER` (below) is a reset for the primitive's own bare `<button>` — `border-0`,
   * `bg-transparent`, `justify-center`, … — and is deliberately NOT applied when `triggerRender` is
   * given (`/code-review`, #122): a caller-supplied element owns its own chrome, and `TRIGGER`'s
   * `border-0` would otherwise compete with that element's own border utilities (e.g.
   * `NavigationRail`'s `ROW_PAINT`, whose active-row hairline border can vanish under it).
   */
  triggerRender?: React.ReactElement;
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
  triggerTestId,
  triggerRender,
  panelClassName,
  side = "bottom",
  align = "end",
  sideOffset = 10,
  popupRef,
  backdrop = false,
}: MenuProps) {
  // §4.2a nested-overlay container: null at page level — the rail's account menu renders there
  // today, so this is wiring for a future candidate (preferences/Admin delivery UI) that puts a
  // menu inside a dialog, not a behavior change here. Normalised to `undefined` —
  // the portal treats an explicit `null` as "wait forever", never falling back to `body`.
  const container = React.useContext(OverlayContainerContext) ?? undefined;
  // Internal only — no `triggerRef` prop exists on `MenuProps`. Base UI merges a `ref` onto
  // whatever `render`/`triggerRender` produces, the same way it merges every other prop, so this
  // reaches the real trigger element regardless of which form is in play (#122 P3).
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  // `popupRef` is a caller-facing prop — this merges our own internal read alongside a caller's
  // own ref rather than replacing it.
  const internalPopupRef = React.useRef<HTMLDivElement>(null);
  const setPopupRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      internalPopupRef.current = node;
      if (typeof popupRef === "function") popupRef(node);
      else if (popupRef) (popupRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [popupRef],
  );
  // Inside a modal Dialog (the narrow Sheet), `DialogPopup`'s own `FloatingFocusManager` runs
  // `restoreFocus: "popup"` — removing the focused menu item leaves `activeElement` briefly
  // homeless, and its NEXT frame refocuses the Sheet itself, after this Menu's own return-focus.
  // Moving focus to the trigger first means that never happens; page-level menus are unaffected.
  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && container && internalPopupRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus();
    }
    onOpenChange?.(nextOpen);
  }
  return (
    <MenuPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={handleOpenChange} modal={false} disabled={disabled}>
      <MenuPrimitive.Trigger
        ref={triggerRef}
        className={triggerRender ? triggerClassName : cn(TRIGGER, triggerClassName)}
        aria-label={triggerLabel}
        data-testid={triggerTestId}
        render={triggerRender}
      >
        {trigger}
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal container={container}>
        {backdrop && (
          <MenuPrimitive.Backdrop
            data-testid="menu-backdrop"
            className={cn(
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
          <MenuPrimitive.Popup ref={setPopupRef} className={cn(PANEL, panelClassName)} aria-label={label}>
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

export { MenuPrimitive };
