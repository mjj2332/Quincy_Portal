/**
 * The card's menu items (#432), as one list of descriptors. The ⋯ menu (`reui/dropdown-menu`) and
 * the right-click menu (`reui/context-menu`) each render this through a thin renderer, so the two
 * can never offer different things or drift in what they disable.
 */
export type CardActionId = "move-to" | "move-up" | "move-down";

export type CardAction = {
  id: CardActionId;
  label: string;
  disabled: boolean;
};

export type CardActionsInput = {
  /** Either capability opens Move to…: a prioritize-only principal reorders within a Stage without changing it. */
  canMoveTo: boolean;
  /** Same-Stage reordering (Admin Board order): Priority access AND the Board's own reorder gate. */
  canReorder: boolean;
  /** The existing `controlsDisabled(id)`: a drag, a pending write, a locked Board or an archived card. */
  disabled: boolean;
  /** Whether Move to… has at least one Stage and position this principal may choose. */
  hasMoveToOptions: boolean;
  isFirstInColumn: boolean;
  isLastInColumn: boolean;
};

/** An empty list means the card has no menu at all (no ⋯, no right-click menu). */
export function cardActions({ canMoveTo, canReorder, disabled, hasMoveToOptions, isFirstInColumn, isLastInColumn }: CardActionsInput): CardAction[] {
  const actions: CardAction[] = [];
  if (canMoveTo || canReorder) actions.push({ id: "move-to", label: "Move to…", disabled: disabled || !hasMoveToOptions });
  if (canReorder) {
    actions.push({ id: "move-up", label: "Move up", disabled: disabled || isFirstInColumn });
    actions.push({ id: "move-down", label: "Move down", disabled: disabled || isLastInColumn });
  }
  return actions;
}
