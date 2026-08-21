# Design Convergence Contract

**Status:** Approved direction; operational details and first drift register are finalized in TB0  
**Applies to:** every revamp slice that changes rendered UI

## 1. Outcome

The UI revamp is a design-convergence program implemented with Tailwind CSS v4 and source-owned shadcn components. Installing or using those tools is not success by itself.

A migrated surface succeeds when it behaves correctly, remains accessible and reads unmistakably as Quincy through its typography, spacing, geometry, hierarchy, borders, radius, elevation, motion and responsive behavior.

## 2. Sources of truth

Use these sources for different questions:

| Question | Authority |
|---|---|
| Product behavior, permissions and workflow | Repository authority documents and approved active plan |
| Visual language and tokens | Quincy design system under `prototype/_ds/.../tokens/` and its design-system guidance |
| Comparable layout and flow intent | Original `prototype/` screens |
| Production constraints and verified fixes | Current `portal/`, `docs/todo.md` and `docs/lessons.md` |
| Implementation technique | Approved frontend architecture and active tracer-bullet plan |

The prototype is never an application-architecture template. Do not copy its global/CDN/mock-state structure into `portal/`.

Current production is evidence, not automatic design authority. A live difference may be valuable evolution, a platform/accessibility requirement or accidental drift.

## 3. Drift classification

Every material difference in an audited or migrated surface receives one disposition:

| Disposition | Meaning | Required action |
|---|---|---|
| Conforming | Matches the design system/reference intent | Preserve and test |
| Intentional evolution | Product-approved improvement or added production feature | Record rationale and preserve |
| Required platform/accessibility change | Necessary for semantics, focus, responsive use, security or live data | Record evidence and preserve |
| Unwanted drift | Ad hoc divergence with no approved product reason | Correct through an isolated slice |
| Unassessed | Evidence or owner decision is missing | Assign owner/follow-up; cannot silently become permanent |

“Different because production has more features” is not a complete disposition. Classify the design treatment of the new feature even when the feature itself is intentional.

## 4. Drift register

TB0 creates a durable register with at least:

| Field | Description |
|---|---|
| Surface/state | Screen, component and state being compared |
| Viewport | Exact width/height or named agreed viewport |
| Reference evidence | Prototype/design-system screenshot or source |
| Current evidence | Production/current-main screenshot or source |
| Difference | Specific typography/layout/component/interaction delta |
| Disposition | One classification from §3 |
| Decision/rationale | Why it stays, changes or needs review |
| Target slice | TB/plan that owns correction |
| Status | Open, approved-retained, corrected, deferred |
| Verification | Test/screenshot/review evidence after change |

Keep the register modular by surface. Do not create one enormous screenshot document that every agent must load.

## 5. Initial surface inventory

TB0 samples and registers at least:

- sign-in and application shell;
- Dashboard/Kanban/List and project cards;
- Project Workspace rail, collection tabs and content;
- Review Lightbox and markup controls;
- create/edit/admin forms;
- collaboration panel;
- notice board;
- notifications;
- phone-width navigation and critical workflows.

A surface may be marked unassessed if representative state cannot be produced safely, but it needs an owner and follow-up.

## 6. Evidence method

For comparable states:

1. use equivalent content and role;
2. capture prototype and current/migrated surface at the same viewport;
3. compare structure before polish;
4. inspect typography, spacing, grid, control geometry, border/radius/elevation, color/token use, imagery treatment, focus/motion and responsive behavior;
5. classify every material difference;
6. attach the post-change evidence to the active plan/review record.

When the prototype lacks a production feature, derive its treatment from design-system rules and adjacent prototype patterns. Do not invent stock shadcn styling.

## 7. Per-surface definition of done

A UI slice is not done until:

- product behavior, security and data contracts pass;
- labels, errors, focus, keyboard, Escape/focus-return and responsive reachability pass;
- semantic Quincy tokens are used;
- stock shadcn appearance has been customized;
- raw framework palette values are absent from the feature-level contract;
- the reference/current/migrated comparison is reviewed;
- every material difference has a drift-register disposition;
- obsolete selectors are removed only when their final consumer is gone;
- targeted tests and the full repository gate pass.

Visual similarity does not excuse accessibility regression. Accessibility improvement does not excuse unrelated visual drift.

## 8. Tailwind/shadcn guardrails

- Tailwind utilities express Quincy semantics; they do not define a new palette or aesthetic.
- shadcn source becomes Quincy-owned code and is reviewed accordingly.
- Square cards, restrained control radius, hairline structure and low elevation remain defaults.
- Quincy fonts and editorial type hierarchy remain intentional.
- Preflight stays controlled by the approved migration policy.
- Focus remains visibly on-brand.
- Keep focused CSS for media geometry, annotations, complex stacking, Tiptap internals and other cases where it is clearer.
- One element has one styling owner during migration.

## 9. Prototype boundaries

Preserve from the prototype where still applicable:

- visual hierarchy;
- density and whitespace;
- card/list/board composition;
- typography and metadata treatment;
- restrained motion and interaction tone;
- responsive intent.

Do not restore prototype-only mock behavior that conflicts with approved production requirements, real authentication, live data, capability enforcement or verified accessibility improvements.

## 10. Lifecycle

- TB0 establishes the register and owner approvals.
- TB1 proves the first component/tooling path.
- Every intervening UI-bearing tracer bullet updates its affected surface entries.
- TB8 is a sequence of feature-surface convergence releases, not a final big-bang rewrite.
- Completion requires every in-scope entry to be corrected, intentionally retained or explicitly deferred.
