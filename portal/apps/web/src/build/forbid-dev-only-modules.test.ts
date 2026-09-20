/**
 * Unit tests for `forbid-dev-only-modules.ts` (#219 PR A round 2, item 1a). Two layers, both pure:
 * `normalizeModuleId`/`matchRestrictedModuleId` (the module-id matcher, exercised with fake ids in
 * every form Vite/Rollup/Rolldown are known to produce), and `checkForRestrictedModules` (the plugin
 * hook body, exercised against a fake `RestrictedModuleGraphContext` — no real bundler involved).
 * The end-to-end build-failure proof (real `vite build`, real violation, real revert) is done once
 * manually per the spec and is not a repeatable automated test — it would require committing a
 * deliberately broken production import, which is exactly what this guard exists to prevent from
 * ever landing.
 */
import { describe, expect, it, vi } from "vitest"
import {
  checkForRestrictedModules,
  matchRestrictedModuleId,
  normalizeModuleId,
  RESTRICTED_MODULE_PREFIXES,
  type RestrictedModuleGraphContext,
} from "./forbid-dev-only-modules"

const ROOT = "/repo/portal/apps/web"

describe("normalizeModuleId", () => {
  it("passes through an already-clean absolute id unchanged", () => {
    expect(normalizeModuleId(`${ROOT}/src/harness/reui-scheduling/main.tsx`)).toBe(
      `${ROOT}/src/harness/reui-scheduling/main.tsx`,
    );
  });

  it("strips a trailing ?query (e.g. ?raw, ?worker, ?url)", () => {
    expect(normalizeModuleId(`${ROOT}/src/harness/reui-scheduling/main.tsx?raw`)).toBe(
      `${ROOT}/src/harness/reui-scheduling/main.tsx`,
    );
    expect(normalizeModuleId(`${ROOT}/src/harness/reui-scheduling/worker.ts?worker`)).toBe(
      `${ROOT}/src/harness/reui-scheduling/worker.ts`,
    );
  });

  it("strips a trailing #hash", () => {
    expect(normalizeModuleId(`${ROOT}/src/harness/reui-scheduling/main.tsx#foo`)).toBe(
      `${ROOT}/src/harness/reui-scheduling/main.tsx`,
    );
  });

  it("strips a leading virtual-module null byte, including a doubled one", () => {
    expect(normalizeModuleId(`\0${ROOT}/src/harness/reui-scheduling/main.tsx`)).toBe(
      `${ROOT}/src/harness/reui-scheduling/main.tsx`,
    );
    expect(normalizeModuleId(`\0\0${ROOT}/src/harness/reui-scheduling/main.tsx`)).toBe(
      `${ROOT}/src/harness/reui-scheduling/main.tsx`,
    );
  });

  it("strips Vite's /@fs/ prefix", () => {
    expect(normalizeModuleId(`/@fs/${ROOT}/src/harness/reui-scheduling/main.tsx`)).toBe(
      `${ROOT}/src/harness/reui-scheduling/main.tsx`,
    );
  });

  it("normalises Windows backslash separators to forward slashes", () => {
    expect(normalizeModuleId(`C:\\repo\\portal\\apps\\web\\src\\harness\\main.tsx`)).toBe(
      "C:/repo/portal/apps/web/src/harness/main.tsx",
    );
  });

  it("handles every form combined: virtual prefix, /@fs/, query, and hash together", () => {
    expect(normalizeModuleId(`\0/@fs/${ROOT}/src/harness/reui-scheduling/main.tsx?worker#hmr`)).toBe(
      `${ROOT}/src/harness/reui-scheduling/main.tsx`,
    );
  });
});

describe("matchRestrictedModuleId", () => {
  it("matches a module under src/harness/", () => {
    expect(matchRestrictedModuleId(`${ROOT}/src/harness/reui-scheduling/main.tsx`, ROOT)).toBe("src/harness/");
  });

  it("matches a module under src/components/reui/gantt/", () => {
    expect(matchRestrictedModuleId(`${ROOT}/src/components/reui/gantt/gantt.tsx`, ROOT)).toBe(
      "src/components/reui/gantt/",
    );
  });

  it("does not match an unrelated production module", () => {
    expect(matchRestrictedModuleId(`${ROOT}/src/screens/Dashboard.tsx`, ROOT)).toBeUndefined();
  });

  it("does not match a sibling directory with a similar name (no prefix false-positive)", () => {
    expect(matchRestrictedModuleId(`${ROOT}/src/components/reui/gantt-adjacent/foo.tsx`, ROOT)).toBeUndefined();
  });

  it("does not match a virtual id unrelated to this project's root", () => {
    expect(matchRestrictedModuleId("\0virtual:some-other-plugin", ROOT)).toBeUndefined();
  });

  it("does not match a bare package specifier", () => {
    expect(matchRestrictedModuleId("react", ROOT)).toBeUndefined();
  });

  it("matches through a ?raw query and a virtual-module prefix together", () => {
    expect(matchRestrictedModuleId(`\0${ROOT}/src/harness/reui-scheduling/fixtures.ts?raw`, ROOT)).toBe(
      "src/harness/",
    );
  });

  it("matches through Vite's /@fs/ prefix", () => {
    expect(matchRestrictedModuleId(`/@fs/${ROOT}/src/components/reui/gantt/gantt-bar.tsx`, ROOT)).toBe(
      "src/components/reui/gantt/",
    );
  });

  it("matches a new Worker(new URL(...)) resolved module id (a plain ?worker query id)", () => {
    expect(matchRestrictedModuleId(`${ROOT}/src/harness/reui-scheduling/worker.ts?worker&type=module`, ROOT)).toBe(
      "src/harness/",
    );
  });

  it("matches with Windows path separators on both id and root", () => {
    const winRoot = "C:\\repo\\portal\\apps\\web";
    const winId = "C:\\repo\\portal\\apps\\web\\src\\harness\\main.tsx";
    expect(matchRestrictedModuleId(winId, winRoot)).toBe("src/harness/");
  });

  it("does not match root itself (no relative path, no restricted prefix)", () => {
    expect(matchRestrictedModuleId(ROOT, ROOT)).toBeUndefined();
  });
});

describe("RESTRICTED_MODULE_PREFIXES", () => {
  it("is exactly the two documented prefixes", () => {
    expect(RESTRICTED_MODULE_PREFIXES).toEqual(["src/harness/", "src/components/reui/gantt/"]);
  });
});

describe("checkForRestrictedModules", () => {
  function fakeContext(moduleIds: string[], importersById: Record<string, string[]> = {}): {
    context: RestrictedModuleGraphContext;
    error: ReturnType<typeof vi.fn>;
  } {
    const error = vi.fn((message: string) => {
      throw new Error(message);
    });
    const context: RestrictedModuleGraphContext = {
      getModuleIds: () => moduleIds,
      getModuleInfo: (id) => (moduleIds.includes(id) ? { importers: importersById[id] ?? [] } : null),
      error: error as unknown as (message: string) => never,
    };
    return { context, error };
  }

  it("does not call error when no module id is restricted", () => {
    const { context, error } = fakeContext([`${ROOT}/src/screens/Dashboard.tsx`, `${ROOT}/src/App.tsx`]);
    expect(() => checkForRestrictedModules(context, ROOT)).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });

  it("calls error naming the offending module and its importers when the harness is reachable", () => {
    const offender = `${ROOT}/src/harness/reui-scheduling/main.tsx`;
    const { context, error } = fakeContext([`${ROOT}/src/App.tsx`, offender], {
      [offender]: [`${ROOT}/src/screens/Dashboard.tsx`],
    });
    expect(() => checkForRestrictedModules(context, ROOT)).toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    const message = error.mock.calls[0]?.[0] as string;
    expect(message).toContain(offender);
    expect(message).toContain(`${ROOT}/src/screens/Dashboard.tsx`);
  });

  it("calls error naming every offender when more than one restricted module is reachable", () => {
    const harnessOffender = `${ROOT}/src/harness/reui-scheduling/main.tsx`;
    const ganttOffender = `${ROOT}/src/components/reui/gantt/gantt.tsx`;
    const { context, error } = fakeContext([harnessOffender, ganttOffender]);
    expect(() => checkForRestrictedModules(context, ROOT)).toThrow();
    const message = error.mock.calls[0]?.[0] as string;
    expect(message).toContain(harnessOffender);
    expect(message).toContain(ganttOffender);
  });

  it("reports 'no importers recorded' when the entry has none (rather than crashing)", () => {
    const offender = `${ROOT}/src/harness/reui-scheduling/main.tsx`;
    const { context, error } = fakeContext([offender], { [offender]: [] });
    expect(() => checkForRestrictedModules(context, ROOT)).toThrow();
    const message = error.mock.calls[0]?.[0] as string;
    expect(message).toContain(offender);
    expect(message.toLowerCase()).toContain("no importers recorded");
  });

  it("matches through a ?query-suffixed module id from getModuleIds()", () => {
    const offender = `${ROOT}/src/harness/reui-scheduling/fixtures.ts?raw`;
    const { context, error } = fakeContext([offender]);
    expect(() => checkForRestrictedModules(context, ROOT)).toThrow();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
