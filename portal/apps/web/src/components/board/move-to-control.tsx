import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Role, StageKey } from "@quincy/shared";
import { AnchoredPopover, useAnchoredPopover } from "../AnchoredPopover";
import { buttonClasses } from "../quincy/Button";
import {
  focusDescriptorFor,
  moveToPositionOptions,
  type BoardModel,
  type FocusDescriptor,
  type KanbanSortMode,
  type ProjectSummary,
  type SemanticGap,
} from "../../lib/kanban-interaction";
import type { PipelineStage, ProjectStageKey } from "../../lib/stages";

function moveToStageKey(value: ProjectStageKey): StageKey {
  return value === "editing" ? "editing_autohdr" : value;
}

const OPTION_CLASSES = "w-full min-h-11 px-[var(--space-3)] py-[var(--space-2)] border-0 border-l-[length:var(--border-width-bold)] border-l-transparent bg-transparent text-foreground [font:inherit] !text-sm text-left cursor-pointer active:bg-[var(--bg-sunken)] hover:bg-[var(--paper-100)] aria-selected:border-l-[var(--border-strong)] focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] focus-visible:!outline-[var(--ink-900)] focus-visible:!outline-offset-[-2px]";
const ACTION_CLASSES = "min-h-[38px] px-[14px] py-[9px] text-xs focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] focus-visible:!outline-[var(--ink-900)] focus-visible:!outline-offset-[-2px]";

export type MoveToDialogProps = {
  project: ProjectSummary;
  model: BoardModel;
  activeStages: readonly PipelineStage[];
  role: Role;
  sort: KanbanSortMode;
  canMoveStages: boolean;
  /** Same-Stage positions: Priority access AND the Board's own reorder gate, already combined. */
  canReorder: boolean;
  open: boolean;
  /**
   * The card's ⋯ trigger, which the dialog anchors to and gives focus back to — even when it was
   * opened from the right-click menu.
   */
  anchor: HTMLElement | null;
  /** Called once the dialog has closed itself (Cancel, Escape, outside press or submit). */
  onClose: () => void;
  onMoveStage: (project: ProjectSummary, gap: SemanticGap, kind: "cross" | "same", focusDescriptor: FocusDescriptor) => void;
  onProposalChange: (proposal: SemanticGap | null) => void;
};

/**
 * The Stage options Move to… would offer: a Stage is offered only if it has at least one position
 * this principal may choose. Shared with the card menu, which disables "Move to…" when this is empty.
 */
export function moveToStageOptions(
  project: ProjectSummary,
  model: BoardModel,
  activeStages: readonly PipelineStage[],
  role: Role,
  caps: { canMoveStages: boolean; canReorder: boolean; sort: KanbanSortMode },
): PipelineStage[] {
  const stageLabels = Object.fromEntries(activeStages.map((stage) => [moveToStageKey(stage.key), stage.label]));
  const resolved = {
    canMoveProjectStage: caps.canMoveStages,
    canPrioritize: caps.canReorder,
    sort: caps.sort,
    activeStageKeys: activeStages.map((stage) => moveToStageKey(stage.key)),
    stageLabels,
  };
  const seen = new Set<StageKey>();
  return activeStages.filter((stage) => {
    const key = moveToStageKey(stage.key);
    if (seen.has(key)) return false;
    seen.add(key);
    return moveToPositionOptions(model, project.id, key, role, resolved).length > 0;
  });
}

/**
 * The non-drag way to move a card (#99): pick a Stage, then a position, then commit explicitly. A
 * controlled dialog since #432 — the card's ⋯ / right-click menu opens it from its "Move to…" item,
 * once that menu has finished closing, so the menu's own focus return cannot land on top of it.
 * Ported from the old Board's `MoveToControl` rather than extracted from it — #83 deleted that
 * Board, and a shared extraction through dying code costs more than the duplication.
 *
 * Every position list comes from `moveToPositionOptions`, the role-safe allow-list, so a hidden
 * project can never appear as a neighbour. Choosing a position publishes it as the proposal, which
 * the Board draws with the same drop indicator a drag uses; Back, Cancel, Escape and submit all
 * clear it. Confirmation is NOT handled here: a cross-Stage submit goes through the Dashboard's
 * ordinary 409 round trip and modal, exactly like a drop.
 */
export function MoveToDialog({ project, model, activeStages, role, sort, canMoveStages, canReorder, open, anchor, onClose, onMoveStage, onProposalChange }: MoveToDialogProps) {
  const [targetStageKey, setTargetStageKey] = useState<StageKey | null>(null);
  const [successor, setSuccessor] = useState<string | "end" | null>(null);
  // Captured when the dialog opens, so the focus restore targets where the card WAS, not where a
  // refresh has since put it. State, set in the render that sees `open` flip (React's own
  // derived-state pattern), rather than an effect.
  const [focusDescriptor, setFocusDescriptor] = useState<FocusDescriptor | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTargetStageKey(null);
      setSuccessor(null);
      setFocusDescriptor(focusDescriptorFor("move-to", project, model, "move-to"));
    }
  }
  const close = useCallback(() => {
    setTargetStageKey(null);
    setSuccessor(null);
    publish(null);
    onClose();
    // Synchronous, and `preventScroll`: a bare `.focus()` on a trigger low on a long Board scrolls it.
    anchor?.focus({ preventScroll: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `publish` only forwards to `onProposalChange`
  }, [anchor, onClose, onProposalChange]);
  const floating = useAnchoredPopover({ open, onClose: close, placement: "bottom-end" });
  const { setReference } = floating.refs;
  useEffect(() => { setReference(anchor); }, [anchor, setReference]);
  // A published proposal must be withdrawn if this dialog goes away with it still set — browser
  // Back leaving the view, or the project being removed elsewhere. The Dashboard counts a live
  // proposal as an interaction and holds refreshes and the view/sort controls for it, so an orphaned
  // one latches all of that until reload. Refs, so the cleanup runs on unmount only.
  const publishedRef = useRef(false);
  const onProposalChangeRef = useRef(onProposalChange);
  useEffect(() => { onProposalChangeRef.current = onProposalChange; });
  useEffect(() => () => { if (publishedRef.current) onProposalChangeRef.current(null); }, []);
  const publish = (proposal: SemanticGap | null) => {
    publishedRef.current = proposal !== null;
    onProposalChange(proposal);
  };
  const stageLabels = useMemo(() => Object.fromEntries(activeStages.map((stage) => [moveToStageKey(stage.key), stage.label])), [activeStages]);
  const caps = useMemo(() => ({
    canMoveProjectStage: canMoveStages,
    canPrioritize: canReorder,
    sort,
    activeStageKeys: activeStages.map((stage) => moveToStageKey(stage.key)),
    stageLabels,
  }), [activeStages, canMoveStages, canReorder, sort, stageLabels]);
  const stageOptions = useMemo(() => moveToStageOptions(project, model, activeStages, role, { canMoveStages, canReorder, sort }), [activeStages, canMoveStages, canReorder, model, project, role, sort]);
  const positions = targetStageKey === null ? [] : moveToPositionOptions(model, project.id, targetStageKey, role, caps);
  const targetLabel = targetStageKey === null ? "" : stageLabels[targetStageKey] ?? targetStageKey;
  const currentStageKey = moveToStageKey(project.stageKey as ProjectStageKey);
  const dialogId = `board-move-to-${project.id}`;

  const back = () => {
    setTargetStageKey(null);
    setSuccessor(null);
    publish(null);
  };
  const submit = () => {
    if (targetStageKey === null || successor === null) return;
    const descriptor = focusDescriptor ?? focusDescriptorFor("move-to", project, model, "move-to");
    const kind = moveToStageKey(project.stageKey as ProjectStageKey) === targetStageKey ? "same" : "cross";
    close();
    onMoveStage(project, { targetStageKey, successor }, kind, descriptor);
  };

  return <>
    {floating.mounted && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={1} modal onKeyDown={floating.onKeyDown} status={floating.status}>
      <div id={dialogId} className="grid gap-[var(--space-3)] p-[var(--space-3)]" role="dialog" aria-label={`Move ${project.street} to…`} data-step={targetStageKey === null ? "stage" : "position"}>
        <div className="ey">{targetStageKey === null ? "Choose a Stage" : `Choose a position in ${targetLabel}`}</div>
        {targetStageKey === null ? <div className="grid gap-[2px]" role="radiogroup" aria-label={`Target Stage for ${project.street}`}>
          {stageOptions.map((stage) => {
            const key = moveToStageKey(stage.key);
            // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token
            const isCurrent = key === currentStageKey;
            return <button key={key} type="button" role="radio" aria-checked={false} aria-current={isCurrent ? "true" : undefined} className={`${OPTION_CLASSES} ${isCurrent ? "flex items-center justify-between gap-[var(--space-3)]" : ""}`} onClick={() => { setTargetStageKey(key); setSuccessor(null); }}>{stage.label}{isCurrent && <span className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">Current</span>}</button>;
          })}
        </div> : <>
          <div className="grid gap-[2px]" role="listbox" aria-label={`Position in ${targetLabel}`}>
            {/* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */}
            {positions.map((option) => <button key={option.successor} type="button" role="option" aria-selected={successor === option.successor} className={OPTION_CLASSES} onClick={() => { setSuccessor(option.successor); publish({ targetStageKey, successor: option.successor }); }}>{option.label}</button>)}
          </div>
          <div className="flex justify-end gap-[var(--space-2)]">
            <button type="button" className={buttonClasses("secondary", { className: ACTION_CLASSES })} onClick={back}>Back</button>
            <button type="button" className={buttonClasses("secondary", { className: ACTION_CLASSES })} onClick={close}>Cancel</button>
            <button type="button" data-testid="board-move-to-submit" className={buttonClasses("primary", { className: ACTION_CLASSES })} disabled={successor === null} onClick={submit}>Move project</button>
          </div>
        </>}
      </div>
    </AnchoredPopover>}
  </>;
}
