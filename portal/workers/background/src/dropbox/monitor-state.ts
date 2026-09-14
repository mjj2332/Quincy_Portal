export function automationFlag(value: string | boolean | undefined): boolean {
  return value === true || value === "1";
}

export function monitorAutomationEnabled(
  scope: "raw" | "autohdr" | "editor",
  flags: { raw?: string | boolean; autohdr?: string | boolean; editor?: string | boolean },
): boolean {
  return automationFlag(flags[scope]);
}

export function canRecoverAggregateMonitorHealth(
  rows: readonly { scope: "raw" | "autohdr" | "editor"; lastError: string | null }[],
  editorEnabled = false,
): boolean {
  const healthy = new Set(rows.filter((row) => !row.lastError).map((row) => row.scope));
  return healthy.has("raw") && healthy.has("autohdr") && (!editorEnabled || healthy.has("editor"));
}

export function shouldKeepMonitorAlarm(
  pageHasMore: boolean,
  startGeneration: number,
  endGeneration: number,
): boolean {
  return pageHasMore || endGeneration > startGeneration;
}
