import { beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn();
vi.mock("./api", () => ({ apiPost: (...args: unknown[]) => apiPost(...args) }));

import { captureBootLanding, markDashboardData, markSessionResolved, resetBootTimingForTests } from "./boot-timing";

const marks = vi.fn();
const measures = vi.fn();
beforeEach(() => {
  resetBootTimingForTests();
  apiPost.mockReset(); apiPost.mockResolvedValue(undefined);
  marks.mockReset(); measures.mockReset();
  vi.stubGlobal("performance", { now: vi.fn().mockReturnValueOnce(800.04).mockReturnValueOnce(1650.26).mockReturnValue(9999), mark: marks, measure: measures });
});

describe("boot timing", () => {
  it("marks the session once per page load, however often it is called", () => {
    markSessionResolved(); markSessionResolved(); markSessionResolved();
    expect(marks).toHaveBeenCalledTimes(1);
    expect(marks.mock.calls[0]![0]).toBe("quincy:session-resolved");
  });

  it("sends exactly one beacon per page load, with rounded numbers and no identifiers", () => {
    captureBootLanding("/");
    markSessionResolved();
    markDashboardData("board"); markDashboardData("table");
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith("/api/boot-timing", { sessionMs: 800, dashboardMs: 1650.3, view: "board", hidden: false });
    expect(marks.mock.calls.map((call) => call[0])).toEqual(["quincy:session-resolved", "quincy:dashboard-data"]);
  });

  it("sends no beacon when the page did not land on the Dashboard", () => {
    captureBootLanding("/admin");
    markSessionResolved(); markDashboardData("board");
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("sends no beacon when landing was never captured (standalone mounts, DOM tests)", () => {
    markSessionResolved(); markDashboardData("board");
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("swallows a rejected beacon and a synchronous throw", async () => {
    captureBootLanding("/");
    apiPost.mockRejectedValueOnce(new Error("offline"));
    expect(() => markDashboardData("board")).not.toThrow();
    await Promise.resolve();
    resetBootTimingForTests(); captureBootLanding("/");
    apiPost.mockImplementationOnce(() => { throw new Error("sync"); });
    expect(() => markDashboardData("board")).not.toThrow();
  });

  it("survives a timeline that rejects marks", () => {
    marks.mockImplementation(() => { throw new Error("nope"); });
    expect(() => markSessionResolved()).not.toThrow();
  });
});
