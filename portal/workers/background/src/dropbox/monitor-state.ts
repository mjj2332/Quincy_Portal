export function automationFlag(value: string | boolean | undefined): boolean {
  return value === true || value === "1";
}

export function monitorAutomationEnabled(
  scope: "raw" | "autohdr",
  flags: { raw?: string | boolean; autohdr?: string | boolean },
): boolean {
  return automationFlag(scope === "raw" ? flags.raw : flags.autohdr);
}

export function canRecoverAggregateMonitorHealth(
  rows: readonly { scope: "raw" | "autohdr"; lastError: string | null }[],
): boolean {
  const healthy = new Set(rows.filter((row) => !row.lastError).map((row) => row.scope));
  return healthy.has("raw") && healthy.has("autohdr");
}

export function shouldKeepMonitorAlarm(
  pageHasMore: boolean,
  startGeneration: number,
  endGeneration: number,
): boolean {
  return pageHasMore || endGeneration > startGeneration;
}
