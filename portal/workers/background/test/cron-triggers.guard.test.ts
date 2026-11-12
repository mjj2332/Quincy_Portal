import { afterAll, describe, expect, it, vi } from "vitest";
import QuincyBackground from "../src";

declare const __BACKGROUND_WRANGLER_CONFIG__: string;

/**
 * The Worker's Cron triggers and `scheduled()` must agree: a trigger without a branch logs "Ignored unknown Cron trigger" and silently
 * runs nothing (reminders and outbox recovery would stop). docs/plans/cron-cadence-30m-hourly.md retired the every-minute trigger.
 */
function configuredCrons(): string[] {
  const match = /"crons"\s*:\s*\[([^\]]*)\]/.exec(__BACKGROUND_WRANGLER_CONFIG__);
  expect(match, "wrangler.jsonc has a triggers.crons list").not.toBeNull();
  return [...match![1]!.matchAll(/"([^"]+)"/g)].map(([, cron]) => cron!);
}

const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
vi.spyOn(console, "log").mockImplementation(() => undefined);
afterAll(() => { consoleWarn.mockRestore(); consoleError.mockRestore(); });

describe("background wrangler Cron triggers", () => {
  it("configures exactly the half-hour and hourly triggers, and no every-minute trigger", () => {
    expect([...configuredCrons()].sort()).toEqual(["*/30 * * * *", "0 * * * *"]);
    expect(configuredCrons()).not.toContain("* * * * *");
  });

  it("gives every configured trigger a scheduled() branch", async () => {
    for (const cron of configuredCrons()) {
      consoleWarn.mockClear();
      await new QuincyBackground({} as ExecutionContext, {} as never).scheduled({ cron, scheduledTime: Date.UTC(2026, 9, 4, 12, 0), noRetry() {} } as ScheduledController);
      expect(consoleWarn, cron).not.toHaveBeenCalledWith("Ignored unknown Cron trigger", expect.anything());
    }
  });

  it("still warns for a trigger nobody configured, so the check above can fail", async () => {
    await new QuincyBackground({} as ExecutionContext, {} as never).scheduled({ cron: "* * * * *", scheduledTime: 0, noRetry() {} } as ScheduledController);
    expect(consoleWarn).toHaveBeenCalledWith("Ignored unknown Cron trigger", { cron: "* * * * *" });
  });
});
