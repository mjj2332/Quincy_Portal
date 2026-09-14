import { describe, expect, it } from "vitest";
import { canRecoverAggregateMonitorHealth, monitorAutomationEnabled, shouldKeepMonitorAlarm } from "../src/dropbox/monitor-state";
import { parseDropboxMonitorIdentity } from "../src/dropbox/paths";
import { DropboxRateLimitError } from "../src/dropbox/client";
import { alarmRetryDelay } from "../src/do/dropbox-sync";

describe("root monitor cursor/alarm contract", () => {
  it("uses only fixed roots for first/reset scans and never an account root", () => {
    expect(parseDropboxMonitorIdentity("db-connection:raw")?.watchedRoot).toBe("/Tonomo/Raw Files");
    expect(parseDropboxMonitorIdentity("db-connection:autohdr")?.watchedRoot).toBe("/AutoHDR");
    expect(parseDropboxMonitorIdentity("db-connection:editor")?.watchedRoot).toBe("/Editor/01_ACTIVE EDITS");
    expect(parseDropboxMonitorIdentity("db-connection")).toBeNull();
  });

  it("preserves a kick that interleaves with cursor persistence", () => {
    expect(shouldKeepMonitorAlarm(false, 7, 8)).toBe(true);
    expect(shouldKeepMonitorAlarm(false, 7, 7)).toBe(false);
    expect(shouldKeepMonitorAlarm(true, 7, 7)).toBe(true);
  });

  it("keeps scope-local generations independent", () => {
    const raw = { start: 2, end: 3 };
    const autohdr = { start: 9, end: 9 };
    expect(shouldKeepMonitorAlarm(false, raw.start, raw.end)).toBe(true);
    expect(shouldKeepMonitorAlarm(false, autohdr.start, autohdr.end)).toBe(false);
  });

  it("does not consume a scope baseline until that scope is deliberately enabled", () => {
    const flags = { raw: "1", autohdr: "0" };
    expect(monitorAutomationEnabled("raw", flags)).toBe(true);
    expect(monitorAutomationEnabled("autohdr", flags)).toBe(false);
    expect(monitorAutomationEnabled("editor", flags)).toBe(false);
    expect(monitorAutomationEnabled("editor", { editor: "1" })).toBe(true);
    expect(monitorAutomationEnabled("editor", { editor: "false" })).toBe(false);
  });

  it("does not let one healthy scope mask a missing or failed sibling", () => {
    expect(canRecoverAggregateMonitorHealth([{ scope: "raw", lastError: null }])).toBe(false);
    expect(canRecoverAggregateMonitorHealth([
      { scope: "raw", lastError: null },
      { scope: "autohdr", lastError: "Dropbox unavailable" },
    ])).toBe(false);
    expect(canRecoverAggregateMonitorHealth([
      { scope: "raw", lastError: null },
      { scope: "autohdr", lastError: null },
    ])).toBe(true);
  });

  it("honours a Dropbox 429 retry-after without shortening the normal monitor delay", () => {
    expect(alarmRetryDelay(new DropboxRateLimitError("rate limited", 120), 60_000)).toBe(120_000);
    expect(alarmRetryDelay(new DropboxRateLimitError("rate limited", 10), 60_000)).toBe(60_000);
    expect(alarmRetryDelay(new Error("network error"), 60_000)).toBe(60_000);
  });

  it("requires Editor health only when Editor automation is enabled", () => {
    const healthy = [{ scope: "raw" as const, lastError: null }, { scope: "autohdr" as const, lastError: null }];
    expect(canRecoverAggregateMonitorHealth(healthy, true)).toBe(false);
    expect(canRecoverAggregateMonitorHealth([...healthy, { scope: "editor", lastError: null }], true)).toBe(true);
    expect(canRecoverAggregateMonitorHealth([...healthy, { scope: "editor", lastError: "failed" }], true)).toBe(false);
  });

  it("caps an oversized Dropbox retry-after instead of stalling the monitor for hours", () => {
    expect(alarmRetryDelay(new DropboxRateLimitError("rate limited", 24 * 60 * 60), 60_000)).toBe(15 * 60_000);
  });
});
