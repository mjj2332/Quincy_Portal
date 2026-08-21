# TB8 — Surface-by-Surface Design Convergence and Cleanup

**Primary user outcome:** proven patterns spread across Quincy while each migrated feature surface visibly converges toward the approved design system/prototype intent and duplicated legacy paths retire safely.

## Preconditions

- TB0 drift register and visual baseline accepted.
- UI foundation accepted.
- query conventions accepted.
- project discussion live.
- notification outbox proven.
- TB5A ordering correction and TB5B board modernization live.
- notice-board direction proven.

## Scope candidates

Each candidate becomes its own reviewed feature-surface release rather than one final bulk conversion:

- Dashboard shell, filters, project cards and responsive navigation.
- Project Workspace rail, collection controls and empty/error/loading states.
- Review Lightbox controls while preserving specialized media/annotation CSS.
- Remaining project/admin forms.
- Standard menus/dialogs/popovers.
- Notification UI.
- Board filters/card controls.
- Collaboration panel.
- Notice board.
- Dead CSS selectors and final Preflight/base-layer decision.
- Legacy component fetch-state and old notification-emission paths where their replacements are already proven.

## Rules

- group by real feature surfaces, not file-extension cleanup;
- begin from the TB0 drift register and update it with the release;
- compare matched prototype/current/migrated evidence at relevant viewports;
- preserve useful production evolution and required accessibility behavior;
- require an explicit owner-approved reason for material reference deviations;
- remove an old path only when its last consumer has migrated;
- preserve historical plans;
- keep specialized CSS/libraries where clearer;
- never turn TB8 into a whole-app rewrite;
- continue one reviewed release at a time.

## Acceptance for each surface

- product behavior and access rules remain correct;
- typography, spacing, geometry, hierarchy, borders, radius, elevation, focus, motion and responsive behavior pass the convergence contract;
- no stock shadcn appearance or raw palette contract;
- matched visual evidence is attached to the plan/review record;
- drift-register items for the surface are closed, intentionally retained with rationale, or explicitly deferred with an owner;
- no long-lived dual style/data owner;
- obsolete selectors/paths are removed only when unreferenced;
- targeted and full gates pass.

## Program completion

TB8 completes only when:

- docs describe the live architecture;
- remaining legacy CSS is intentional and owned;
- query/polling logic is centralized by feature;
- old notification paths are removed only after all event types migrate;
- every in-scope surface has a resolved drift-register disposition;
- final visual, accessibility and full repository gates pass.
