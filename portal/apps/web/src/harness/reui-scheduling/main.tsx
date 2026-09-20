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
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/index.css";

function VendorHarnessPlaceholder() {
  return (
    <div data-testid="vendor-harness">
      <p>ReUI scheduling vendor harness — #219 stage 1. No vendored render wired up yet.</p>
    </div>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("ReUI scheduling harness could not find its root element.");
}

createRoot(root).render(
  <StrictMode>
    <VendorHarnessPlaceholder />
  </StrictMode>,
);
