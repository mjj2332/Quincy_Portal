# TB1 — Tailwind v4 + shadcn Foundation

**Primary user outcome:** one bounded existing form section uses the Quincy UI layer with equal/improved accessibility and demonstrable design convergence.

**Preconditions:** TB0A and TB0B live/accepted.

## First consumer

ProjectFields Client section across Create/Edit modes:

- Agency;
- Agent;
- Agent email;
- Agent phone.

No product behavior change.

## Scope

- Tailwind v4 Vite plugin and CSS-first setup.
- Import theme/utilities without Preflight.
- Semantic Quincy token bridge.
- `components.json`: Base UI, `base-sera`, neutral scaffold, CSS variables, Lucide, `rsc:false`, `tsx:true`, no prefix/third-party registries.
- `@/* → src/*` aliases in TypeScript/Vite; do not rewrite unrelated imports.
- App-local `components/ui`, `components/quincy`, `lib/utils`.
- Only required field/button primitives.
- Matched current/prototype/design-system evidence and drift classifications.
- Delete only selectors with no remaining consumer.

## Non-goals

- whole-form/app migration;
- Preflight enablement;
- React/runtime work;
- query/discussion/coordination/Kanban changes;
- dark mode;
- shared UI workspace;
- bulk component install.

## Acceptance

- React 19.2 baseline remains green;
- label/error/ref/native prop behavior;
- desktop/compact/phone comparison;
- Quincy typography/spacing/geometry/focus/motion;
- no stock Sera/shadcn appearance or raw palette contract;
- one styling owner and legacy coexistence;
- bundle/CSS delta;
- targeted/full gates and manual QA.
