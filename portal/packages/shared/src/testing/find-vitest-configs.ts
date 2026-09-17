/**
 * Discovery of every vitest config under `portal/`, shared by the guards that hold them to a rule.
 *
 * It is one function because two guards disagreeing about what counts as a config is the same
 * decorative-guard failure both were written to prevent: `ci-vitest-configs.guard.test.ts` used
 * `/^vitest(\..+)?\.config\.[cm]?[jt]s$/` while `vitest-timeouts.guard.test.ts` shipped with a
 * narrower pattern, so a `vitest.config.mts` would have been required to run in CI and allowed to
 * keep the default timeouts. Discovery belongs in one place so a new config is either covered by
 * every guard or by none of them.
 *
 * Discovery is from the filesystem, never a list: a new config fails the guards until it complies.
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler", "coverage"]);

/** Every vitest config under `portalRoot`, as sorted portal-relative paths. */
export function findVitestConfigs(portalRoot: string, dir: string = portalRoot): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...findVitestConfigs(portalRoot, join(dir, entry.name)));
    } else if (/^vitest(\..+)?\.config\.[cm]?[jt]s$/.test(entry.name)) {
      found.push(relative(portalRoot, join(dir, entry.name)));
    }
  }
  return found.sort();
}
