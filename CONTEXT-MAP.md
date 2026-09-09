# Context Map

## Contexts

- [Quincy production domain](./portal/packages/shared/CONTEXT.md): the projects, stages,
  people and ratings the pipeline is built around.

## Relationships

The domain vocabulary is defined once, in `packages/shared`, and consumed unchanged by
`packages/db` (persistence), `workers/*` (the API and background work) and `apps/web`
(the staff UI). None of those holds a competing definition; a term that needs changing
is changed in `packages/shared` first.

## Growing this map

One context today. Split it only when a package earns vocabulary that genuinely
contradicts the shared set — not merely because it has its own types.
