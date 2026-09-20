/**
 * Dev-only entry point for the #219 (Gantt / event-calendar) vendor harness. Quincy-owned, not a
 * ReUI vendored file.
 *
 * This is a SEPARATE Vite HTML entry (`harness/reui-scheduling/index.html`), not a TanStack
 * route, not a feature flag, and not a branch in `src/main.tsx`. It exists so the vendored
 * ReUI primitives under `components/reui/gantt/` (and later `components/reui/event-calendar/`)
 * can be exercised with local fixture data before anything in the production app imports them —
 * see `docs/reui-block-adoption.md` and `harness-reachability.guard.test.ts`, which prove (a)
 * nothing outside `src/harness/` imports this tree, and (b) `vite build`'s only input stays
 * `index.html`, so this entry, its chunk, and the harness URL never reach production.
 *
 * Imports the app's global stylesheet so Quincy's design tokens apply here the same as in the
 * real app — otherwise a vendored primitive would render against browser defaults, not the
 * tokens it will actually ship inside.
 *
 * The Gantt render itself lives in the lazy-imported `./GanttPreview` (#219 stage 1) — local
 * fixture rows only, no `lib/use-scheduling-commands`, no `lib/scheduling-policy`, no API client.
 * #219 PR A standards review item 9: this comment used to say the file had not been run in a
 * browser, typechecked and wired, no more — stale since GanttPreview's stage-3 rewrite turned it
 * into a real acceptance surface. It has since been driven in a real browser across three
 * acceptance passes (evidence retained under the worktree's `qa-evidence/`).
 */
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/index.css";

const GanttPreview = lazy(() => import("./GanttPreview"));

function VendorHarness() {
  return (
    <div data-testid="vendor-harness">
      <Suspense fallback={<p>Loading vendor harness…</p>}>
        <GanttPreview />
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
