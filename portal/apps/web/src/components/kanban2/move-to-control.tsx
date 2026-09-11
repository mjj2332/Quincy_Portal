import { useCallback, useMemo, useRef, useState } from "react";
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

const OPTION_CLASSES = "w-full min-h-11 px-[var(--space-3)] py-[var(--space-2)] border-0 border-l-[length:var(--border-width-bold)] border-l-transparent bg-transparent text-foreground [font:inherit] !text-xs text-left cursor-pointer active:bg-[var(--bg-sunken)] hover:bg-[var(--paper-100)] aria-selected:border-l-[var(--border-strong)] focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] focus-visible:!outline-[var(--ink-900)] focus-visible:!outline-offset-[-2px]";
const ACTION_CLASSES = "min-h-[38px] px-[14px] py-[9px] text-xs focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] focus-visible:!outline-[var(--ink-900)] focus-visible:!outline-offset-[-2px]";

export type MoveToControlProps = {
  project: ProjectSummary;
  model: BoardModel;
  activeStages: readonly PipelineStage[];
  role: Role;
  sort: KanbanSortMode;
  canMoveStages: boolean;
  /** Same-Stage positions: Priority access AND the Board's own reorder gate, already combined. */
  canReorder: boolean;
  disabled: boolean;
  onMoveStage: (project: ProjectSummary, gap: SemanticGap, kind: "cross" | "same", focusDescriptor: FocusDescriptor) => void;
  onProposalChange: (proposal: SemanticGap | null) => void;
};

/**
 * The non-drag way to move a card (#99): pick a Stage, then a position, then commit explicitly.
 * Ported from the old Board's `MoveToControl` rather than extracted from it — #83 deletes that
 * Board, and a shared extraction through dying code costs more than the duplication.
 *
 * Every position list comes from `moveToPositionOptions`, the role-safe allow-list, so a hidden
 * project can never appear as a neighbour. Choosing a position publishes it as the proposal, which
 * the Board draws with the same drop indicator a drag uses; Back, Cancel, Escape and submit all
 * clear it. Confirmation is NOT handled here: a cross-Stage submit goes through the Dashboard's
 * ordinary 409 round trip and modal, exactly like a drop.
 */
export function MoveToControl({ project, model, activeStages, role, sort, canMoveStages, canReorder, disabled, onMoveStage, onProposalChange }: MoveToControlProps) {
  const [open, setOpen] = useState(false);
  const [targetStageKey, setTargetStageKey] = useState<StageKey | null>(null);
  const [successor, setSuccessor] = useState<string | "end" | null>(null);
  const focusDescriptorRef = useRef<FocusDescriptor | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    setTargetStageKey(null);
    setSuccessor(null);
    onProposalChange(null);
    // Synchronous, and `preventScroll`: a bare `.focus()` on a trigger low on a long Board scrolls it.
    triggerRef.current?.focus({ preventScroll: true });
  }, [onProposalChange]);
  const floating = useAnchoredPopover({ open, onClose: close, placement: "bottom-end" });
  // Stable identity is load-bearing, not tidiness: floating-ui's `setReference` calls setState with
  // no equality guard, and an inline ref callback re-runs on every render — under a Board drag's
  // rapid re-renders that detach/attach storm blew React's update-depth limit on the old Board.
  const setTrigger = useCallback((node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    floating.refs.setReference(node);
  }, [floating.refs.setReference]);
  const stageLabels = useMemo(() => Object.fromEntries(activeStages.map((stage) => [moveToStageKey(stage.key), stage.label])), [activeStages]);
  const caps = useMemo(() => ({
    canMoveProjectStage: canMoveStages,
    canPrioritize: canReorder,
    sort,
    activeStageKeys: activeStages.map((stage) => moveToStageKey(stage.key)),
    stageLabels,
  }), [activeStages, canMoveStages, canReorder, sort, stageLabels]);
  // A Stage is offered only if it has at least one position this principal may choose.
  const stageOptions = useMemo(() => {
    const seen = new Set<StageKey>();
    return activeStages.filter((stage) => {
      const key = moveToStageKey(stage.key);
      if (seen.has(key)) return false;
      seen.add(key);
      return moveToPositionOptions(model, project.id, key, role, caps).length > 0;
    });
  }, [activeStages, caps, model, project.id, role]);
  const positions = targetStageKey === null ? [] : moveToPositionOptions(model, project.id, targetStageKey, role, caps);
  const targetLabel = targetStageKey === null ? "" : stageLabels[targetStageKey] ?? targetStageKey;
  const dialogId = `kanban2-move-to-${project.id}`;

  const openMoveTo = () => {
    focusDescriptorRef.current = focusDescriptorFor("move-to", project, model, "move-to");
    setTargetStageKey(null);
    setSuccessor(null);
    onProposalChange(null);
    setOpen(true);
  };
  const back = () => {
    setTargetStageKey(null);
    setSuccessor(null);
    onProposalChange(null);
  };
  const submit = () => {
    if (targetStageKey === null || successor === null) return;
    const descriptor = focusDescriptorRef.current ?? focusDescriptorFor("move-to", project, model, "move-to");
    const kind = moveToStageKey(project.stageKey as ProjectStageKey) === targetStageKey ? "same" : "cross";
    close();
    onMoveStage(project, { targetStageKey, successor }, kind, descriptor);
  };

  return <>
    <button
      ref={setTrigger}
      type="button"
      className="flex-1 min-w-0 min-h-[30px] max-[641px]:min-h-11 pointer-coarse:min-h-11 px-[9px] py-[7px] border-0 bg-card text-foreground-secondary [font:inherit] !text-[length:var(--text-2xs)] text-left cursor-pointer focus-visible:!outline-2 focus-visible:!outline-[var(--ink-900)] focus-visible:!outline-offset-[-2px] hover:not-disabled:bg-[var(--paper-100)] hover:not-disabled:text-foreground disabled:bg-surface-sunken disabled:cursor-not-allowed"
      data-testid="kanban2-move-to"
      data-focus-key={`move-to:${project.id}`}
      aria-label={`Move ${project.street} to…`}
      aria-expanded={open}
      aria-controls={open ? dialogId : undefined}
      disabled={disabled || stageOptions.length === 0}
      onKeyDown={floating.onKeyDown}
      onClick={openMoveTo}
    >Move to…</button>
    {floating.mounted && <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} modal onKeyDown={floating.onKeyDown} status={floating.status}>
      <div id={dialogId} className="grid gap-[var(--space-3)] p-[var(--space-3)]" role="dialog" aria-label={`Move ${project.street} to…`} data-step={targetStageKey === null ? "stage" : "position"}>
        <div className="ey">{targetStageKey === null ? "Choose a Stage" : `Choose a position in ${targetLabel}`}</div>
        {targetStageKey === null ? <div className="grid gap-[2px]" role="radiogroup" aria-label={`Target Stage for ${project.street}`}>
          {stageOptions.map((stage) => {
            const key = moveToStageKey(stage.key);
            // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token
            return <button key={key} type="button" role="radio" aria-checked={false} className={OPTION_CLASSES} onClick={() => { setTargetStageKey(key); setSuccessor(null); }}>{stage.label}</button>;
          })}
        </div> : <>
          <div className="grid gap-[2px]" role="listbox" aria-label={`Position in ${targetLabel}`}>
            {/* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */}
            {positions.map((option) => <button key={option.successor} type="button" role="option" aria-selected={successor === option.successor} className={OPTION_CLASSES} onClick={() => { setSuccessor(option.successor); onProposalChange({ targetStageKey, successor: option.successor }); }}>{option.label}</button>)}
          </div>
          <div className="flex justify-end gap-[var(--space-2)]">
            <button type="button" className={buttonClasses("secondary", { className: ACTION_CLASSES })} onClick={back}>Back</button>
            <button type="button" className={buttonClasses("secondary", { className: ACTION_CLASSES })} onClick={close}>Cancel</button>
            <button type="button" data-testid="kanban2-move-to-submit" className={buttonClasses("primary", { className: ACTION_CLASSES })} disabled={successor === null} onClick={submit}>Move project</button>
          </div>
        </>}
      </div>
    </AnchoredPopover>}
  </>;
}
