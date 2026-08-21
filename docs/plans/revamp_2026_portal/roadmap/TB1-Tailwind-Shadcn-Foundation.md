# TB1 — Tailwind v4 + shadcn Foundation

**Primary user outcome:** one bounded existing form section uses the new Quincy UI layer with equivalent or improved accessibility.

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
- migrate the bounded section.
- delete only obsolete selectors with no remaining consumer.

## Non-goals

- whole form migration;
- global CSS rewrite;
- React upgrade;
- server-state library;
- discussion/Kanban changes;
- dark mode.

## Tests/QA

- label/control association;
- error description and `aria-invalid`;
- native type/props/ref behavior;
- create/edit validation parity;
- desktop/narrow visual comparison;
- no unrelated Preflight regression;
- bundle/CSS delta.

## Checkpoint

Accept, simplify or reject the generated primitive API before adding more components.
