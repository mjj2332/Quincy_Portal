---
status: accepted
---

# The Project route is layered over the Dashboard, not swapped for it

The glossary's **Project sheet** (`portal/packages/shared/CONTEXT.md`) is the Project workspace
floating over the Dashboard: dismissing it returns to the same Dashboard view underneath, with its
scroll, search, filters and opener intact. Until #366 `/projects/:id` was a full page — a sibling
leaf that unmounted the Dashboard, which then re-mounted cold on return.

## Decision

1. **A pathless layout route owns both.** `dashboardLayerRoute` (`id: "dashboard-layer"`, parent
   `rootRoute`) owns `/` and `/projects/$projectId`. It renders the Dashboard once and, at a Project
   URL, a `ProjectSheet` around `<Outlet />`. A layout match persists across its children changing;
   sibling leaves unmount each other. `/projects/new` and `/projects/$id/edit` stay root children —
   full pages, as before (#374 moves edit into the sheet). The router history is still read-only
   (`lib/staff-history.ts`); navigation goes through `locationStore()` / `InternalLink`.
2. **The Dashboard reads its location through a lens** (`lib/dashboard-location.ts`), not
   `locationStore()` directly. The Dashboard parses the raw URL, and at a Project URL its
   reconciliation, Calendar canonicaliser and search writer would each overwrite that URL and close
   the sheet. Under the sheet the lens reports the remembered Dashboard location and keeps the
   Dashboard's own Dashboard-shaped writes in memory. With no provider (every standalone Dashboard
   test) it is the live store.
3. **Sheet bookkeeping lives in `history.state`**, never the URL:
   `{ quincySheet: { v: 1, backdrop, depth, prev } }`, written only by the adapter and validated on
   every read (a reload or a hostile page can put anything there). `?collaboration=open` and every
   other spelling stays byte-exact.
4. **Close walks back, else replaces.** With valid state, close is `history.go(-depth)`: pushing
   would leave `[dashboard, project, dashboard]`, and Back would reopen the sheet. Without it — a
   cold direct link — close is `replace(backdrop)`. **No baseline entry is injected for a cold
   link**: that mutates history the person never made and needs reload/StrictMode guards. The cost:
   Back from a cold-linked sheet leaves the app, as for any direct link.
5. **Keyboard activation of an in-app link is an SPA push** (`shouldInterceptInternalLink` no longer
   excludes `event.detail === 0`). The exclusion dated from the first router commit with no recorded
   reason; Calendar and Gantt openers already intercepted Enter. Left native, Enter on a List row or
   Kanban card was a document load: the Dashboard re-mounted at `/` and lost search, filters, scroll
   and the opener. Ctrl/Meta/Shift/Alt+Enter still carry modifier flags and open natively.
6. **Exactly one `ToastViewport` per route**, inside the sheet when it is open. A modal dialog
   aria-hides everything outside it, so a Dashboard viewport under the sheet would paint but never
   announce. `Dashboard` renders its viewport only when it is not a backdrop.
7. **Esc / outside press are gated by a layer snapshot**, taken at window-capture before any handler
   runs (`ProjectSheet`, `project-sheet-layers.ts`). Base UI's dialog dismissal listens on `document`
   and stops propagation, which would starve the Lightbox's `window` listener; when an inner modal
   (the in-place Lightbox, or a global confirm/`Modal`) is open the sheet cancels its own dismissal
   and allows propagation.

## Consequences

- A direct Project link also loads the Dashboard (its project and view queries) under the sheet.
  Chosen over an empty backdrop because closing must land on a real, already-loaded view, and the
  backdrop must be the live component the viewer returns to. One code path for in-app and direct
  opens. The Dashboard keeps polling under the sheet — a note for #361's measurements.
- The rail models the backdrop view while a sheet is open (the Dashboard is still mounted and still
  publishes its view). "Navigating via the rail while the sheet is open" is unreachable by a person
  (the rail is under the modal scrim), so the requirement is restated and tested as: any navigation
  to a non-sheet location closes the sheet.
- Popover / menu / mention arms of the layer predicate arrive with #375.
