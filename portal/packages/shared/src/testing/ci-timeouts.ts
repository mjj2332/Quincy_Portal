/**
 * Per-test and per-hook time budgets for every vitest config under `portal/`.
 *
 * Vitest defaults to 5s for a test and 10s for a hook. Neither was chosen for this repo, and
 * neither survives its CI runner. Measured across all eight configs on one green run, CI is
 * between 3x and 22x slower than a local disk, and the ordering does not follow the runtime:
 *
 *   apps/web/vitest.dom.config.ts      7.49s -> 164.72s   22.0x
 *   packages/db/vitest.config.ts       2.17s ->  23.83s   11.0x
 *   apps/web/vitest.config.ts          1.42s ->  15.34s   10.8x
 *   workers/background                11.97s -> 116.09s    9.7x
 *   workers/app                       18.25s -> 139.36s    7.6x
 *   packages/shared                    1.59s ->   9.60s    6.0x
 *   workers/webhook-ingress            0.25s ->   0.76s    3.0x
 *   workers/app (dev config)           4.75s ->  13.39s    2.8x
 *
 * At 22x a test taking 228ms locally is already at the 5s edge — an ordinary DOM test. That is
 * why four separate suites timed out in a single day (#170, #181, #117, and
 * `route-manifest.test.ts:289` at 142ms local against >5000ms on CI) with no assertion failing in
 * any of them.
 *
 * 30s covers anything up to ~1.4s locally at the worst measured factor, and matches the
 * convention `workers/app/test/api.test.ts` already uses at lines 803, 996 and 2082.
 *
 * This raises a ceiling, it does not weaken a check: a hung test still fails, 25s later than it
 * used to. If a single test needs longer, give it its own `it(..., ms)` or `describe` option so
 * the reason lives next to the test, rather than raising this for everyone.
 */
export const CI_TEST_TIMEOUT_MS = 30_000;
export const CI_HOOK_TIMEOUT_MS = 30_000;
