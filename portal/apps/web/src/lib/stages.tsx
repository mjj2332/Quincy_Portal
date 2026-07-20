import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_STAGES, isStageKey, type StageKey } from "@quincy/shared";
import { apiGet } from "./api";

export type PipelineStage = { key: StageKey; label: string; displayOrder: number; active: boolean };
type StagesContextValue = { stages: readonly PipelineStage[]; isLoading: boolean; refreshStages: () => Promise<void> };

const fallbackStages: readonly PipelineStage[] = DEFAULT_STAGES.map((stage) => ({ ...stage, active: true }));
const StagesContext = createContext<StagesContextValue>({ stages: fallbackStages, isLoading: true, refreshStages: async () => {} });

function loadStages(): Promise<readonly PipelineStage[]> {
  return apiGet<{ stages: Array<{ key: string; label: string; displayOrder: number; active: boolean }> }>("/api/stages")
    .then(({ stages }) => stages.filter((stage): stage is PipelineStage => isStageKey(stage.key)));
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
  return useContext(StagesContext);
}
