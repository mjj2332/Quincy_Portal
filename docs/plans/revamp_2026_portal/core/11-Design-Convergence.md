# Design Convergence Contract

**Status:** Approved planning direction; TB0 creates the first durable drift register  
**Applies to:** every rendered UI change

## 1. Outcome

The revamp uses React 19.2, Tailwind CSS v4, and source-owned shadcn components to implement Quincy—not to replace Quincy's visual identity with a framework aesthetic.

A migrated surface succeeds when behavior/security/accessibility are correct and its typography, spacing, geometry, hierarchy, borders, radius, elevation, motion, imagery, and responsive behavior read unmistakably as Quincy.

## 2. Sources of truth

| Question | Authority |
|---|---|
| Product behavior/security/workflow | approved repository authority and active implementation plan |
| Visual values/language | Quincy design-system tokens/guidance |
| Comparable layout/flow | original `prototype/` screens |
| Production constraints/fixes | current `portal/`, `docs/todo.md`, `docs/lessons.md` |
| Technique | approved frontend architecture/active bullet |

Prototype is never an application template. Current production is evidence, not automatic visual authority. Sera/shadcn is scaffolding, not a target look.

## 3. Fixed evidence matrix

TB0 captures equivalent-content/role evidence at:

- desktop: **1440 × 900**;
- compact landscape: **1024 × 768**;
- phone: **390 × 844**;
- Collaboration overlay open where relevant.

Capture representative material states where they change design:

- empty/populated;
- loading/error;
- focus/keyboard;
- popover/dialog/sheet open;
- permission/read-only/collaboration-only;
- overdue/conflict/pending where applicable.

Zoom/reflow testing is separate from screenshot dimensions.

TB0A captures focused React 18/19 before-after evidence for high-risk representative surfaces. React 19 parity becomes the TB1 baseline; do not silently replace evidence when a runtime difference appears.

## 4. Classification

| Disposition | Meaning | Action |
|---|---|---|
| Conforming | matches reference intent | preserve/test |
| Intentional evolution | owner-approved product improvement | record rationale/preserve |
| Required platform/accessibility change | objective semantic, focus, responsive, security, or live-data need | record evidence/preserve |
| Unwanted drift | no approved reason | correct in isolated slice |
| Unassessed | evidence/decision missing | assign owner; cannot silently pass |

“Production has more features” does not classify their design treatment.

## 5. Drift register fields

- surface/component/state;
- exact viewport;
- role/content fixture;
- reference evidence;
- current evidence;
- specific difference;
- disposition;
- rationale/decision owner;
- target bullet/plan;
- status;
- post-change verification.

Keep evidence modular by surface.

## 6. Decision ownership

- Planner/implementer gathers evidence and recommends classification.
- Reviewer verifies evidence and implementation.
- Product owner approves intentional evolution and explicit deferral.
- Objective accessibility/security/platform requirements may be classified from evidence but remain recorded.
- Unassessed material differences block acceptance or receive an explicit owner/follow-up.

## 7. Initial inventory

- sign-in/application shell;
- Dashboard List/Kanban/cards;
- Project Workspace rail, collection controls, responsive overview;
- Review Lightbox/markup;
- create/edit/admin forms;
- Collaboration/checklist/comments;
- notice board;
- notification bell/preferences/Admin delivery operations;
- quick-detail sheet when introduced;
- phone-width critical workflows.

## 8. Per-surface definition of done

- product/security/data contract passes;
- labels/errors/focus/Escape/focus return/keyboard/phone reachability pass;
- semantic Quincy tokens used;
- stock shadcn/Sera appearance replaced where needed;
- no raw framework palette as feature contract;
- current/reference/migrated evidence reviewed;
- every material difference classified;
- one styling owner per element;
- obsolete selectors removed only after final consumer;
- targeted and full gates pass.

Visual similarity never excuses accessibility regression; accessibility work never excuses unrelated drift.

## 9. Tailwind/shadcn guardrails

- Preflight disabled initially.
- Base UI/Sera/Lucide are implementation choices, not visual authority.
- Square cards, restrained control radius, hairlines, low elevation, calm motion, and editorial hierarchy remain defaults.
- Keep Quincy fonts and semantic signals.
- Keep focused CSS for specialized media, annotation, Tiptap, stacking, and complex motion when clearer.
- Add only active-bullet components.
- Generated source is reviewed first-party code.

## 10. TB8

TB8 order is evidence-driven, not precommitted file order. Rank remaining surfaces by:

- operational pain;
- unwanted-drift severity;
- reuse value;
- accessibility risk;
- ability to retire a legacy owner.

Common shell/repeated ordinary controls generally precede specialized media surfaces. Each surface has its own plan/release. Program completion requires every in-scope entry corrected, intentionally retained, or explicitly deferred.
