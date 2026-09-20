/**
 * Unit tests for `forbid-dev-only-modules.ts` (#219 PR A round 2, item 1a). Three layers, all pure:
 * `normalizeModuleId`/`matchRestrictedModuleId` (the module-id matcher, exercised with fake ids in
 * every form Vite/Rollup/Rolldown are known to produce), `checkForRestrictedModules` (the plugin
 * hook body, exercised against a fake `RestrictedModuleGraphContext` — no real bundler involved),
 * and — round 3, Sol MEDIUM — `forbidDevOnlyModules` itself: every test above calls
 * `checkForRestrictedModules` directly, never the factory this module exports, so removing
 * `apply: "build"` or wiring `generateBundle` to the wrong function stayed green. The bottom
 * `describe` block instantiates the real factory and invokes its real `generateBundle` hook.
 * The end-to-end build-failure proof (real `vite build`, real violation, real revert) is done once
 * manually per the spec and is not a repeatable automated test — it would require committing a
 * deliberately broken production import, which is exactly what this guard exists to prevent from
 * ever landing.
 */
import { describe, expect, it, vi } from "vitest"
import {
  checkForRestrictedModules,
  forbidDevOnlyModules,
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
  // Exact-array, not `toContain`: the point of this assertion is that a prefix cannot be added
  // (widening what is kept out of production) or removed (letting a vendored tree ship) without
  // the change being visible here and in this file's own doc block. Each entry is removed by the
  // slice that gives that tree a real production consumer, never as a tidy-up.
  it("is exactly the three documented prefixes", () => {
    expect(RESTRICTED_MODULE_PREFIXES).toEqual([
      "src/harness/",
      "src/components/reui/gantt/",
      "src/components/reui/event-calendar/",
    ]);
  });
});

/**
 * Module-scoped (round 3: also used by `forbidDevOnlyModules`'s own describe block below, which
 * needs the identical fake context shape to exercise the real `generateBundle` hook).
 */
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

describe("checkForRestrictedModules", () => {

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

/**
 * `forbidDevOnlyModules` itself (round 3, Sol MEDIUM) — every test above exercises
 * `checkForRestrictedModules` directly, never the factory this module actually exports. Removing
 * `apply: "build"`, or wiring `generateBundle` to anything other than `checkForRestrictedModules`,
 * stayed green under the tests above; `harness-reachability.guard.test.ts`'s own "registers the
 * forbid-dev-only-modules build plugin" block only checks that `vite.config.ts` CALLS this factory
 * by name, not what the returned plugin object actually does. These invoke the plugin's REAL
 * `generateBundle` hook (cast through `unknown` the same way `checkForRestrictedModules`'s own
 * fake-context tests already do for `error` — Vite's `Plugin["generateBundle"]` is typed as a
 * Rollup/Rolldown `ObjectHook` union `{handler, order} | ((this: PluginContext, ...) => void)`; the
 * literal in `forbid-dev-only-modules.ts` is the plain-function branch of that union, which a fake
 * `RestrictedModuleGraphContext` satisfies structurally the same way it already does for
 * `checkForRestrictedModules`'s own direct calls above) against a fake context — not a real
 * Rollup/Rolldown build, which is the one-off manual proof described in this file's own header.
 */
describe("forbidDevOnlyModules (the plugin factory itself)", () => {
  function callGenerateBundle(
    plugin: ReturnType<typeof forbidDevOnlyModules>,
    context: RestrictedModuleGraphContext,
  ): void {
    const hook = plugin.generateBundle as unknown as (this: RestrictedModuleGraphContext) => void;
    hook.call(context);
  }

  it("returns a plugin with apply: 'build' (never vite dev) and a generateBundle function", () => {
    const plugin = forbidDevOnlyModules(ROOT);
    expect(plugin.name).toBe("quincy:forbid-dev-only-modules");
    expect(plugin.apply).toBe("build");
    expect(typeof plugin.generateBundle).toBe("function");
  });

  it("the real generateBundle hook does not error when the module graph is clean", () => {
    const plugin = forbidDevOnlyModules(ROOT);
    const { context, error } = fakeContext([`${ROOT}/src/screens/Dashboard.tsx`, `${ROOT}/src/App.tsx`]);
    expect(() => callGenerateBundle(plugin, context)).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });

  it("the real generateBundle hook errors, naming the offender and its importers, when a restricted module is reachable", () => {
    const plugin = forbidDevOnlyModules(ROOT);
    const offender = `${ROOT}/src/harness/reui-scheduling/main.tsx`;
    const { context, error } = fakeContext([`${ROOT}/src/App.tsx`, offender], {
      [offender]: [`${ROOT}/src/screens/Dashboard.tsx`],
    });
    expect(() => callGenerateBundle(plugin, context)).toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    const message = error.mock.calls[0]?.[0] as string;
    expect(message).toContain(offender);
    expect(message).toContain(`${ROOT}/src/screens/Dashboard.tsx`);
  });

  it("a fresh call returns a NEW plugin instance each time (Vite's own worker.plugins contract)", () => {
    const first = forbidDevOnlyModules(ROOT);
    const second = forbidDevOnlyModules(ROOT);
    expect(first).not.toBe(second);
  });
});
