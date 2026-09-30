import { apiPost } from "./api";
import type { DashboardView } from "../screens/dashboard-helpers";

/**
 * Boot timing (#361): where does a normal sign-in spend its time?
 *
 * Two marks on the browser's own timeline (`performance.mark`, visible in DevTools
 * Performance -> Timings), both measured from navigation start:
 *   quincy:session-resolved  "Loading the studio..." gone (`useSession` settled)
 *   quincy:dashboard-data    the first Dashboard projects query succeeded
 * plus ONE data-free beacon to `POST /api/boot-timing`, which the Worker writes to Workers Logs
 * so the numbers are readable from production (see docs/Guides/Load-Time-Measurement.md).
 *
 * A module singleton, because marks must happen once per PAGE LOAD, not once per mount
 * (StrictMode double-invokes effects; the Dashboard remounts on navigation).
 */

let landedOnDashboard = false;
let hidden = false;
let sessionMs: number | null = null;
let dataMarked = false;
let visibilityListening = false;

/** Called once from `main.tsx`, before first render. Only a load that lands on `/` is a Dashboard boot. */
export function captureBootLanding(pathname: string): void {
  landedOnDashboard = pathname === "/";
  if (typeof document === "undefined") return;
  hidden = document.visibilityState === "hidden";
  if (visibilityListening) return;
  visibilityListening = true;
  // A backgrounded tab throttles timers and delays paint: those samples are noise, flagged not dropped.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") hidden = true; });
}

function mark(name: string, start: number, end: number): void {
  try {
    performance.mark(name, { startTime: end });
    performance.measure(`${name}:since-navigation`, { start, end });
  } catch { /* Timeline entries are best-effort. */ }
}

export function markSessionResolved(): void {
  if (sessionMs !== null) return;
  sessionMs = performance.now();
  mark("quincy:session-resolved", 0, sessionMs);
}

export function markDashboardData(view: DashboardView): void {
  if (!landedOnDashboard || dataMarked) return;
  dataMarked = true;
  const dashboardMs = performance.now();
  const session = sessionMs ?? dashboardMs;
  mark("quincy:dashboard-data", 0, dashboardMs);
  try {
    apiPost("/api/boot-timing", { sessionMs: round(session), dashboardMs: round(dashboardMs), view, hidden }).catch(() => undefined);
  } catch { /* Never let the beacon disturb the page. */ }
}

const round = (ms: number) => Math.min(600_000, Math.max(0, Math.round(ms * 10) / 10));

/** Test seam: a fresh page load. */
export function resetBootTimingForTests(): void {
  landedOnDashboard = false; hidden = false; sessionMs = null; dataMarked = false;
}
