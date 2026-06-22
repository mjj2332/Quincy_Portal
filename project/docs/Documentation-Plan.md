---
Status: Awaiting approval
Owner: ___
Last updated: 2026-06-23
Approved on: ___
---

# Quincy Portal — Documentation Plan

> **Blueprint only:** Do not scaffold the docs below yet. This plan defines the lean docs-as-code set to create later, after the core build structure exists.
> **Bias:** Keep documentation small, owned, and generated where possible. A 1-3 person studio build should not carry enterprise process weight.

## Source-of-truth map

| Area | Source of truth | Notes |
|---|---|---|
| Product requirements | `project/docs/PRD.md` | Product SSOT: goals, non-goals, personas summary, pipeline, feature scope, open product questions. |
| UI / visual + interaction design | HTML/CSS prototype: `project/index.html`, `project/app/*.jsx`, `project/_ds` | Visual and interaction SSOT until the prototype is promoted into real components. Match output and behavior, not prototype internals. |
| Technical architecture | `project/docs/Implementation-Proposal.md`, later absorbed into `project/docs/Architecture.md` | Technical SSOT: Cloudflare topology, phases, auth, storage/media, integration strategy, risks. |
| Data model | Drizzle schema in code | Data SSOT: tables, enums, relations, indexes, migrations. Docs should summarize or generate from it, not manually restate every column. |
| Internal API contract | Hono RPC types in code | API SSOT for staff app/client integration. Avoid a hand-written internal REST spec that drifts. |
| External integration contracts | Webhook handlers, samples, and `project/docs/Webhooks.md` once scaffolded | Webhook docs should explain verification, idempotency, event mapping, and replay, using fixtures from code/tests. |

## Lean docs set to scaffold later

| Doc | Path | Purpose | Owner | When to scaffold | Section-by-section outline | Anti-drift / generation mechanism | Heavier artifact it absorbs |
|---|---|---|---|---|---|---|---|
| README | `project/docs/README.md` | Human entry point for the docs set and current build status. | Product/tech lead | Pre-coding. | 1. What Quincy Portal is. 2. Current phase. 3. Where to find product, architecture, data, webhook, and launch docs. 4. Local dev links/commands once stable. 5. Decision status. | Keep as a short index; update only when doc paths or phase changes. Link to SSOTs instead of duplicating detail. | Project wiki home, onboarding memo, status deck. |
| Glossary | `project/docs/Glossary.md` | Shared language for "RAW", Edited, publish, client link, premium, Tonomo, autoHDR, etc. May instead live as a README section if fewer files are preferred. | Product owner | Pre-coding. | 1. Media/pipeline terms. 2. Roles/capabilities. 3. Integrations. 4. Delivery/paywall terms. 5. Deprecated/confusing terms. | Alphabetical, PR-reviewed edits only; link terms from PRD/Architecture instead of redefining inline. | Domain dictionary, onboarding explainer, terminology section in every doc. |
| DECISIONS | `project/docs/DECISIONS.md` | Approved product and architecture decisions, concise and dated. | Product/tech lead | Pre-coding. | 1. Decision log format. 2. Active decisions. 3. Superseded decisions. 4. Open decisions link back to `Decision-Sheet.md` until approved. | Add one row per approved decision with date/owner; PR check can require an entry when schema/auth/flow changes. | Full ADR process, RFC archive, meeting notes folder. |
| Architecture | `project/docs/Architecture.md` | Lean technical SSOT after implementation starts. | Tech lead | Pre-coding. | 1. System context. 2. Four Worker topology. 3. Auth and access model. 4. Storage/media pipeline. 5. Async jobs/workflows. 6. Phase plan. 7. Risks/limits. 8. Operational notes. | Absorb `Implementation-Proposal.md` once approved; diagrams generated from Mermaid blocks in the doc where possible. Cross-link code modules instead of restating internals. | Long implementation proposal, architecture deck, informal infra notes. |
| Webhooks | `project/docs/Webhooks.md` | External integration guide for Tonomo and Dropbox webhooks. | Tech lead | Phase-triggered: scaffold when Tonomo/Dropbox integration starts, around Phase 2. | 1. Public ingress surface. 2. Security/signature verification. 3. Idempotency/replay window. 4. Tonomo `order.created` / `order.updated` mapping. 5. Dropbox cursor/delta handling. 6. Poison-event/operator recovery. 7. Local test fixtures. | Generate event field examples from checked-in fixtures/tests where practical; keep endpoint names synced with route constants. | Separate integration specs, webhook runbook, mapping spreadsheet. |
| Launch Security Checklist | `project/docs/Launch-Security-Checklist.md` | Gate checklist for internal launch and client-facing launch. | Tech lead | Phase-triggered: scaffold when Phase 0 infrastructure exists. | 1. Internal launch gates. 2. Client delivery gates. 3. Auth/JWT checks. 4. Client link hardening. 5. Paywall enforcement. 6. Backup/restore. 7. Observability/audit. 8. Sign-off table. | Treat as a release checklist in PRs; items link to tests, code, or Cloudflare settings. Keep binary and auditable. | Security review doc, launch checklist deck, compliance-lite checklist. |
| Drizzle schema + generated ERD | `project/docs/Data-Model.md` and generated `project/docs/generated/schema-erd.svg` | Explain the data model without duplicating the schema. | Tech lead | Pre-coding. | 1. How to read the schema. 2. Key entities. 3. Relationship diagram. 4. Important enums/states. 5. Migration rules. 6. Generated artifacts. | Generate ERD from Drizzle schema/migrations in CI or a documented script; doc links to source schema and migration files. | Manual database spec, spreadsheet ERD, column-by-column appendix. |

## Explicitly defer to Phase 1+

- Full OpenAPI spec: defer unless an external consumer needs it. Hono RPC types are the internal contract.
- `CONTRIBUTING.md`: defer until there is more than one regular implementer or external contribution.
- RFC process: defer; use `DECISIONS.md` rows for now.
- Accessibility audit/documentation: defer formal docs, but keep accessible implementation expectations in code review.
- Full traceability matrix: defer; PRD sections plus tests are enough for MVP.
- Full operational runbook: defer until staging/prod systems exist; launch checklist covers immediate gates.

## Doc hygiene rules

- Every doc has `Status`, `Owner`, `Last updated`, and `Approved on` once scaffolded.
- Status flow is `Draft` -> `Approved`; outdated docs become `Superseded` with a replacement link.
- Docs are docs-as-code: every change goes through PR review with the code it affects.
- Do not copy schema columns, route shapes, or generated types by hand when code can generate or link them.
- Prefer one concise SSOT plus links over repeated explanations in multiple files.
- `.DS_Store` is already gitignored; do not add housekeeping churn to docs PRs.
- If a doc is not read during planning, implementation, launch, or support, do not create it.

## Scaffolding checklist

1. Approve `Decision-Sheet.md`; move approved outcomes into the PRD, Architecture, or `DECISIONS.md` as appropriate.
2. Create only the seven lean docs listed above, with front matter/status fields and short outlines first.
3. Promote `Implementation-Proposal.md` into `Architecture.md`, trimming review history and preserving decisions, phase plan, and Cloudflare limits.
4. Add `DECISIONS.md` rows for approved schema/auth/flow decisions before coding those areas.
5. Add a generated ERD script only after the Drizzle schema exists; commit generated output only if it is stable and useful in review.
6. Add webhook fixtures/tests first, then generate or copy minimal examples into `Webhooks.md`.
7. Create the launch checklist when Phase 0 infrastructure exists, then split internal-launch and client-launch gates.
8. Review the docs set at the end of each phase and delete or merge anything that has become redundant.

Avoid over-documentation: the goal is a small set of living docs that prevents drift, not a parallel paperwork system.
