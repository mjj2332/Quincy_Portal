import type { ComponentProps } from "react";
import type { StageKey } from "@quincy/shared";
import { ArrowRightLeft, Ellipsis } from "lucide-react";
import { Button } from "../reui/button";
import {
  ContextMenuContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "../reui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../reui/dropdown-menu";
import { StageSwatch } from "../quincy/StageSwatch";
import { stageColorFor, stagePatternFor } from "../../lib/stage-colors";
import type { MoveToChoice } from "./card-actions";

/**
 * What the Board hands a card to build its two menus from (#470). The card has no menu when this is
 * absent (nothing to offer, or archived).
 */
export type CardMenuConfig = {
  /** The `controlsDisabled(id)` verdict: disables the ⋯ trigger, and the Move to submenu with it. */
  disabled: boolean;
  /** True while any drag is live: the right-click menu must not open over it. */
  dragActive: boolean;
  /** Every active Stage in Admin order; the card's own is `current`. */
  choices: readonly MoveToChoice[];
  /** The Move to submenu trigger is disabled when no Stage is selectable. */
  moveToDisabled: boolean;
  /** Move to ▸ Stage. The Board reports it as an append; the card is sorted into place. */
  onMoveStage: (stageKey: StageKey) => void;
};

/** What the card hands its two menus: the config plus its own focus hand-off. */
export type CardMenuBinding = {
  menu: CardMenuConfig;
  /** Called after either menu has finished closing. */
  onClosed: () => void;
  /** `finalFocus` for both menus: false once a Stage has been chosen, because the card has moved. */
  returnFocus: () => boolean;
  /** Records that a Stage was chosen, so the menu does not return focus to a trigger that is leaving. */
  onChoose: (stageKey: StageKey) => void;
};

/**
 * One surface for both menus. The ReUI dropdown's own defaults are already the Quincy surface
 * (square, hairline border, `--shadow-md`); the context menu's defaults are the rounded ring one, so
 * this string is what makes the two read as the same menu. Applied to both so neither drifts.
 */
const CARD_MENU_CONTENT_CLASS = "w-48 rounded-none border border-border shadow-[var(--shadow-md)] ring-0";
const SUB_CONTENT_CLASS = "min-w-48 w-max max-w-[min(18rem,calc(100vw-2rem))]";
/** 44px rows at ≤641px and on a coarse pointer: the Stage radios and the Move to sub-triggers share it. */
export const TOUCH_ROW_CLASS = "max-[641px]:min-h-11 pointer-coarse:min-h-11";

function Swatch({ stageKey }: { stageKey: StageKey }) {
  return <StageSwatch color={stageColorFor(stageKey)} pattern={stagePatternFor(stageKey)} />;
}

/**
 * The ⋯ trigger and its menu. A SIBLING of the card's link (the drag handle), raised above its
 * overlay: a press on it can never start a drag. Always visible, never hover-revealed (TB8-07), 44px
 * at ≤641px and on a coarse pointer.
 */
export function CardActionsMenu({ projectId, street, binding }: { projectId: string; street: string; binding: CardMenuBinding }) {
  const { menu } = binding;
  return (
    <DropdownMenu onOpenChangeComplete={(open) => { if (!open) binding.onClosed(); }}>
      <DropdownMenuTrigger
        disabled={menu.disabled}
        render={
          <Button
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
      <DropdownMenuContent side="bottom" align="end" className={CARD_MENU_CONTENT_CLASS} finalFocus={binding.returnFocus}>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={menu.moveToDisabled} className={TOUCH_ROW_CLASS}>
            <ArrowRightLeft aria-hidden="true" />
            Move to
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={SUB_CONTENT_CLASS}>
            {/* Pinned to the card's CURRENT Stage: a pick never changes the group's value, the move is the side effect. */}
            <DropdownMenuRadioGroup value={menu.choices.find((choice) => choice.current)?.stageKey ?? ""}>
              {menu.choices.map((choice) => (
                <DropdownMenuRadioItem
                  key={choice.stageKey}
                  value={choice.stageKey}
                  disabled={choice.disabled}
                  closeOnClick
                  className={TOUCH_ROW_CLASS}
                  onClick={() => binding.onChoose(choice.stageKey)}
                >
                  <Swatch stageKey={choice.stageKey} />
                  {choice.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The right-click menu's content: the same choices as the ⋯ menu, through the `context-menu` parts. */
export function CardContextMenuContent({ binding, ...props }: { binding: CardMenuBinding } & Omit<ComponentProps<typeof ContextMenuContent>, "children">) {
  const { menu } = binding;
  return (
    <ContextMenuContent align="start" side="right" className={CARD_MENU_CONTENT_CLASS} finalFocus={binding.returnFocus} {...props}>
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={menu.moveToDisabled} className={TOUCH_ROW_CLASS}>
          <ArrowRightLeft aria-hidden="true" />
          Move to
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className={SUB_CONTENT_CLASS}>
          <ContextMenuRadioGroup value={menu.choices.find((choice) => choice.current)?.stageKey ?? ""}>
            {menu.choices.map((choice) => (
              <ContextMenuRadioItem
                key={choice.stageKey}
                value={choice.stageKey}
                disabled={choice.disabled}
                closeOnClick
                className={TOUCH_ROW_CLASS}
                onClick={() => binding.onChoose(choice.stageKey)}
              >
                <Swatch stageKey={choice.stageKey} />
                {choice.label}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </ContextMenuContent>
  );
}
