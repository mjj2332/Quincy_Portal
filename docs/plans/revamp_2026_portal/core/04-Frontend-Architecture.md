# Frontend Architecture

**Status:** Settled proposal; authority promotion and implementation pending  
**Related:** [Design convergence](./11-Design-Convergence.md), [Calendar/scheduling](./12-Production-Calendar-And-Checklist-Scheduling.md), [TB0A](../roadmap/TB0A-React-19-2-Runtime-Upgrade.md), [TB1](../roadmap/TB1-Tailwind-Shadcn-Foundation.md), [TB5C](../roadmap/TB5C-Production-Calendar.md)

## 1. Architecture objective

Upgrade the existing Quincy Vite SPA to React 19.2, then use Tailwind CSS v4 and source-owned shadcn components to converge ordinary UI toward the Quincy design system without rewriting the application or replacing specialized working surfaces.

```text
React 19.2 + Vite SPA
  ├── feature/domain components
  ├── components/quincy/        recurring branded composites
  ├── components/ui/            generic source-owned shadcn primitives
  ├── feature-local controls    workflow and access behavior
  ├── specialized engines       e.g. FullCalendar in TB5C
  └── focused CSS               media, Tiptap, stacking, calendar geometry overrides
```

## 2. React 19.2 baseline

TB0A is an isolated compatibility release before Tailwind/shadcn work. Recheck npm at implementation time; pin React/React DOM to the same latest stable `19.2.x` patch and compatible exact `@types` versions. Keep `createRoot`, StrictMode, modern JSX, TypeScript, Vite, typed custom router, client SPA, and app Worker asset serving.

Do not add React Compiler, Server Components, SSR/hydration, `Activity`, Actions/form refactors, or broad product redesign in TB0A. Use official codemods as reviewed proposals, then inspect removed APIs, refs, test assumptions, and StrictMode cleanup directly.

## 3. Design authority

Use this order:

1. approved repository authority for product/security/workflow;
2. Quincy design-system tokens/guidance;
3. prototype for comparable layout/flow intent;
4. current production for verified behavior/accessibility/platform constraints;
5. Tailwind/shadcn/specialized libraries only as implementation technique.

Stock generated appearance or a dependency demo is never final visual authority.

## 4. Tailwind v4 integration

TB1 uses pinned Tailwind v4 with `@tailwindcss/vite`, CSS-first configuration, one CSS entry, automatic source detection, and Preflight disabled initially. Retain the existing Quincy reset/base and semantic-token mapping. Accept the official Tailwind v4 browser floor already recorded in the package.

## 5. shadcn initialization contract

Use one app-local Base UI/Sera setup:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-sera",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "utils": "@/lib/utils",
    "hooks": "@/hooks"
  }
}
```

- Add `@/* → src/*` consistently in TypeScript and Vite.
- Do not rewrite working relative imports merely to use the alias.
- Base UI is the ordinary primitive base; React Aria/Radix require a measured blocker.
- Generated source is first-party reviewed Quincy code.
- Add only components needed by the active bullet.
- Dark mode remains excluded.

### Registry policy

The TB1 baseline has no third-party registries. **TB5C is one explicitly reviewed exception:** FullCalendar's official shadcn registry may be added for the specialized Production Calendar after the Quincy shadcn foundation exists.

That exception does not authorize arbitrary registries or a second ordinary primitive system. Inspect the generated registry source/dependencies before adoption; if it pulls incompatible ordinary primitives, replace/wrap those portions rather than changing Quincy's Base UI contract.

## 6. Token bridge and component ownership

Existing Quincy values remain the source for semantic variables (`--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--muted`, `--border`, `--ring`, signals, radius). Feature code uses semantic utilities rather than raw palettes/brand hexes.

```text
portal/apps/web/src/components/ui/       generic generated primitives
portal/apps/web/src/components/quincy/   reusable branded composites
feature-local components                 domain/capability/workflow behavior
```

Generic primitives contain no API calls/capabilities. One rendered element has one styling owner. Keep focused CSS where clearer for media geometry, Tiptap, complex stacking, keyframes, and specialized calendar internals.

## 7. Specialized Production Calendar engine

TB5C may use the latest stable reviewed **FullCalendar Standard** React integration through FullCalendar's official shadcn registry.

Boundary:

- FullCalendar owns Month/TimeGrid/List geometry and event interaction mechanics;
- Quincy owns Dashboard view integration, toolbar, filters, Unscheduled panel, event content, role/permission treatment, confirmations, schedule editor, responsive behavior, a11y adjuncts, and semantic styling;
- use Standard DayGrid/TimeGrid/List/Interaction capabilities only;
- no premium Scheduler/resource timeline;
- no unrelated community shadcn calendar implementation;
- named `Australia/Sydney` timezone is explicit;
- current stable package/flavor is rechecked at TB5C plan/implementation time;
- compare official FullCalendar shadcn flavors at approved evidence viewports and pin the least-drift choice; users do not choose a FullCalendar theme.

The Calendar engine is not Quincy's ordinary component library and does not replace Base UI/shadcn ownership elsewhere.

## 8. Server state and routing

TanStack Query enters incrementally in TB2. Ordinary ephemeral state remains local React state: drafts, open controls, filters, Lightbox position, selection, active drag/resize.

Server resources use route/range/filter keys. Calendar query state additionally belongs in typed URL parameters. Keep the custom router.

## 9. UI proofs

TB1 still migrates only the ProjectFields Client section and proves the general UI platform.

TB5C separately proves the specialized engine can conform to Quincy:

- Month/Week/Agenda at desktop/compact/phone;
- empty/populated/dense/overdue/completed/read-only/editable/conflict states;
- External Editor assigned-scope state;
- Unscheduled panel and drag/resize plus keyboard Move/Reschedule;
- focus/announcement/error rollback;
- no stock FullCalendar/shadcn visual drift;
- bundle/CSS/dependency delta and registry-source review.
