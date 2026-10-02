import type { StageKey } from "@quincy/shared";
import { eligibleTarget, type BoardModel, type ProjectSummary } from "../../lib/kanban-interaction";
import type { PipelineStage } from "../../lib/stages";

/**
 * The card's one menu action (#470): Move to a Stage. The ⋯ menu (`reui/dropdown-menu`) and the
 * right-click menu (`reui/context-menu`) each render these choices through a thin renderer, so the
 * two can never offer different Stages or drift in what they disable. Columns are sorted by data, so
 * there is nothing else to offer: no position step, no Move up / Move down.
 */
export type MoveToChoice = {
  stageKey: StageKey;
  label: string;
  /** The card's own Stage: shown checked, never selectable. */
  current: boolean;
  disabled: boolean;
};

function canonicalStage(key: string): StageKey {
  return (key === "editing" ? "editing_autohdr" : key) as StageKey;
}

/**
 * Every active Stage, in Admin order. A Stage the principal may not move this card into (or the
 * card's own Stage) is disabled rather than hidden, so the submenu always reads as the same list.
 */
export function moveToChoices(
  project: ProjectSummary,
  model: BoardModel,
  activeStages: readonly PipelineStage[],
  canMoveStages: boolean,
): MoveToChoice[] {
  const activeStageKeys = activeStages.map((stage) => canonicalStage(stage.key));
  const own = canonicalStage(project.stageKey);
  return activeStages.map((stage) => {
    const stageKey = canonicalStage(stage.key);
    const current = stageKey === own;
    const eligible = eligibleTarget(stageKey, model, project.id, { canMoveProjectStage: canMoveStages, activeStageKeys });
    return { stageKey, label: stage.label, current, disabled: current || !eligible };
  });
}

export type CardMoveToInput = {
  /** Holds the Stage-move capability, or would right now were movement not switched off (`menuCapable`). */
  canMoveTo: boolean;
  /** The `controlsDisabled(id)` verdict: a drag, a pending write, a locked Board or an archived card. */
  disabled: boolean;
  choices: readonly MoveToChoice[];
};

/** `null` means the card has no menu at all (no ⋯, no right-click menu). */
export function cardMoveTo({ canMoveTo, disabled, choices }: CardMoveToInput): { disabled: boolean } | null {
  if (!canMoveTo) return null;
  return { disabled: disabled || !choices.some((choice) => !choice.disabled) };
}
