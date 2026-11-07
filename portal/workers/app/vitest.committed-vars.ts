import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";

/**
 * The `vars` of the committed wrangler.jsonc, for the test configs to pin as Miniflare bindings.
 *
 * Wrangler always merges a local, gitignored `.dev.vars` over these vars (it has no opt-out),
 * so a developer's `APP_ORIGIN=http://localhost:…` reached the test Worker: guest cookies lost
 * their `__Secure-` prefix and every guest suite failed with "no session" locally while CI,
 * which has no `.dev.vars`, stayed green. Bindings passed to `cloudflareTest` win over the
 * wrangler-derived ones, so pinning the committed values keeps the suite hermetic.
 */
export function committedVars(): Record<string, unknown> {
  return unstable_readConfig({ config: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) }).vars;
}
