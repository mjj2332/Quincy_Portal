# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** at the repo root: system-wide decisions. Also check `<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist yet, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

This repo's contexts are the npm workspace packages under `portal/`, not a `src/` tree:

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── portal/
    ├── apps/web/
    │   ├── GLOSSARY.md
    │   └── docs/adr/
    ├── packages/shared/
    │   ├── GLOSSARY.md
    │   └── docs/adr/
    ├── packages/db/
    │   ├── GLOSSARY.md
    │   └── docs/adr/
    ├── workers/app/
    │   ├── GLOSSARY.md
    │   └── docs/adr/
    ├── workers/background/
    │   ├── GLOSSARY.md
    │   └── docs/adr/
    └── workers/webhook-ingress/
        ├── GLOSSARY.md
        └── docs/adr/
```

`docs/archive/` is historical and explicitly not authoritative (see root `AGENTS.md`), so it is not a context — don't create a `GLOSSARY.md` there and don't mine it for domain vocabulary.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant package's `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
