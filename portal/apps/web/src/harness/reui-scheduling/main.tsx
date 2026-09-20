/**
 * Dev-only entry point for the #219 (Gantt / event-calendar) vendor harness. Quincy-owned, not a
 * ReUI vendored file.
 *
 * This is a SEPARATE Vite HTML entry (`harness/reui-scheduling/index.html`), not a TanStack
 * route, not a feature flag, and not a branch in `src/main.tsx`. It exists so the vendored
 * ReUI primitives under `components/reui/gantt/` and `components/reui/event-calendar/` can be
 * exercised with local fixture data before anything in the production app imports them — see
 * `docs/reui-block-adoption.md` and `harness-reachability.guard.test.ts`, which prove (a) nothing
 * outside `src/harness/` imports either tree, and (b) `vite build`'s only input stays
 * `index.html`, so this entry, its chunk, and the harness URL never reach production.
 *
 * Imports the app's global stylesheet so Quincy's design tokens apply here the same as in the
 * real app — otherwise a vendored primitive would render against browser defaults, not the
 * tokens it will actually ship inside.
 *
 * Two surfaces, lazy-imported and switched below:
 *  - `./GanttPreview` (#219 stage 1 / PR A) — the vendored `components/reui/gantt/` tree.
 *  - `./CalendarPreview` (#219 stage 3 / PR B) — the vendored `components/reui/event-calendar/`
 *    tree.
 * Both render local fixture rows only — no `lib/use-scheduling-commands`, no
 * `lib/scheduling-policy`, no API client. The switch defaults to Gantt so existing recorded
 * evidence (acceptance passes, `qa-evidence/`) against the pre-PR-B harness stays reproducible at
 * the same default URL.
 * #219 PR A standards review item 9: this comment used to say the file had not been run in a
 * browser, typechecked and wired, no more — stale since GanttPreview's stage-3 rewrite turned it
 * into a real acceptance surface. It has since been driven in a real browser across three
 * acceptance passes (evidence retained under the worktree's `qa-evidence/`).
 */
import { lazy, StrictMode, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/index.css";

const GanttPreview = lazy(() => import("./GanttPreview"));
const CalendarPreview = lazy(() => import("./CalendarPreview"));

type Surface = "gantt" | "calendar";

function VendorHarness() {
  const [surface, setSurface] = useState<Surface>("gantt");

  return (
    <div data-testid="vendor-harness">
      <div role="group" aria-label="Surface" className="flex flex-wrap items-center gap-2 p-4">
        <button
          type="button"
          data-testid="harness-surface-gantt"
          aria-pressed={surface === "gantt"}
          onClick={() => setSurface("gantt")}
        >
          Gantt
        </button>
        <button
          type="button"
          data-testid="harness-surface-calendar"
          aria-pressed={surface === "calendar"}
          onClick={() => setSurface("calendar")}
        >
          Calendar
        </button>
      </div>
      <Suspense fallback={<p>Loading vendor harness…</p>}>
        {surface === "gantt" ? <GanttPreview /> : <CalendarPreview />}
      </Suspense>
    </div>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("ReUI scheduling harness could not find its root element.");
}

createRoot(root).render(
  <StrictMode>
    <VendorHarness />
  </StrictMode>,
);
