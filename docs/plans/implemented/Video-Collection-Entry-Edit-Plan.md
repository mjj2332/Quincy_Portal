# Video Collection Entry Edit — Plan

**Status: IMPLEMENTED. Committed 372b9b3, deployed to production 2026-08-18 (quincy-portal-app
version 5f2122b2-0472-45f2-a278-ed2f7a527734).**

## Problem and scope

Staff can add and delete manual external links in a project's video collection, but cannot correct a label or URL. The video tile list and add-link form are in portal/apps/web/src/components/CollectionPanel.tsx:24-30,72. ProjectWorkspace passes canManageCollections to the panel at portal/apps/web/src/screens/ProjectWorkspace.tsx:420,459; it is derived from editProject or manageExtras. The Worker uses the matching canManageCollection helper at portal/workers/app/src/routes/collections.ts:35-39.

Add an inline editor for the Label and URL of an existing manual video link. This changes fields on an existing collection_links row only. No schema migration is required: collection_links already has url, label, source, created_at, updated_at, and a unique collection_id + url index (portal/packages/db/src/schema.ts:280-297).

## Explicit non-goals

- Do not alter link creation or deletion, including POST's existing idempotent ON CONFLICT DO NOTHING create path (collections.ts:155-170).
- Do not allowlist video platforms; the current HTTPS format check remains the full URL policy.
- Do not add a collection-link author column or apply annotation's author-only policy. Manual links are capability-managed.
- Do not edit source === "tonomo" links; they remain read-only with DELETE's existing immutable error (collections.ts:173-187).
- Do not update receivedCount, touch R2, or change floorplan/copy/document flows.
- Keep DELETE's deliberate broader scope: it joins on projectId rather than `kind = "video"` (collections.ts:178), so a manual floorplan/copy link remains deletable even though this PATCH endpoint makes it non-editable. Do not "fix" that intentional asymmetry as part of this work.

---

## 1. Worker endpoint

### Contract

Add PATCH /projects/:id/links/:linkId in portal/workers/app/src/routes/collections.ts.

Request body:

~~~
{ "url": "https://…", "label": "Optional display label" }
~~~

url is required. label remains optional: the client omits the key when its trimmed input is empty, and the Worker stores NULL; supplied non-empty labels are trimmed and limited to 1–240 characters.

Reuse the actual existing linkInput schema at collections.ts:22-26. Define a named linkEditInput by picking url and label from linkInput, rather than duplicating the rules. That carries forward both z.string().url() and the HTTPS-only URL.protocol refinement.

Return 200 after a successful update with the same link shape existing POST returns (collections.ts:168-170):

~~~
{ id, url, label: string | null, source: "manual", createdAt }
~~~

This can replace the frontend's Link item directly. Update url, label, and updated_at only; preserve created_at. Do not add updatedAt to the response, because neither existing GET/POST nor the frontend Link type exposes it (collections.ts:149-152,168-170; CollectionPanel.tsx:8).

### Authorization and error contract

Follow the current POST/DELETE order: validate UUID params, call hasProjectAccess, call canManageCollection, parse JSON through jsonInput, then load the link by link ID and parent project **through an inner join to collections constrained to kind = "video"**. Do not copy annotations' author-only check: those are author-owned (portal/workers/app/src/routes/annotations.ts:120-153), whereas collection links have no author field. A link belonging to a floorplan or copy collection is deliberately indistinguishable from an absent link here: both return `404 { error: "Link not found" }`.

| Condition | Response |
| --- | --- |
| Invalid project or link UUID | 400 { error: "Invalid project or link id" }, matching DELETE at collections.ts:173-176 |
| No project access | 403 { error: "Forbidden: you are not assigned to this project" } |
| No editProject and no manageExtras capability | 403 { error: "Forbidden", capability: "manageExtras" }, via existing forbidden() at collections.ts:35-39 |
| Malformed JSON | 400 { error: "Invalid JSON" }, from jsonInput (routes/helpers.ts:5-10) |
| Missing/invalid URL or label | 400 { error: "Invalid input", details: … }, from the same parser/schema |
| Link ID absent from the parent's video collection (including a floorplan/copy link) | 404 { error: "Link not found" } |
| Tonomo-delivered link | 409 { error: "Tonomo delivery links are immutable" }, exact existing DELETE wording |
| Another link in the same collection has the submitted URL | 409 { error: "A link with this URL already exists in this collection" } |

The existing capability table admits admin/editor and rejects photographer: admin has editProject/manageExtras, editor has manageExtras, and photographer has neither (portal/packages/shared/src/capabilities.ts:51-108).

### Collision protection and audit write

The unique collection_id + url index means PATCH must not inherit POST's silent conflict/no-op behaviour.

1. Use the loaded link's collectionId, never a client-supplied collection, to look for **another** row with the proposed URL (`id != linkId`). If found, return the explicit collision 409 with no row change or audit event. This self-exclusion permits a label-only edit whose URL is unchanged.
2. Retain the unique index as a concurrent-writer backstop. In one ordered D1 batch, first issue a manual-only guarded UPDATE that also confirms its collection remains in this project with `kind = "video"` (by `EXISTS`/join-equivalent constraint) **and pins the loaded pre-read snapshot** with `AND url = ? AND label IS ?`, bound to that row's original URL and label. `IS` is required so a NULL label compares correctly. This prevents a concurrent manager's changed values from being overwritten and guarantees the audit `previous` value is the immediately preceding row state. Immediately follow it with the audit `INSERT … SELECT … WHERE changes() > 0` statement, as in assets.ts:136-137. Bind the new audit ID and full metadata only to that gated second statement. Inspect `results[0].meta.changes` from the UPDATE result: only `changes > 0` is a successful update. Thus a zero-row guarded UPDATE cannot commit an audit record.
3. If the guarded UPDATE reports zero changes, re-read the link through the same project-plus-video-collection join and return 404 Link not found (missing, moved outside the video collection, or no longer in this project) or 409 Tonomo delivery links are immutable (source changed), with no audit event. For **every other** re-read outcome (the link is still present, manual, and in this project's video collection, including a snapshot mismatch from a concurrent edit or an unexpected guarded-UPDATE constraint result), return the distinct terminal `409 { error: "This link changed while you were editing; reload and try again" }`. This is the catch-all fallback: do not fall through to a bare throw, retry, or 500. If a concurrent writer creates the collision after the pre-check, translate the constraint error to the same collision 409 rather than returning a 500.

The useful D1/Drizzle UNIQUE text is nested in error.cause rather than necessarily error.message. Add a narrowly scoped collection-link conflict predicate beside uniqueVersionError() (collections.ts:105-110), or equivalent cause-chain logic, matching collection_links.collection_id, collection_links.url. This is mandatory per docs/lessons.md:195-203.

For a successful update, introduce this explicit audit metadata contract (the existing collection-link create/delete events use flatter metadata; this nested before/after shape is new):

~~~
action:     "collection_link.update"
targetType: "collection_link"
targetId:   link ID
actorId:    current user ID
metaJson:   { projectId, previous: { url, label }, updated: { url, label } }
~~~

The before/after metadata makes an externally visible correction auditable without adding author tracking. Reuse the existing `collection_link.*` action namespace at collections.ts:163-166,182-185, but do not imply this new nested `previous`/`updated` metadata shape is an existing convention.

### receivedCount

Do not call COLLECTION_RECEIVED_COUNT_SQL or reconcileCollectionReceivedCount for PATCH. The shared derivation counts collection_links rows plus ready, non-superseded assets only (portal/packages/db/src/collection-count.ts:1-14; equivalent helper at collections.ts:53-59). Changing fields on one existing row changes neither count term, so it cannot change receivedCount or collection status. Only the link's updated_at changes.

---

## 2. Frontend inline edit

Modify portal/apps/web/src/components/CollectionPanel.tsx only in its video LinkTiles path. The floorplan/copy use at CollectionPanel.tsx:81-82 remains read-only. Import apiPatch; it already exists in portal/apps/web/src/lib/api.ts:80-85.

### State, placement, and accessibility

Keep the following state in CollectionPanel beside current add-link state (CollectionPanel.tsx:36-40):

- editingLinkId: string | null, allowing one active editor.
- An edit draft containing url and label.
- editError for inline feedback.
- savingEdit for request state.

Pass active state and edit handlers into LinkTiles.

For each manual video tile, render Edit in the existing .collection-link__meta action area beside Remove. Gate it exactly as the delete control: canManage && link.source === "manual". Do not pass edit/remove callbacks to a Tonomo tile or non-manager, so they remain normal read-only links.

Clicking Edit snapshots link.url and link.label ?? "" into the draft and clears errors. That tile replaces its normal anchor/content and Edit/Remove affordances with Label and Link URL inputs plus Save and Cancel. Hide Remove for the active tile to avoid overlapping mutations, and disable Save/Cancel while saving. Starting a different tile's edit abandons the prior unsaved draft and opens the requested tile.

Use collection-link-form inputs as the visual baseline (portal/apps/web/src/styles/app.css:824-828), adding a tile-editor rule only as needed to stack fields/actions at narrow widths. This is strictly inline—not a modal or route. Put the error next to the fields using role="alert" or an aria-live region and associate it with the input(s).

### Save, cancel, and local list

- Save prevents default. Use the existing httpsUrl helper (CollectionPanel.tsx:12) to reject non-HTTPS URLs locally with the inline text Enter an HTTPS URL. Trim label and omit it when blank, as addLink already does at CollectionPanel.tsx:39, so users can clear the optional label.
- Call apiPatch with the Link response type and a body containing url plus optional label, targeting the selected link path.
- Use a response-backed update, not optimistic state. On 200, replace the one matching item in local links with the response, clear editor state, and show Link updated. No links refetch is necessary. Do not invoke onChanged solely to recompute a count which cannot change.
- On server validation, collision, permission, or transport errors, retain the editor and typed draft and render ApiError.message inline. A toast may supplement this but must not be the sole feedback.
- Cancel makes no request, clears the draft/error, and restores the current local tile.

Known accepted rough edge: an in-flight edit can receive a 404 if another user deletes the link; this initial implementation retains the error state like other failures. A later low-stakes refinement may map that 404 specifically to a links refetch instead.

---

## 3. Tests and verification

### Worker tests

Extend the current collection-link API scenario at portal/workers/app/test/api.test.ts:2483-2507 rather than creating a new fixture. Test:

- Admin PATCH of a manual video link: 200 response; URL/label and updated_at changed in D1; created_at preserved; one collection_link.update audit row; received_count/status unchanged. Parse and assert the full `metaJson` contract exactly: `{ projectId, previous: { url, label }, updated: { url, label } }`, including a `label: null` previous or updated value when the label is omitted/cleared. Seed or control the pre-PATCH `updated_at` (or otherwise force a clock gap) so this assertion can't pass by accident on a millisecond that happens to match — an immediate PATCH in a fast test run can otherwise land in the same millisecond as the row's initial `created_at`/`updated_at`.
- A label-only correction using the link's existing URL returns 200 (the collision check excludes its own ID), updates updated_at, preserves created_at, and writes exactly one collection_link.update audit event.
- Label-clearing and invalid-label matrix, each with no row or audit mutation on failure: omitted `label` is valid and persists `NULL`; `label: ""` returns 400; a whitespace-only label returns 400; explicit `label: null` returns 400.
- Invalid HTTPS URL returns 400 with no link/audit mutation.
- Photographer gets 403. A link ID outside the parent project gets 404. Both preserve data/audit state.
- PATCHing a manual link in a floorplan or copy collection through this endpoint returns 404 Link not found and leaves that link unchanged with no update audit row.
- Tonomo gets the exact immutable 409 and remains unchanged.
- Two manual links in one collection: changing one to the other's URL yields the explicit collision 409, preserves both rows, and writes no update audit row.
- A guarded update that affects zero rows because of a controlled concurrent delete or source change writes no audit event and returns the prescribed post-re-read 404 or immutable 409; a controlled snapshot-mismatch or residual still-present/manual/video outcome returns the distinct reload-and-try-again 409, proving no zero-change branch can leak a 500.
- A focused nested-cause conflict-mapper test, or controlled concurrent-write equivalent, proves the race backstop cannot leak a 500.

### Frontend DOM tests

Extend the happy-dom harness in portal/apps/web/src/components/CollectionPanel.dom.test.tsx:1-62. Add a `collection: "video"` props variant for these tests, and have `apiGetMock` return seeded manual **and** Tonomo links for that variant (rather than its existing unconditional empty links array); then expand its API mock with apiPatch and test:

- Edit is present for manageable manual video tiles and absent for Tonomo tiles and canManage false.
- Edit displays both fields and Save/Cancel; Cancel restores the original tile and performs no PATCH.
- Save sends the selected link's PATCH path/body, replaces it from the mocked response, exits edit mode, and leaves other tiles intact.
- A mocked ApiError collision/validation failure is visible as an inline alert and retains the user's draft. Assert local non-HTTPS validation too.

Run focused Worker and web tests while implementing. Before committing, run from portal/:

~~~
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
~~~

The final shared suite is still required even though shared code is untouched; the workspace test script does not include packages/shared (CLAUDE.md, Verify before committing).

## Review focus / risks

There are no open product decisions: permission, manual-only scope, inline UX, basic HTTPS validation, and the audit action are settled. Review should focus on:

1. Verifying that the ordered D1 batch executes the guarded UPDATE immediately before the `WHERE changes() > 0` audit insert and inspects `results[0].meta.changes`, so a zero-row mutation cannot create an audit event, while both pre-check and race-time conflicts become the same explicit 409. The nested error.cause handling is a known production trap.
2. Verifying the DOM test drives the real inline editor, including preservation of a draft after rejected Save. The current compact LinkTiles renderer makes a static-markup-only test insufficient.
