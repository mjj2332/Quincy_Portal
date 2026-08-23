# Design Convergence Contract

**Status:** Approved planning direction; TB0 creates the first durable drift register  
**Applies to:** every rendered UI change

## 1. Outcome and authority

The revamp uses React 19.2, Tailwind v4 and source-owned shadcn to implement Quincy—not a framework aesthetic. Product/security/workflow comes from repository authority; visual language from Quincy tokens/guidance; prototype is comparable-flow reference; current production supplies proven constraints; libraries are technique only.

## 2. Fixed evidence matrix

Capture equivalent-content/role evidence at:

- 1440 × 900 desktop;
- 1024 × 768 compact;
- 390 × 844 phone;
- relevant overlay/open states.

Material states include empty/populated/loading/error/focus/open/read-only/permission/overdue/conflict/pending. TB5C additionally captures Month/Week/Agenda, dense/multi-day, Unscheduled, overlap, drag/resize, keyboard Reschedule, and External Editor assigned-scope states.

## 3. Classification

Every material difference is Conforming, Intentional evolution, Required platform/accessibility/security change, Unwanted drift, or Unassessed. Product owner approves intentional evolution/deferral; objective accessibility/security/platform changes remain evidenced. Unassessed material differences block acceptance or receive explicit follow-up.

## 4. Initial inventory

- sign-in/application shell;
- Dashboard List/Kanban/**Calendar**;
- Project Workspace rail/collections/responsive overview;
- Review Lightbox/markup;
- create/edit/admin forms including External Editor identity/eligibility;
- Collaboration/checklist/comments and schedule editor;
- Notice Board;
- notification bell/preferences/Admin delivery operations;
- quick-detail sheet when introduced;
- phone critical workflows.

## 5. Tailwind/shadcn guardrails

- Preflight disabled initially.
- Base UI/Sera/Lucide are implementation choices, not visual authority.
- Keep Quincy fonts/signals/geometry/hairlines/low elevation/calm motion.
- Add only active-bullet components.
- Generated source is reviewed first-party code.
- One styling owner per element.

### FullCalendar exception

TB5C may add FullCalendar's **official** shadcn registry as one specialized reviewed exception after the Base UI/Sera platform exists.

- Inspect generated source/dependencies.
- Do not use the exception to introduce a second general primitive base.
- FullCalendar owns calendar geometry/interaction mechanics, not Quincy visual language.
- Compare the official shadcn flavors at the evidence viewports and pin the least-drift choice.
- Quincy may replace demo toolbar/filter/event composition completely.
- No user-facing calendar theme selector.

## 6. Per-surface definition of done

- product/security/data contract passes;
- labels/errors/focus/Escape/focus return/keyboard/phone reachability pass;
- semantic Quincy tokens used;
- stock shadcn/Sera/FullCalendar appearance replaced where needed;
- no raw palette as feature contract;
- current/reference/migrated evidence reviewed;
- every material difference classified;
- obsolete owners removed only after final consumer;
- targeted and full gates pass.

Visual similarity never excuses accessibility/security regression; accessibility/security work never excuses unrelated visual drift.

## 7. TB8

TB8 order remains evidence-driven by operational pain, drift severity, reuse value, accessibility risk and ability to retire a legacy owner. Calendar is its own TB5C proof and is not deferred to TB8 simply because it uses a specialized engine.
