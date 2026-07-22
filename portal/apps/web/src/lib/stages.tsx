import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_STAGES, isStageKey, type StageKey } from "@quincy/shared";
import { apiGet } from "./api";
import { useCapabilities } from "./capabilities";

export type ProjectStageKey = StageKey | "editing";
export type PipelineStage = { key: ProjectStageKey; label: string; displayOrder: number; active: boolean };
type StagesContextValue = { stages: readonly PipelineStage[]; isLoading: boolean; refreshStages: () => Promise<void> };

const fallbackStages: readonly PipelineStage[] = DEFAULT_STAGES.map((stage) => ({ ...stage, active: true }));
const StagesContext = createContext<StagesContextValue>({ stages: fallbackStages, isLoading: true, refreshStages: async () => {} });

function isProjectStageKey(value: string): value is ProjectStageKey {
  return value === "editing" || isStageKey(value);
}

export function presentationStageKey(stageKey: ProjectStageKey, canAdminBackend: boolean): ProjectStageKey {
  return !canAdminBackend && stageKey === "editing_autohdr" ? "editing" : stageKey;
}

export function presentationStages(stages: readonly PipelineStage[], canAdminBackend: boolean): readonly PipelineStage[] {
  if (canAdminBackend || stages.some((stage) => stage.key === "editing")) return stages;

  const internalStage = stages.find((stage) => stage.key === "editing_autohdr");
  const editingOrder = internalStage?.displayOrder ?? (stages.find((stage) => stage.key === "raw_review")?.displayOrder ?? 0) + 0.5;
  const neutralEditingStage: PipelineStage = { key: "editing", label: "Editing", displayOrder: editingOrder, active: internalStage?.active ?? true };
  return [
    ...stages.filter((stage) => stage.key !== "editing_autohdr"),
    neutralEditingStage,
  ].sort((left, right) => left.displayOrder - right.displayOrder);
}

function loadStages(): Promise<readonly PipelineStage[]> {
  return apiGet<{ stages: Array<{ key: string; label: string; displayOrder: number; active: boolean }> }>("/api/stages")
    .then(({ stages }) => stages.filter((stage): stage is PipelineStage => isProjectStageKey(stage.key)));
}

export function StagesProvider({ children }: { children: ReactNode }) {
  const [stages, setStages] = useState<readonly PipelineStage[]>(fallbackStages);
  const [isLoading, setIsLoading] = useState(true);

  // Admin stage edits call refreshStages so every consumer (kanban columns, badges,
  // drop targets) re-reads without a hard reload; failures keep the last good list.
  const refreshStages = useCallback(async () => {
    try { setStages(await loadStages()); } catch { /* Last good (or default) list remains usable. */ }
  }, []);

  useEffect(() => {
    let current = true;
    void loadStages().then((next) => { if (current) setStages(next); }).catch(() => { /* Defaults remain usable on a failed read. */ }).finally(() => { if (current) setIsLoading(false); });
    return () => { current = false; };
  }, []);

  return <StagesContext.Provider value={{ stages, isLoading, refreshStages }}>{children}</StagesContext.Provider>;
}

export function useStages() {
  const context = useContext(StagesContext);
  const { can } = useCapabilities();
  const canAdminBackend = can("adminBackend");
  const stages = useMemo(() => presentationStages(context.stages, canAdminBackend), [canAdminBackend, context.stages]);
  const visibleStageKey = useCallback((stageKey: ProjectStageKey) => presentationStageKey(stageKey, canAdminBackend), [canAdminBackend]);

  return { ...context, stages, presentationStageKey: visibleStageKey };
}
