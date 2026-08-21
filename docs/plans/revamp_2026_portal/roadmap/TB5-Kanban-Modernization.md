# TB5 — Kanban Ordering Correction and Interaction Modernization

**Status:** Split into two independently reviewed tracer bullets. This file is an index, not an implementation slice.

Read and execute in order:

1. [TB5A — Kanban Ordering-Model Correction](./TB5A-Kanban-Ordering-Model-Correction.md)
2. [TB5B — Kanban Interaction Modernization](./TB5B-Kanban-Interaction-Modernization.md)

The split is mandatory because the current board's visible grouping, persisted `boardPosition`, priority mutation and shoot-date overrides do not form one coherent contract. Replacing native drag with dnd-kit before correcting that model would preserve the wrong behavior behind a better interaction engine.

Historical implemented Kanban plans remain unchanged as records of what shipped.
