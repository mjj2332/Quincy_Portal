# TB1 — Tailwind v4 + shadcn Foundation

**Primary user outcome:** one bounded existing form section uses the new Quincy UI layer with equivalent or improved accessibility and demonstrable design-system/prototype alignment.

## Recommended consumer

ProjectFields Client section:

- agency;
- agent;
- agent email;
- agent phone.

## Scope

- Tailwind v4 Vite integration.
- Intentional Preflight policy.
- Quincy token/semantic-variable bridge.
- `components.json` and aliases.
- one `cn()` helper.
- only required shadcn field/button primitives.
- matched current/prototype/design-system reference evidence for the bounded section or its closest comparable controls.
- migrate the bounded section.
- classify every material visual/interaction deviation.
- delete only obsolete selectors with no remaining consumer.

## Non-goals

- whole form migration;
- global CSS rewrite;
- React upgrade;
- server-state library;
- discussion/Kanban changes;
- dark mode;
- changing the product workflow to imitate mock prototype behavior.

## Tests/QA

- label/control association;
- error description and `aria-invalid`;
- native type/props/ref behavior;
- create/edit validation parity;
- desktop, collaboration-panel and narrow-width visual comparison where applicable;
- Quincy typography, spacing, border, radius, elevation, focus and motion checks;
- no raw Tailwind palette as feature-level brand contract;
- no stock shadcn appearance;
- intentional deviations recorded in the drift register;
- no unrelated Preflight regression;
- bundle/CSS delta.

## Checkpoint

Accept, simplify or reject the generated primitive API and its design fidelity before adding more components. A technically working but visually generic shadcn result fails this checkpoint.
