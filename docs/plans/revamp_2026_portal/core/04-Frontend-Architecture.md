# Frontend Architecture

**Status:** Settled proposal; authority promotion and implementation pending  
**Related:** [Design convergence](./11-Design-Convergence.md), [TB0A](../roadmap/TB0A-React-19-2-Runtime-Upgrade.md), [TB1](../roadmap/TB1-Tailwind-Shadcn-Foundation.md)

## 1. Architecture objective

Upgrade the existing Quincy Vite SPA to React 19.2, then use Tailwind CSS v4 and source-owned shadcn components to converge ordinary UI toward the Quincy design system without rewriting the application or replacing specialized working surfaces.

```text
React 19.2 + Vite SPA
  ├── feature/domain components
  ├── components/quincy/        recurring branded composites
  ├── components/ui/            generic source-owned shadcn primitives
  ├── feature-local controls    workflow and access behavior
  └── focused CSS               media, Tiptap, stacking and specialized geometry
```

## 2. React 19.2 baseline

TB0A is an isolated compatibility release before Tailwind/shadcn work.

### Version policy

- Recheck npm at implementation time and select the latest stable React `19.2.x` patch.
- Pin React and React DOM to the same exact patch.
- Pin the latest compatible exact `@types/react@19.2.x` and `@types/react-dom@19.2.x`.
- As of 2026-08-22, the current stable React package is `19.2.8`.
- Commit and review the lockfile.
- No canary, RC, caret, or unbounded `latest` range remains in `package.json`.

### Scope

Preserve:

- `createRoot`;
- `<StrictMode>`;
- `react-jsx` transform;
- TypeScript and Vite;
- the custom typed router;
- client-rendered SPA and app Worker asset serving.

Do not add in TB0A:

- React Compiler;
- Server Components, SSR, hydration, or Partial Pre-rendering;
- `Activity`, Actions/new form architecture, `useEffectEvent` refactors, ref-as-prop sweeps, or unrelated component rewrites;
- a monitoring vendor or duplicate console wrapper.

### Migration method

- Run the official React 19 migration recipe and TypeScript codemods on a clean branch.
- Treat output as a proposed diff and review every change.
- Search explicitly for removed APIs, legacy test utilities, React internals, no-argument `useRef`, implicit ref callback returns, and render-error assumptions.
- Retain React 19 default error reporting unless Quincy has a real reporting sink and a separate observability plan.
- Keep supporting dependency updates to the minimum proven compatible set.

### Compatibility focus

Prioritize local QA and focused tests around:

- Floating UI/portals and focus return;
- Tiptap and mention autocomplete;
- Lightbox and image loading;
- collaboration/checklist refs, timers, and subscriptions;
- dnd-kit sensors and sortable refs;
- mount/unmount cleanup in DOM tests.

## 3. Design authority

Use this order:

1. approved repository authority documents for product/security/workflow;
2. Quincy design-system tokens and guidance for visual language;
3. prototype screens for comparable layout/flow intent;
4. current production for verified behavior, accessibility, and platform constraints;
5. Tailwind/shadcn only as implementation technique.

Current production is evidence, not automatic visual authority. Stock generated appearance is not acceptable final output.

## 4. Tailwind v4 integration

TB1 uses:

- pinned `tailwindcss` and `@tailwindcss/vite` at `portal/` root;
- Vite plugin integration;
- CSS-first v4 configuration;
- one existing global CSS entry: `src/styles/index.css`;
- automatic source detection, with explicit `@source` only if verified necessary;
- no v3 `tailwind.config.js` unless a measured blocker requires it.

### Preflight

Disable Preflight initially. Import theme and utilities without `preflight.css`, retain the existing Quincy base/reset layer, and avoid unrelated whole-app heading/list/border/media regressions. A later enablement requires a dedicated application-wide diff and visual/accessibility gate.

### Browser floor

Accept the official Tailwind v4 minimums:

- Chrome/Chromium 111+;
- Safari 16.4+;
- Firefox 128+.

Regular QA focuses on deployed Chrome/Safari plus Firefox regression coverage. No older-browser support is promised.

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
- Do not rewrite existing relative imports merely to use the alias.
- No third-party registries initially.
- Base UI is the selected primitive base. React Aria and Radix remain alternatives only after a measured blocker.
- Sera is a code scaffold, not visual authority; replace stock treatments that conflict with Quincy.

## 6. Token bridge

Existing Quincy values remain the source. Map them to semantic variables such as:

```text
--background           --foreground
--card                 --card-foreground
--popover              --popover-foreground
--primary              --primary-foreground
--secondary            --secondary-foreground
--muted                --muted-foreground
--accent               --accent-foreground
--destructive          --border
--input                --ring
--positive             --caution
--information          --radius
```

Tailwind feature code uses semantic utilities (`bg-background`, `border-border`, `ring-ring`) rather than raw palette names or repeated brand hex values. Dark mode is excluded.

## 7. Component ownership

```text
portal/apps/web/src/components/ui/       generic generated primitives
portal/apps/web/src/components/quincy/   reusable branded composites
feature-local components                 domain data, capability and workflow behavior
```

Rules:

- Generated source is first-party Quincy code and receives ordinary review.
- Add only components required by the active tracer bullet.
- Never bulk-add all components.
- Generic primitives contain no API calls, capabilities, or authorization.
- A Quincy composite needs one strong reusable contract or multiple real consumers.
- No shared UI workspace without a second real app consumer.
- One rendered element has one styling owner during migration.
- Keep focused CSS where clearer for media geometry, annotation layers, Tiptap internals, complex stacking, keyframes, and specialized grids.

## 8. Icon policy

Use Lucide for newly migrated ordinary controls. Define Quincy-consistent size, stroke, alignment, accessible names, and icon-button treatment. Existing glyphs/custom SVGs migrate only with their owning surface; no collateral whole-app replacement.

## 9. Server state and routing

TanStack Query enters incrementally in TB2. Ordinary ephemeral UI state stays in React state:

- drafts;
- open popover/dialog;
- filter input;
- Lightbox position;
- active drag.

Server data uses route/resource keys. Keep the custom typed router; query lifecycle, not pathname routing, is the demonstrated freshness defect.

## 10. First UI proof

TB1 migrates only the ProjectFields Client section—Agency, Agent, Agent email, Agent phone—across Create/Edit modes without changing product behavior.

It must prove:

- React 19.2 compatibility baseline remains green;
- Tailwind build/source detection;
- controlled Preflight;
- token and typography fidelity;
- generated-source maintainability;
- label/error/focus behavior;
- desktop/compact/phone evidence;
- legacy coexistence and one styling owner;
- no stock shadcn appearance or raw palette contract;
- bundle/CSS delta.
