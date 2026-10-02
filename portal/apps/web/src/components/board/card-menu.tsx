import type { ComponentProps } from "react";
import { Ellipsis } from "lucide-react";
import { Button } from "../reui/button";
import { ContextMenuContent, ContextMenuItem } from "../reui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../reui/dropdown-menu";
import { MENU_SURFACE_CLASS } from "../quincy/menu-surface";
import type { CardAction, CardActionId } from "./card-actions";
import type { MoveToDialogProps } from "./move-to-control";

/**
 * What the Board hands a card to build its two menus from (#432). `actions` is empty when the card
 * has no menu (nothing to offer, or archived).
 */
export type CardMenuConfig = {
  actions: CardAction[];
  /** The `controlsDisabled(id)` verdict: disables the ⋯ trigger, and every item with it. */
  disabled: boolean;
  /** True while any drag is live: the right-click menu must not open over it. */
  dragActive: boolean;
  /** Admin Board-order nudges, reported to the Dashboard for it to resolve. */
  onReorder: (direction: "up" | "down") => void;
  /** Everything the Move to… dialog needs beyond the card itself. */
  moveTo: Omit<MoveToDialogProps, "project" | "open" | "anchor" | "onClose">;
};

/** What the card hands its two menus: the descriptors plus its own handlers (it owns the Move to… hand-off). */
export type CardMenuBinding = {
  actions: CardAction[];
  disabled: boolean;
  onSelect: (id: CardActionId) => void;
  /** Called after either menu has finished closing; the card opens a pending Move to… dialog from here. */
  onClosed: () => void;
  /** Registers the ⋯ trigger, which Move to… anchors to and refocuses. */
  /** `finalFocus` for both menus: false while a Move to… hand-off is pending. */
  returnFocus: () => boolean;
  triggerRef: (element: HTMLButtonElement | null) => void;
};

/** One surface for both menus (and, since #463, the Calendar's and Timeline's item menu): `quincy/menu-surface.ts`. */
const CARD_MENU_CONTENT_CLASS = MENU_SURFACE_CLASS;

/**
 * The ⋯ trigger and its menu. A SIBLING of the card's link (the drag handle), raised above its
 * overlay: a press on it can never start a drag. Always visible, never hover-revealed (TB8-07), 44px
 * at ≤641px and on a coarse pointer.
 */
export function CardActionsMenu({ projectId, street, menu }: { projectId: string; street: string; menu: CardMenuBinding }) {
  return (
    <DropdownMenu onOpenChangeComplete={(open) => { if (!open) menu.onClosed(); }}>
      <DropdownMenuTrigger
        disabled={menu.disabled}
        render={
          <Button
            ref={menu.triggerRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-[var(--space-2)] right-[var(--space-2)] z-[1] max-[641px]:size-11 pointer-coarse:size-11 border-[color-mix(in_srgb,var(--ink-900)_18%,transparent)] bg-[color-mix(in_srgb,var(--paper-000)_88%,transparent)] text-foreground-secondary disabled:bg-surface-sunken"
            aria-label={`Actions for ${street}`}
            data-testid="board-card-menu"
            data-focus-key={`card-menu:${projectId}`}
          />
        }
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className={CARD_MENU_CONTENT_CLASS} finalFocus={menu.returnFocus}>
        {menu.actions.map((action) => (
          <DropdownMenuItem key={action.id} disabled={action.disabled} onClick={() => menu.onSelect(action.id)}>
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The right-click menu's content: the same descriptors as the ⋯ menu, through `ContextMenuItem`. */
export function CardContextMenuContent({ menu, ...props }: { menu: CardMenuBinding } & Omit<ComponentProps<typeof ContextMenuContent>, "children">) {
  return (
    <ContextMenuContent align="start" side="right" className={CARD_MENU_CONTENT_CLASS} finalFocus={menu.returnFocus} {...props}>
      {menu.actions.map((action) => (
        <ContextMenuItem key={action.id} disabled={action.disabled} onClick={() => menu.onSelect(action.id)}>
          {action.label}
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
  );
}
