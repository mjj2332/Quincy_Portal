/**
 * #359: React, TanStack and Base UI change only when a dependency is upgraded, so they are split
 * into a `vendor` chunk whose content hash survives ordinary app deploys (the entry chunk's hash
 * changes on every app edit; a returning browser keeps its cached, immutable vendor file).
 *
 * `vite.config.ts` carries the split as `build.rolldownOptions.output.codeSplitting.groups`. That
 * is a bundler heuristic: a renamed package, a new import path or a config edit can silently put
 * these modules back in the entry chunk, and nothing would fail — the app would just cache worse.
 * This plugin makes the outcome a build failure instead: at `generateBundle`, no ENTRY chunk may
 * contain a vendor module, and a chunk named `vendor` must exist.
 *
 * Manual end-to-end proof (a real build, not a repeatable automated test, like
 * `forbid-dev-only-modules.ts`): remove the `codeSplitting` group from `vite.config.ts`, run
 * `npm run build -w @quincy/web`, and observe the build fail with `quincy:vendor-chunk-guard`
 * naming the entry chunk; then restore the group.
 */
import type { Plugin } from "vite";

/** Module ids (any path separator) that belong in the vendor chunk. Shared with `vite.config.ts`. */
export const VENDOR_MODULE_PATTERN = /[\\/]node_modules[\\/](?:(?:react|react-dom|scheduler)[\\/]|@tanstack[\\/](?:react-router|react-query|history|router-core|query-core|store|react-store)[\\/]|@base-ui[\\/][^\\/]+[\\/])/u;

/** The name of the chunk the code-splitting group emits. */
export const VENDOR_CHUNK_NAME = "vendor";

/** The slice of a Rolldown output chunk this check reads. */
export interface VendorGuardChunk {
  type: "chunk" | "asset";
  name?: string;
  isEntry?: boolean;
  moduleIds?: readonly string[];
  fileName?: string;
}

export interface VendorGuardContext {
  error(message: string): never;
}

/**
 * Throws (via `context.error`) if any entry chunk contains a vendor module, or if no chunk named
 * `vendor` was emitted. Exported separately from the plugin so it can be tested with synthetic
 * bundles.
 */
export function checkVendorChunk(context: VendorGuardContext, bundle: Record<string, VendorGuardChunk>): void {
  const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
  const problems: string[] = [];
  if (!chunks.some((chunk) => chunk.name === VENDOR_CHUNK_NAME)) {
    problems.push(`  no chunk named "${VENDOR_CHUNK_NAME}" was emitted; check build.rolldownOptions.output.codeSplitting in vite.config.ts`);
  }
  for (const chunk of chunks) {
    if (!chunk.isEntry) continue;
    const leaked = (chunk.moduleIds ?? []).filter((id) => VENDOR_MODULE_PATTERN.test(id));
    if (leaked.length === 0) continue;
    const sample = leaked.slice(0, 5).join(", ");
    problems.push(`  entry chunk ${chunk.fileName ?? chunk.name ?? "(unnamed)"} contains ${leaked.length} vendor module(s), e.g. ${sample}`);
  }
  if (problems.length === 0) return;
  context.error(
    [
      "React / TanStack / Base UI must live in the \"vendor\" chunk, not the entry chunk (#359), or every",
      "app deploy invalidates the browser's cached copy of them:",
      ...problems,
    ].join("\n"),
  );
}

export function vendorChunkGuard(): Plugin {
  return {
    name: "quincy:vendor-chunk-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      checkVendorChunk(this, bundle as unknown as Record<string, VendorGuardChunk>);
    },
  };
}
