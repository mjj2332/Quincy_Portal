# Context

Quincy Portal’s staff UI is a Vite/React SPA whose navigation is held only in React state. Every screen therefore stays at `https://quincy.flamingfire.my/`; project workspaces cannot be refreshed, pasted, shared, or opened in a browser tab. Navigation destinations are primarily buttons, so normal browser new-tab behavior is unavailable.

The App Worker already serves the SPA shell for non-API deep links through Cloudflare Static Assets. The change should make the frontend—not a new server route—the source of truth for staff URLs while preserving the existing Worker API/media/transform protections and server-side authorization.

## Recommended approach

Implement a lightweight, typed internal History API router. Do not introduce React Router or another runtime dependency: the app is currently intentionally state-based, has no router dependency, and this focused route map does not justify a framework migration.

### 1. Define a strict staff route contract and browser-navigation primitives

**New files**
- `portal/apps/web/src/lib/router.ts`
- `portal/apps/web/src/lib/router.test.ts`
- Optional focused internal-link component under `portal/apps/web/src/components/`

Create a pure route module that parses, validates, serializes, and classifies locations:

| Canonical route | Screen |
|---|---|
| `/` | Dashboard |
| `/projects/new` | Create Project |
| `/projects/:projectId` | Project workspace |
| `/projects/:projectId/edit` | Edit Project |
| `/admin` | Admin |

- Represent routes as a discriminated union, including distinct `not-found` and `reserved` variants. Match path segments exactly: `/projects/new` precedes parameter routes (this is a pure static-vs-parameter precedence guarantee — `"new"` can never satisfy a UUID parse either way, so this works regardless of the next point). Project IDs must be canonical **lowercase** UUIDs — this is a route-parser-level choice, not an API-enforced one: every stored/generated ID is lowercase (`crypto.randomUUID()`), but the backend's `z.string().uuid()` validator actually accepts uppercase hex too, so do not claim the API itself validates canonical casing. Reject trailing slashes, duplicate/extra segments, malformed percent encoding (including percent-encoded static spellings like `/projects/%6eew` and `/%61dmin`), decoded path separators, dot-segment/backtracking inputs, noncanonical UUID spellings, reserved namespaces, and unknown paths.
- Preserve query/hash values in the browser location but do not make them part of the initial public staff-route or OAuth return contract. The route parser renders from the canonical pathname; unsupported query/hash state is ignored for UI routing and must never select a sensitive destination. Future features can define validated query parameters deliberately.
- Reserve `/d`, `/d/`, and `/d/*` at both layers. The router returns a distinct non-staff `reserved` result so it never interprets a token as a project, initiates project APIs, SPA-intercepts the link, or accepts it as OAuth return state. Add a narrow, unauthenticated App Worker early 404 for those paths before `ASSETS.fetch()` so today’s staff bundle is never served at `/d/*`. This is a temporary namespace reservation, not a delivery handler: when the future client-delivery Worker owns `/d/*`, remove/replace the guard through that service’s deployment rather than making the staff app proxy delivery traffic.
  - **Corrected 2026-07-24 after independent review (Agy + Sol, both REQUEST-CHANGES on this exact point):** this early-404-before-`ASSETS.fetch()` claim is **not achievable as originally drafted**. `portal/workers/app/wrangler.jsonc`'s `run_worker_first` currently lists only `/api/*`, `/media/*`, `/__transform-source/*` — any path not in that list is served by Cloudflare Static Assets *before the Worker is invoked at all* (documented Cloudflare SPA-routing behavior: https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/). Under `not_found_handling: "single-page-application"`, an unmatched `/d/*` request currently returns `index.html` (200), never reaching `src/index.ts`. **Fix: explicitly add `/d` and `/d/*` to `run_worker_first`**, then register the unauthenticated `app.all("/d", …)` / `app.all("/d/*", …)` 404 handlers before the asset fallback. The "do not broaden `run_worker_first`" constraint elsewhere in this doc must be read as "do not broaden it beyond the existing backend namespaces plus this narrow `/d` reservation" — see the corrected constraint below.
- Provide canonical internal-path generation using encoded project IDs and a safe-destination validator. The validator accepts only the supported staff route grammar and rejects absolute/protocol-relative URLs, backslash/control-character variants, reserved paths, `/d/*`, and unknown locations.
- Provide a small History API adapter: `pushState` for user navigation, `replaceState` for safe redirects, and a `popstate` subscription that updates UI state without pushing a new entry.
- Implement a shared internal link primitive, or a narrowly scoped equivalent helper, that leaves real `<a href>` elements in the DOM. It may intercept only an unmodified, same-origin, primary-button **mouse** click with no `target`/download; Cmd/Ctrl-click, middle-click, Shift-click, target-blank, keyboard activation, external links, and reserved paths retain native browser behavior.
  - **Clarified 2026-07-24 (Sol review):** "primary-button click" and "keyboard activation retains native behavior" were ambiguous together, since a keyboard-triggered click event can also present as an unmodified primary click. Use the standard `event.detail === 0` heuristic (native keyboard-activated clicks report `detail: 0`; real mouse clicks report `detail >= 1`) to distinguish them explicitly in the interception predicate, so keyboard Enter/Space activation is never intercepted and always falls through to the anchor's native behavior.
  - Dashboard project cards currently combine navigation, retry, and Kanban drag in one `<button>` (`portal/apps/web/src/screens/Dashboard.tsx`). Converting the card to a real anchor while keeping retry as a button **must not nest a `<button>` inside an `<a>`** (invalid HTML, unreliable event handling). Use a wrapper `<div>` containing a sibling anchor (covering the card via absolute positioning or an equivalent layout, not `display: contents` tricks) plus the retry button as a true DOM sibling, not a descendant of the anchor. Suppress the anchor's navigation only immediately after a completed drag gesture, not permanently.

### 2. Make the App shell route-driven and preserve current UI/authorization behavior

**Primary file**
- `portal/apps/web/src/App.tsx`

- Subscribe to the location through a StrictMode-safe adapter (for example `useSyncExternalStore`, or an equivalently isolated store), initialize synchronously from the direct URL, and update it explicitly after `pushState`/`replaceState` or `popstate`; do not retain a second `view`/`projectId` source of truth.
- Keep transient success/error notices out of URLs. Pass them through in-memory navigation state (and tolerate their absence after reload).
- Key `ProjectWorkspace` and `EditProject` by the route project ID so browser history or direct project switches reset component-local state and preserve existing asynchronous fetch cancellation/generation safeguards.
- Preserve existing client capability gates using `useCapabilities`:
  - `/admin` requires `adminBackend`.
  - `/projects/new` requires `createProject`.
  - `/projects/:id/edit` requires `editProject`.
  - An unavailable route is replaced with `/` rather than rendered as an empty screen.
- Do not add project-existence or access checks to the route parser. A syntactically valid project route continues into the existing screen/API load path; API middleware remains authoritative for 401/403/project-access handling. This avoids route parsing becoming an authorization or existence-disclosure channel.
- Add a small authenticated in-app Not Found state for unknown staff routes. It must link back to `/` and never attempt project API loads. Preserve the existing sign-in/boot behavior: logged-out deep links first render Sign In, then restore only a validated staff destination after session creation.

### 3. Convert semantic navigation destinations to normal links

**Primary files**
- `portal/apps/web/src/components/Topbar.tsx`
- `portal/apps/web/src/screens/Dashboard.tsx`
- `portal/apps/web/src/screens/ProjectWorkspace.tsx`
- `portal/apps/web/src/screens/CreateProject.tsx`
- `portal/apps/web/src/screens/EditProject.tsx`
- Any small shared card/list component identified during implementation

- Convert brand, Dashboard, Admin, Create Project, project workspace back/edit, and form cancel destinations from callback-only buttons to internal anchors using the route helper.
- Convert Dashboard project cards and rows into actual links to `/projects/:projectId`. Preserve Kanban drag interactions and image retry controls by keeping those as buttons and stopping/preventing navigation only for the action itself.
- After creation, navigate to `/projects/:id`; after edit/archive/restore, navigate to `/projects/:id`; after permanent deletion, replace the current hard `window.location.assign("/")` behavior with the central router. Preserve existing notices as transient navigation state.
- Keep mutation controls (save, archive, stage changes, AutoHDR actions, image retry, sign-out, tabs) as buttons. Keep existing external/document/media anchors unchanged, including their target/rel policies.
- Continue to leave Dropbox OAuth as a full-page external redirect; it is not a staff SPA route.

### 4. Restore intended staff destinations safely after Google sign-in

**Primary files**
- `portal/apps/web/src/lib/auth.ts`
- `portal/apps/web/src/screens/SignIn.tsx`
- `portal/apps/web/src/App.tsx`

- Replace the fixed `callbackURL: "/"` sign-in call with a destination generated from the current relative pathname alone and validated by the shared router allowlist. Better Auth/Google’s existing state and PKCE handling remains intact; this feature must not introduce a second, caller-controlled OAuth state parameter.
- Store only that validated canonical relative path in a one-time `sessionStorage` fallback before initiating OAuth. This covers provider/callback behavior that normalizes or loses the requested pathname.
- Once `useSession` becomes active, consume the stored value once, revalidate it, and restore with `replaceState`; delete it after every consumption attempt. Fall back to `/` on invalid/missing values. Clear it if sign-in initiation fails.
- Never accept an arbitrary query parameter, absolute URL, or unvalidated storage value as a redirect target. Keep Better Auth server `baseURL`, `basePath`, trusted-origin configuration, and its existing CSRF state/PKCE flow unchanged — that flow is sound as-is (Better Auth generates its own OAuth `state` and PKCE verifier, verifies the signed/database-backed state, and passes the recovered verifier to the code exchange; this feature must not add a second caller-controlled OAuth state parameter on top of it).
  - **Corrected 2026-07-24 (Sol review): the server-side callback allowlist is mandatory, not conditional.** This doc previously said to add it "if direct callers can invoke Better Auth with arbitrary callback destinations" — confirmed directly against the installed code that they currently can: `/api/auth/*` is explicitly exempted from this app's own origin-check middleware (`requireAppOrigin` in `portal/workers/app/src/middleware/origin.ts` returns early for that path prefix) and routes straight to Better Auth's handler; Better Auth itself permits relative callback paths whose origin is trusted and stores the caller-supplied `callbackURL` in its OAuth state payload, redirecting to it post-auth. So today, a same-origin caller can request sign-in with any relative `callbackURL` — `/api/...`, `/media/...`, `/d/...`, or an unknown path — and Better Auth will honor it; it only prevents a *cross-origin* open redirect, not enforcement of Quincy's staff-route grammar. **Implement the narrow server-side allowlist/wrapper as a required part of this feature**, not an optional hardening step: it must accept only canonical relative staff paths and reject same-origin absolute URLs too, matching the client-side validator exactly.

### 5. Preserve Worker fallback boundaries and add regression coverage

**Primary files**
- `portal/workers/app/src/index.ts`
- `portal/workers/app/test/api.test.ts`
- `portal/apps/web/src/lib/router.test.ts`
- Existing web test configuration under `portal/apps/web/vitest.config.ts`
- Potentially `docs/Implementation-Plan.md`, `docs/todo.md`, and `docs/QA-Staging-Matrix.md` to record the public route contract and recurring manual/staging matrix

Add `/d` and `/d/*` to `run_worker_first` in `portal/workers/app/wrangler.jsonc`, and register a narrow App Worker `/d` / `/d/*` 404 reservation before `ASSETS.fetch()`; it must not require staff session middleware and must not proxy or implement delivery. Otherwise retain the current static asset SPA fallback and the narrow worker-first route reservations:

- `/api/*`
- `/media/*`
- `/__transform-source/*`

**Bare-root gap (Sol review, 2026-07-24):** none of the three patterns above actually cover the bare root without a trailing segment — `"/api/*"` does not match a plain `/api` request, and neither the `run_worker_first` list nor the Hono catch-alls (`app.all("/api/*", ...)`, `app.all("/media/*", ...)`, the `/__transform-source/*` handler) have an exact-root entry. Do not claim these roots are "protected" without a test proving the deployed routing result. Add exact `/api`, `/media`, and `/__transform-source` entries (both to `run_worker_first` and to explicit non-SPA Hono handlers) alongside the existing `/*` patterns, and cover them in the test list below.

Add Node-compatible pure tests for:

- All canonical route parses and serializations, including static `/projects/new` precedence over the UUID parameter route.
- Unknown, extra-segment, trailing/double slash, malformed-encoding, encoded-separator, noncanonical/uppercase UUID, and `/d/*` routes.
- Reserved API/media/transform paths.
- Query/hash preservation.
- Safe OAuth destinations: allowed canonical pathname-only staff routes accepted; absolute (including same-origin), protocol-relative, backslash/control, query/hash-bearing, reserved, delivery, and unknown targets rejected. Verify one-time fallback consumption, storage exceptions, sign-in failure cleanup, and that the feature continues to use Better Auth’s native state/PKCE flow rather than adding caller-controlled OAuth state.
- **An actual App Worker integration test against Better Auth's sign-in endpoint** (not just frontend/pure tests) proving: canonical relative callbacks are accepted, disallowed relative/same-origin-absolute callbacks are rejected by the new mandatory server-side allowlist, and the generated provider redirect URL contains exactly one library-generated `state` value plus PKCE — pure frontend tests cannot prove this server-side behavior.
- History push/replace/popstate behavior through injected/fake history primitives.
- Internal-link interception predicates, including modifier/new-tab/target behavior, keyboard-activated clicks (`event.detail === 0`) versus real mouse clicks, drag-versus-click suppression on Dashboard cards, and the non-nested-button DOM arrangement.
- Percent-encoded static spellings (`/projects/%6eew`, `/%61dmin`) and raw dot-segment/backtracking inputs, in addition to the malformed-encoding cases already listed above.

Extend Worker asset-fallback regression tests to verify that direct browser GETs for each canonical staff path return SPA HTML, while `/d`, `/d/`, and `/d/:token` — including non-GET methods against `/d` — return the new non-SPA 404 reservation. Retain API/media/transform assertions: misses remain their current protected JSON/404 behavior. Include the exact bare roots (`/api`, `/media`, `/__transform-source`, not just their `/*` descendants) and known static asset precedence rather than treating every HTML 200 as routing success.

Do not add jsdom/Playwright solely for unit testing unless implementation exposes behavior that cannot be covered by pure history/parser tests. The current web Vitest suite is deliberately Node-only. Add/maintain a browser smoke checklist for actual new-tab and OAuth behavior, which Node tests cannot prove.

### 6. Verify, deploy, and smoke-test the frontend-only change

1. Run web typecheck/build and its route tests.
2. Run the app Worker test suite with the extended static-asset route coverage.
3. Run all required workspace typechecks and Vitest suites from `portal/`, then `npm run build -w @quincy/web`.
4. Deploy the rebuilt app Worker/asset bundle only after the SPA build has generated `apps/web/dist`; no D1 migration, Background Worker, or webhook deployment is expected. This deployment contains the narrow `/d/*` reservation as well as the frontend assets.
5. Before claiming OAuth deep-link staging coverage, provision/verify a real staging Better Auth origin, Google authorized origin/callback, and isolated staging resources. Current staging configuration cannot be assumed to validate an OAuth callback safely.
6. On staging, test in a fresh logged-out and active-user browser session:
   - direct entry and refresh for every staff route;
   - Dashboard → project → edit → project transitions and Back/Forward;
   - Cmd/Ctrl-click, middle-click, context-menu Open in New Tab, and normal keyboard activation for project and topbar links;
   - unknown/malformed paths rendering Not Found without staff project requests, and `/d/:token` returning the Worker-level non-SPA 404 reservation;
   - safe Google return to an intended project/edit/admin route; invalid return input falling back to dashboard;
   - capability-denied direct create/edit/admin routes; and
   - `/api/*`, `/media/*`, and transform-source failure paths retaining their non-SPA responses.
6. Repeat the direct-link, sign-in restoration, new-tab, and API-boundary smoke matrix in production before declaring the feature complete.

## Critical constraints and risks

- API authorization in `portal/workers/app/src/middleware/session.ts` and capability checks remain the security boundary; client route guards are only UX.
- **Corrected 2026-07-24:** do not broaden Worker `run_worker_first` *beyond the existing backend namespaces plus the narrow `/d`, `/d/*` reservation this plan requires* (and the bare-root entries above) — the original wording ("do not broaden it" with no exception) directly contradicted this doc's own requirement to reserve `/d/*` at the Worker level, since that reservation is unreachable without adding it to `run_worker_first` (Cloudflare serves unmatched paths via Static Assets before invoking the Worker at all under `single-page-application` fallback). Do not allow the client link interceptor to treat backend/media paths as SPA navigation.
- `/d/*` is reserved at the App Worker during this work (via the corrected `run_worker_first` entry above); the future delivery service must replace that guard by owning the path at the Worker/route layer before client delivery launches.
- The server-side OAuth callback allowlist (§4) is a mandatory part of this feature, not optional hardening — see the correction in §4 for why.
- A real staging OAuth configuration is a prerequisite for promising staging sign-in-return verification; otherwise that case must be verified in production under an approved controlled procedure.
- Do not encode notifications or unsanitized app state in URLs. Do not permit OAuth open redirects.
- Preserve real anchors as the navigation primitive; a button-plus-window-history implementation would reintroduce the new-tab/accessibility failure.

## Cross-review before implementation

**Done, 2026-07-24.** Both Agy and Sol (`codex exec --sandbox read-only -m gpt-5.6-sol -c model_reasoning_effort=high`) independently reviewed this plan and returned REQUEST-CHANGES; Agy and Sol both independently caught the `/d/*` `run_worker_first` contradiction, and Sol additionally caught the OAuth-allowlist-should-be-mandatory gap, the bare-root coverage gap, a factual error in the UUID-validation rationale, and DOM/anchor ambiguities. All findings have been incorporated directly into the sections above (search "Corrected 2026-07-24" / "Clarified 2026-07-24" / "Sol review" for each amendment) — this plan is now amended and ready for implementation. Claude (this session) independently re-verified the two most consequential findings (the OAuth callback exemption and the `run_worker_first` gap) directly against the code before accepting them, rather than trusting either review's self-report alone.
