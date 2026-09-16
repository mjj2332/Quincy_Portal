/**
 * DOM-suite network guard — no test may open a real network connection.
 *
 * happy-dom gives the document a default origin of `http://localhost:3000`, so anything the app
 * fetches during a test resolves against it and vitest opens a real TCP socket. Eight DOM files did
 * exactly that (#167), and every one still passed: the connection is refused, the rejection lands
 * after the test has ended, and vitest prints it as stderr rather than failing the run.
 *
 * The refusal is the only reason it was harmless, and the refusal is not guaranteed. With
 * `npm run dev` listening on :3000 those same requests SUCCEED against a real local API, so a test
 * can behave one way on a developer's machine and another on CI — flakiness with no visible cause.
 *
 * In every case the caller was better-auth's client (`lib/auth.ts`'s `useSession`, which polls
 * `/api/auth/get-session` through `@better-fetch/fetch`), not `lib/api.ts`. That matters for how
 * this guard is written: the call is issued from a timer, so it can land between tests or after
 * teardown. Hooking `fetch` in `beforeEach` misses it — the replacement has to be installed when
 * this module is evaluated, before any test file imports the app, and reasserted per test in case a
 * test restores the original.
 *
 * Failing the test is done by RECORDING the attempt and throwing in `afterEach`, not by relying on
 * the rejection: components catch their own fetch errors, so a bare rejection is swallowed. A test
 * that stubs `fetch` itself, or mocks the module that would call it, overrides this and is
 * unaffected — mocking `lib/auth` is the fix the eight files needed, and the house pattern:
 *
 *     vi.mock("../lib/auth", () => ({ useSession: () => ({ data: { user: { id: "user-1" } }, isPending: false }) }));
 *
 * **Never weaken this to a warning and never add an opt-out.** A test that needs the network needs
 * a stub instead. An unenforced rule is indistinguishable from no rule — the same reasoning that
 * put the DOM suite into CI to begin with (#158).
 */
import { afterAll, afterEach, beforeEach } from "vitest";

const attempts: string[] = [];

function label(input: RequestInfo | URL, init?: RequestInit): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
  return `${method} ${url}`;
}

function refuse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const attempt = label(input, init);
  attempts.push(attempt);
  return Promise.reject(new Error(`Unmocked fetch in a DOM test: ${attempt}`));
}

function install(): void {
  globalThis.fetch = refuse as typeof fetch;
}

/** For `no-unmocked-fetch.self.dom.test.tsx` only: proves the gate fires, and clears what it recorded. */
export function drainAttemptsForSelfTest(): string[] {
  return attempts.splice(0);
}

// At module scope, not just in a hook: the calls that prompted this guard are issued from timers
// and can fire before the first test's `beforeEach` or after the last test's teardown.
install();
beforeEach(install);

function report(scope: string): void {
  if (attempts.length === 0) return;
  const seen = [...new Set(attempts)];
  attempts.length = 0;
  throw new Error(
    `${scope} opened ${seen.length === 1 ? "a real network connection" : `${seen.length} real network connections`}:\n` +
      seen.map((attempt) => `  - ${attempt}`).join("\n") +
      "\n\nhappy-dom resolves these against http://localhost:3000, so they hit a dev server if one " +
      "is running. Mock the module that issues the request (see this file's header, and #167).\n" +
      "If this test looks innocent, the request may have been scheduled by a TIMER in an earlier " +
      "test in this file and only landed here — check the ones before it too.",
  );
}

afterEach(() => report("This test"));

// A timer-issued request can land after the file's last test, where no `afterEach` remains to
// report it. Nothing escapes to the network either way — the refusing `fetch` is installed at
// module scope and stays installed — but an unreported attempt is an unfixed one, so drain the
// task queue once and report what turned up.
//
// This is best-effort by nature: a request scheduled for later than the turn we wait for lands
// after the process has moved on and goes unreported. Reporting is the part that degrades, never
// containment. Do not extend the wait to chase it — a slow poll would cost every one of the 94
// files that delay on every run.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  report("This file, after its last test,");
});
