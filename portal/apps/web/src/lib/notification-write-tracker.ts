/**
 * #115 — the write barrier every `useNotificationFeed` instance in the tab shares. The Bell (poll
 * 25s, first page) and `/settings/notifications` (paged, no poll) are separate hook instances, each
 * with its own optimistic copy of the list. A head fetch that lands while a write from EITHER
 * instance is still unconfirmed cannot tell whether the server had already applied that write when
 * it computed the response, so applying it risks clobbering the optimistic state with stale rows.
 * `use-notifications.ts` uses this module's `pending`/`generation` scoreboard to drop such a
 * response instead, and to know when to refetch once every write in flight has settled.
 *
 * - `pending` is the count of writes currently in flight, tab-wide.
 * - `generation` bumps on every edge — a write starting, a write settling (success, failure, or
 *   timeout) — so a caller that captures it before a request and compares it after can tell "did
 *   anything happen during this request" without caring what.
 *
 * `trackWrite` never throws: a failed write still needs the barrier released and every mounted
 * instance reconciled to server state, not an unhandled rejection.
 */

let pending = 0;
let generation = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function writeSnapshot(): { pending: number; generation: number } {
  return { pending, generation };
}

export function subscribeWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs `write`, keeping the barrier up for its duration. `timeoutMs` bounds how long a hung write
 * can hold the barrier: `apiPost`/`apiDelete` take no `AbortSignal`, so the timeout only releases
 * OTHER instances to reconcile against server state — it does not cancel the request. If the write
 * later settles for real, `generation` bumps once more (without touching `pending`, which the
 * timeout already returned to its pre-write count) so every mounted instance's reconcile listener
 * refetches again and picks up whatever that late write actually did.
 */
export async function trackWrite(write: () => Promise<unknown>, timeoutMs = 15_000): Promise<void> {
  pending += 1;
  generation += 1;
  notify();

  // A synchronous throw from `write` must settle like a rejection, not escape with `pending` raised.
  let started: Promise<unknown>;
  try { started = write(); } catch (error) { started = Promise.reject(error); }
  const settleWrite = started.then(
    () => "settled" as const,
    () => "settled" as const,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutRace = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const outcome = await Promise.race([settleWrite, timeoutRace]);
  if (timer !== undefined) clearTimeout(timer);

  pending -= 1;
  generation += 1;
  notify();

  if (outcome === "timeout") {
    // The write is still out there. Let it finish on its own time and bump the barrier again when
    // it does, so a reconcile still runs even though this function already returned.
    void settleWrite.then(() => {
      generation += 1;
      notify();
    });
  }
}
