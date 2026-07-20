# Quincy Portal pre-implementation consistency audit

Severity: P0 = blocks Phase 0/schema/auth start; P1 = blocks the named delivery phase; P2 = documentation/prototype-polish risk.

The approved [Decision Sheet] is the controlling authority. The PRD, Personas, Sitemap, and Implementation Proposal remain materially stale in several places.

## Findings

1. **[P0] Authority order is not documented in the implementation baseline.**  
   `Implementation-Proposal.md` calls the PRD/Personas/Sitemap its “Source of truth” (§header), but predates the 2026-07-19 approvals. The PRD and supporting documents still identify themselves as June drafts and retain resolved “NEEDS INPUT” decisions. Engineers following the proposal as written would implement superseded choices.  
   Cite: Decision Sheet header; Proposal header; PRD header; Personas/Sitemap headers.

2. **[P0] The proposal’s staff-auth architecture is invalid under D-14.**  
   Every Cloudflare Access dependency must be replaced by the approved custom staff authentication: Google Account Login plus magic-link email.

   Affected proposal locations:

   - §1 stack table: “Staff auth = Cloudflare Access,” “Sessions/flags = none needed for staff.”
   - §3: recommends Cloudflare Access and says it avoids owning auth code.
   - §4 architecture diagram: staff → “Cloudflare Access (SSO/MFA)” → App/API Worker.
   - §5 `users`: identity is sourced from an Access JWT.
   - §6.2: staff App/API Worker is “behind Cloudflare Access.”
   - §6.3: the entire staff-auth implementation is Access JWT validation.
   - §6.4: Phases 1–4 endpoints are “staff-Access-only.”
   - §8 risk table: “Access misrouting” mitigation is Access exclusions/JWT validation.
   - §9: every internal phase is described as being behind Access; Phase 0 explicitly creates an Access-protected worker.
   - §12 recommendation: explicitly recommends Cloudflare Access.
   - §13 review-log items 5 and 33 preserve Access as the solution.

   The public-worker separation, signed client links, and webhook signature checks remain relevant; only the Access-specific assumptions must be removed.

3. **[P0] Custom-auth work is entirely absent from the data model, phase plan, launch gates, risks, and tests.**  
   D-14 adds work the proposal explicitly says does not exist:

   - Google OAuth authorization/callback flow, state/nonce/PKCE handling, and verified identity claims.
   - Magic-link request, delivery, consume, expiry, one-time use, resend/rate limiting, and anti-enumeration behavior.
   - Staff browser sessions: secure cookie rules, session persistence, logout, revocation, expiry, and deactivation enforcement.
   - Auth-identity and session/magic-link persistence; `users(email, name, role, active)` alone is insufficient.
   - A defined account-provisioning rule: who may sign in, whether users are admin-created/invited/allow-listed, and what happens when an Admin deactivates them.
   - Capability assignment storage or a documented static role-to-capability policy. The proposal claims capability-based access (§6.3), but its §5 model contains only `users.role`.
   - Auth-specific integration tests, email-delivery/error-path tests, session-security testing, and corresponding launch gates.
   - New risks: OAuth callback misconfiguration, magic-link abuse/delivery failure, session fixation/theft, and disabled-user session revocation.

   Cite: Decision D-14; PRD §6.9 Users; Proposal §§1, 5, 6.3, 7–9.

4. **[P0] The sitemap’s generic “Sign in” route does not specify the two approved staff entry paths.**  
   It needs a Google sign-in path, magic-link request/consume states, expired/invalid-link states, sign-out/session-expired behavior, and Admin-facing user activation/provisioning behavior. It currently only says “Sign in” and “when not authed.”  
   Cite: Decision D-14; Sitemap Top-level structure and Screen-by-screen routing notes.

5. **[P0] Pipeline configuration is incompatible with the current hardcoded stage model.**  
   PRD §6.9 requires Admins to rename and reorder pipeline stages. PRD §7 defines a fixed six-stage enum, while Proposal §5 stores only `projects.stage (PRD §7)`. The proposal has no configurable-stage persistence, no stable stage identity, no migration/ordering semantics, and no rule for what happens to existing projects when a label/order changes. This must be resolved before schema and pipeline-transition code start.  
   Cite: PRD §§6.1, 6.9, 7; Proposal §5; Decision D-03.

6. **[P0] “Client review” remains a hardcoded stage despite D-03 dropping client/guest review from MVP.**  
   PRD §7 still has stage 5 “Client review,” and §8 still asks whether client approval should exist. The proposal describes five pipeline stages (§2), but its `projects.stage` defers to PRD §7 (§5), producing an unresolved six-versus-five implementation contract. The guest-reviewer concept also remains in Personas and Sitemap.  
   Cite: Decision D-03; PRD §§7–8; Personas §4; Sitemap “View as” table; Proposal §§2, 5, 11.

7. **[P0] The D1 model lacks most of the new Admin dashboard’s persisted concepts.**  
   Proposal §5 needs explicit support, or an equally explicit alternative, for:

   - Agency and agent directory records plus their relationship; current `projects.agency` and agent name/email/phone are free text.
   - Project references to directory records while retaining the Tonomo-supplied contact snapshot/history.
   - Archive/restore state and auditability (`archived_at`, actor, restore behavior, active-list filtering). Generic “soft-delete + retention” in Proposal §7 is not a project archive data contract.
   - Editable pipeline-stage configuration and project linkage to it.
   - Staff roles/capabilities sufficient for Admin user CRUD.
   - Integration connection records: provider, connection status, encrypted refresh/access credentials or secure references, expiry, reconnect/error metadata, scopes, and last-sync/webhook metadata.

   Cite: PRD §6.9; Proposal §§5, 7.

8. **[P1] The Admin dashboard has no delivery phase or complete route plan.**  
   Proposal §9 includes only manual project creation in Phase 0; it does not schedule Admin user management, project archive/restore, agency/agent CRUD, stage configuration, or integrations. Sitemap has only “Settings / Users & roles,” while “Clients directory” is still a stub and there are no routes for project administration, pipeline configuration, or integrations.  
   Cite: PRD §6.9; Proposal §9; Sitemap Top-level structure and routing notes.

9. **[P1] Dropbox integration contradicts the new studio-level OAuth requirement.**  
   PRD §6.9 requires one shared studio-level Dropbox OAuth connection with reconnect/expiry status. Proposal §7 lists only a “Dropbox app token” secret; it has no OAuth-connect lifecycle, refresh-token handling, connection status, or Admin integration screen. This is needed before Dropbox sync/autoHDR can be operationally supported.  
   Cite: PRD §6.9; Proposal §§6.5–6.7, 7; Decision D-05.

10. **[P1] PRD ingest requirements directly contradict D-01.**  
    PRD §5 stage 1 permits “RAW or image files,” “any format,” and “no size limit.” D-01 approves `.jpg`/`.jpeg` only, with camera RAW never uploaded. The proposal is correct on this point, but the PRD would cause incorrect upload validation, copy, test fixtures, and Dropbox-sync rules.  
    Cite: Decision D-01; PRD §5; Proposal §§1, 3, 6.4, 8.

11. **[P1] D-04 client-link defaults remain unresolved in the PRD and incomplete in the proposal.**  
    D-04 approved a 30-day default expiry and optional passcode. PRD §§6.7 and 8 still ask for both decisions. Proposal §6.3 says only “expiring by default” and optional passcode; it does not establish the 30-day default.  
    Cite: Decision D-04; PRD §§6.7–8; Proposal §§5, 6.3, 6.9.

12. **[P1] D-05’s per-service Tonomo hybrid is still presented as an open choice.**  
    PRD §4a asks whether intake should start at Awaiting RAW or attach finished deliverables; Proposal §6.5 labels the hybrid as an open decision. D-05 approves both: Awaiting RAW when photos are ordered, while finished video/floorplan/copy are attached immediately with received/status metadata. The current phase plan also does not state this accepted-state behavior as a Phase 3 acceptance criterion.  
    Cite: Decision D-05; PRD §4a; Proposal §§5, 6.5, 9.

13. **[P1] D-02/D-11 photographer behavior is still partly undecided and inconsistently specified.**  
    D-02 approves assigned projects, RAW-only, RAW compare/annotation/recommendation, basic status, and visibility of selected-for-editing state. D-11 approves the filtered dashboard rather than upload-only screen. Personas §2 still asks whether assignment, compare, selected-state visibility, and home-screen type are decisions. Sitemap marks photographer compare as uncertain. Proposal Phase 1 only promises a “minimal project list”; Phase 3 is the first explicit role-filtered dashboard.  
    Cite: Decisions D-02, D-11; Personas §2; Sitemap Project Workspace and routing notes; Proposal §9.

14. **[P1] D-07 is approved, but the schema does not model RAW-to-Edited pairing.**  
    Proposal §6.4 says matched web renditions are required and Phase 2 includes RAW↔Edited compare, but Proposal §5 has no `source_raw_asset_id`, derivation relationship, or other defined pairing mechanism. Selection records alone do not identify which returned edit corresponds to which selected RAW. PRD §5, §8 and Sitemap still label this as open.  
    Cite: Decision D-07; PRD §§5, 8; Sitemap Project Workspace; Proposal §§5, 6.4, 9, 11.

15. **[P1] D-08 is only partially reflected; floorplan version semantics remain underspecified.**  
    The proposal correctly names PDF + JPG and immutable versions, but the PRD and Proposal §11 still call the requirement open. Neither §5 nor §6.10 defines how the PDF and preview image form one floorplan version, nor how “latest approved version by default” is represented/published.  
    Cite: Decision D-08; PRD §§6.5, 8; Proposal §§5, 6.10, 11.

16. **[P1] D-06 and D-12 conflict with unresolved role/copy wording.**  
    D-06 approves one visible Admin/PM role with capability-based implementation. Personas §1 and Proposal §11 still ask whether they are one or two roles. Separately, D-12 approves Admin/Editor PDF upload now, and PRD §4 grants both `canManageExtras`; PRD §6.6 says copy is uploaded by “the project admin” only. Personas §3 still asks who creates/uploads it.  
    Cite: Decisions D-06, D-12; PRD §§4, 6.6; Personas §§1, 3; Proposal §§5, 11.

17. **[P1] Role permissions disagree between PRD and Sitemap.**  
    PRD §4 permits Admin, Photographer, and Editor/QA to upload RAW. Sitemap’s RAW collection says upload is Admin/Photographer only. This must become one capability rule before Phase 1 upload authorization is implemented.  
    Cite: PRD §4; Sitemap Project Workspace.

18. **[P1] D-09’s dev/staging-only “View as” decision is absent from the build plan.**  
    PRD treats the switcher as currently implemented; Sitemap still asks whether to keep it; Proposal §6.1 says to preserve prototype interactions. No document specifies build-time environment removal, production-route protection, or test coverage proving impersonation cannot ship.  
    Cite: Decision D-09; PRD §4; Sitemap “Prototype ‘View as’ switcher”; Proposal §6.1.

19. **[P2] D-13 is reflected in the proposal’s omission, but not resolved in the Sitemap.**  
    D-13 defers Clients and Schedule. Sitemap still renders both as top-nav stubs and marks them “NEEDS INPUT”; no document states whether they are hidden in production MVP or merely non-functional.  
    Cite: Decision D-13; Sitemap Top-level structure and routing notes.

20. **[P2] Prototype-status claims are internally stale and can mislead scope planning.**  
    PRD §4a labels automatic Tonomo intake “Built,” while Proposal §9 schedules production intake for Phase 3 and describes manual project creation first. Sitemap says client collection tabs and video/copy publish are still planned, while PRD §§5–6.7 calls them built. These may describe prototype behavior, but the documents do not consistently separate prototype UI from production capability.  
    Cite: PRD §§4a, 5–6.7; Sitemap Client Delivery Page; Proposal §9; README.

21. **[P1] The Week-1 environment and external-registration checklist is incomplete.**  
    Proposal §7’s secret list covers only Tonomo, Dropbox app token, and Stream/Images. It does not answer:

    - Cloudflare account/zone ownership, worker/service-binding names, D1/R2/Queue/Workflow binding inventory, and per-environment values.
    - Google OAuth client owner, consent configuration, redirect URIs, allowed Google accounts/domains, client ID/secret, and rotation.
    - Magic-link email provider, sending domain/from address, templates, deliverability monitoring, SPF/DKIM/DMARC, and email-provider credentials.
    - Session/cookie encryption/signing secrets, magic-link token policy, and integration-token encryption/key ownership.
    - Dropbox app registration, scopes, redirect/callback and webhook configuration, shared-studio authorization owner, refresh-token rotation, and autoHDR folder ownership/layout.
    - Tonomo signing/event contract and Vimeo connection credentials required by the new integration dashboard.
    - The named staff-account provisioner and initial Admin bootstrap procedure.

    Cite: Decision D-14; PRD §6.9; Proposal §§6.3, 6.5–6.7, 7, 9.

## Decision trace

| Decision | Status in PRD/proposal |
|---|---|
| D-01 JPEG-only ingest | Proposal aligned; PRD contradicts it. |
| D-02 Assigned RAW-only photographer | Partly aligned; Personas/Sitemap/Phase 1 still unresolved. |
| D-03 No client review MVP | Not rippled; PRD stage, open questions, Personas, Sitemap remain stale. |
| D-04 30-day optional-passcode links | Not rippled fully; still open and proposal omits 30-day default. |
| D-05 Tonomo hybrid intake | Still marked open. |
| D-06 One visible Admin/PM | Still marked open; capability storage absent. |
| D-07 RAW↔Edited compare in Phase 2 | Proposal plans it, but pairing data model is absent; PRD/Sitemap stale. |
| D-08 Floorplan PDF + preview/versioning | Partly aligned; approval/pair/default semantics absent and PRD remains open. |
| D-09 Dev/staging-only View as | Not rippled into build/environment plan. |
| D-10 Vimeo now, Stream later | Aligned in PRD and proposal. |
| D-11 Filtered photographer dashboard | Not fully scheduled or reflected in Personas/Sitemap. |
| D-12 PDF-only copy now, Admin/Editor | PRD role wording and Personas remain inconsistent. |
| D-13 Defer Clients/Schedule | Proposal effectively defers; Sitemap remains unresolved. |
| D-14 Google + magic-link staff auth | Fundamentally contradicts the proposal’s Access-based design. |
| D-15 React 18 + TypeScript + Vite SPA + Hono | Aligned in the proposal; no conflicting PRD requirement found. |