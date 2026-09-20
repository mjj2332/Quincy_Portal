/**
 * #219 PR A round 2, item 1a (Sol's re-review). The static `harness-reachability.guard.test.ts`
 * enumerates import FORMS — static import, `export … from`, dynamic `import()`, `import.meta.glob`,
 * `require()` — by parsing source text. That can never be exhaustive: any new Vite import form
 * (`?raw`, `?worker`, `new Worker(new URL(...))`, a future syntax) is a blind spot on day one.
 *
 * The bundler's own module graph does not have that problem — every module that ends up in a
 * production bundle, however it got there, is a module id Rollup/Rolldown resolved. This plugin
 * makes THAT graph authoritative: at the end of a production build, if any module id it discovered
 * is inside a restricted directory, the build fails, naming the module and (where Rollup/Rolldown
 * still has it) its importers. `apply: "build"` — this must never run for `vite dev`, which is how
 * the harness's HTML entry is served in the first place.
 *
 * The static guard remains — it is fast, cheap CI feedback that fires on `git diff` before anyone
 * waits on a full production build. This plugin is the backstop that cannot be fooled by a form the
 * guard's parser does not know about yet.
 *
 * #219 PR A round 3 (Sol's round-3 review) closed two remaining holes in this backstop:
 *
 * 1. BLOCKER — Vite 8's worker sub-builds (`new Worker(new URL("./x.ts", import.meta.url))`) run
 *    an entirely separate Rolldown bundling pass with their OWN plugin pipeline; the top-level
 *    `plugins` array this file is registered in is never consulted for it. `vite.config.ts` now
 *    ALSO registers a fresh instance of this plugin via `worker: { plugins: () => [...] }` — Vite's
 *    own `worker.plugins` type requires a NEW instance per call (one per worker bundle), which this
 *    factory already satisfies: it closes over nothing but its `root` argument, so calling it twice
 *    is always safe and never shares state between the two registrations.
 * 2. An asset (`.css`/`.svg`/`.png`/`.json`/`.wasm`/…) referenced only via a Vite asset URL
 *    (`new URL("./x.png", import.meta.url)`) or a CSS `url(...)` can be emitted by a production
 *    build, or inlined, with no module id shape this plugin's `getModuleIds()` walk is guaranteed
 *    to see — an emitted asset is a Rollup/Rolldown ASSET, not necessarily a MODULE id this plugin
 *    can enumerate. Orchestrator decision: rather than build a second, asset-origin scanner here,
 *    the hole is made impossible instead — `src/harness/harness-reachability.guard.test.ts`'s
 *    "may contain only scanned source" guard fails the build the moment any non-source file lands
 *    under `src/harness/` or `src/components/reui/gantt/` at all (except a literal `.html`/`.md`
 *    directly inside the harness's own HTML entry dir), so there is never an asset in either
 *    restricted tree for this hole to apply to in the first place.
 */
import type { Plugin } from "vite"

/**
 * Directories (relative to `apps/web`, forward-slash, trailing slash) that must never appear as a
 * module id in a production bundle.
 *
 * - `src/harness/` — the dev-only Vite HTML entry for exercising vendored primitives against local
 *   fixtures before anything in the production app imports them. Stays forever: it is not meant to
 *   ever ship, regardless of what else lands in `src/components/reui/`.
 * - `src/components/reui/gantt/` — vendored, unwired ReUI Gantt primitives (#219 stage 1). Removed
 *   from this list by the slice that adopts the Gantt into the Dashboard (#220), which is exactly
 *   the point at which a real production consumer starts importing it on purpose.
 */
export const RESTRICTED_MODULE_PREFIXES = ["src/harness/", "src/components/reui/gantt/"] as const

/**
 * Strips the parts of a Rollup/Rolldown module id that are not part of the on-disk path: a leading
 * virtual-module null byte (`\0`, optionally followed by more than one — some plugins double it up),
 * a trailing `?query` (e.g. `?raw`, `?worker`, `?url`), a trailing `#hash`, and Vite's `/@fs/` prefix
 * (used to reach an absolute filesystem path from dev-server URL space). Windows backslashes are
 * normalised to forward slashes so prefix matching is platform-independent.
 */
export function normalizeModuleId(id: string): string {
  let normalized = id
  while (normalized.startsWith("\0")) normalized = normalized.slice(1)
  const queryIndex = normalized.indexOf("?")
  if (queryIndex !== -1) normalized = normalized.slice(0, queryIndex)
  const hashIndex = normalized.indexOf("#")
  if (hashIndex !== -1) normalized = normalized.slice(0, hashIndex)
  normalized = normalized.split("\\").join("/")
  if (normalized.startsWith("/@fs/")) normalized = normalized.slice("/@fs/".length)
  return normalized
}

/**
 * Whether `id` (a raw Rollup/Rolldown module id) resolves, once normalised, to a path under `root`
 * (an absolute, forward-slash project root — `apps/web`) that starts with one of
 * `RESTRICTED_MODULE_PREFIXES`. Returns the matched prefix, or `undefined` if `id` is not under
 * `root` at all (a bare package specifier, a virtual id unrelated to this project, a path outside
 * the project) or is under `root` but not inside a restricted directory.
 */
export function matchRestrictedModuleId(id: string, root: string): (typeof RESTRICTED_MODULE_PREFIXES)[number] | undefined {
  const normalizedId = normalizeModuleId(id)
  const normalizedRoot = normalizeModuleId(root).replace(/\/+$/, "")
  if (normalizedId !== normalizedRoot && !normalizedId.startsWith(`${normalizedRoot}/`)) return undefined
  const relativeToRoot = normalizedId === normalizedRoot ? "" : normalizedId.slice(normalizedRoot.length + 1)
  return RESTRICTED_MODULE_PREFIXES.find((prefix) => relativeToRoot.startsWith(prefix))
}

/**
 * The slice of Rollup/Rolldown's real `PluginContext` this check needs. `vite` does not re-export
 * `PluginContext` from its public API (only `Plugin`, whose hooks are contextually typed with it
 * internally), so this is a minimal structural interface instead of importing the underlying
 * `rolldown` package directly as an undeclared dependency. The real `PluginContext` vite hands
 * `generateBundle` satisfies this structurally; a fake one built for a test only needs these three
 * members.
 */
export interface RestrictedModuleGraphContext {
  getModuleIds(): Iterable<string>
  getModuleInfo(id: string): { importers: readonly string[] } | null | undefined
  error(message: string): never
}

/**
 * Scans every module id the given plugin context's build discovered (`context.getModuleIds()`) for
 * one matching `RESTRICTED_MODULE_PREFIXES` under `root`, and throws (via `context.error`) naming
 * every offender and its known importers if it finds one. Exported separately from the plugin
 * factory so it can be unit-tested against a fake context, not just through a real
 * Rollup/Rolldown build.
 */
export function checkForRestrictedModules(context: RestrictedModuleGraphContext, root: string): void {
  const offenders: string[] = []
  for (const id of context.getModuleIds()) {
    const prefix = matchRestrictedModuleId(id, root)
    if (!prefix) continue
    const info = context.getModuleInfo(id)
    const importers = info?.importers.length ? info.importers.join(", ") : "(entry point / no importers recorded)"
    offenders.push(`  ${id} (matched restricted prefix "${prefix}"), imported by: ${importers}`)
  }
  if (offenders.length === 0) return
  context.error(
    [
      "Production bundle reaches a dev-only module that must never ship. The static",
      "harness-reachability.guard.test.ts import-form scan missed this — the module graph is the",
      "authority here, so the build fails instead of shipping it:",
      ...offenders,
    ].join("\n"),
  )
}

/**
 * Vite plugin: at the end of a production build (`apply: "build"` — never `vite dev`, which is how
 * `harness/reui-scheduling/index.html` is served at all), fails the build if the module graph
 * reached anything under `RESTRICTED_MODULE_PREFIXES`.
 */
export function forbidDevOnlyModules(root: string): Plugin {
  return {
    name: "quincy:forbid-dev-only-modules",
    apply: "build",
    generateBundle() {
      checkForRestrictedModules(this, root)
    },
  }
}
