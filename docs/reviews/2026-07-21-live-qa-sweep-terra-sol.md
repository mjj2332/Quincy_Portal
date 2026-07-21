# Quincy Portal live QA sweep — terra → sol cross-review (2026-07-21)

Test-and-report exercise only; no code was changed. Loop: **terra** (gpt-5.6-terra, high) ran a
live, non-destructive black-box sweep of `https://quincy.flamingfire.my` in the user's
signed-in Chrome session; **sol** (gpt-5.6-sol, high) cross-reviewed terra's findings against
this codebase, read-only; **Claude** independently verified the highest-impact claims before
gating. Full raw outputs (screenshots, terra's report, sol's review) are session artifacts, not
committed to the repo — this document is the durable summary.

Severity: **P0** = active outage / data-risk / broken auth. **P1** = do first — reliability,
security exposure, or a real user-facing defect. **P2** = real defect, lower urgency. **P3** =
deliberate enhancement, not a regression.

## Coverage

Terra tested (desktop 1440×1000 + narrow 700×900): Dashboard (grid/list/kanban + reload
persistence), project workspace (`4 McGowen Ave`, 103 RAW frames), review lightbox, admin
(Users/Directory/Pipeline/Integrations/Tonomo queue), project create + edit forms, and
thumbnail/rendition loading under grid + filmstrip concurrency. Zero console errors observed;
no broken tiles/stuck loaders on 103 frames + full filmstrip (the prior thumbnail-outage area
held up). No junk data was created; no forms were submitted; no destructive/irreversible action
was taken (by design — see spec constraints in the session).

**Not covered** (sampled project had no Edited/Video/Floorplan/Copy/Extras assets, and prod
DevTools network capture was blocked by browser security policy on that origin):
RAW↔Edited compare, collections/PDF versioning, Extras ingest, all form-*submit* paths
(comment/rating/annotation/create/edit persistence), and direct enumeration of failed network
requests. Closing these requires a mutation-safe staging corpus (P1-4 below).

## Live findings, re-triaged against code

| # | Finding | Terra's call | **Final severity** | Why |
|---|---|---|---|---|
| 1 | Primary nav + Sign-out disappear at ≤720px (only home button + "QA" badge remain; no mobile-menu replacement) | High | **P2 (Medium)** | Confirmed bug — `Topbar.tsx` + `app.css:640`/`app.css:857` hide `.topnav` and the identity/sign-out block with no JS fallback. Downgraded from High: Dashboard stays reachable via the home button; this is a desktop-first internal staff tool. Losing Sign-out is still a real gap. |
| 2 | Dropbox integration shows status `Error` — *"Durable Object reset because its code was updated"*, "No events recorded" | Medium | **P1** | Real-but-transient display masking a genuine bug (see P1-1 below): the error is sticky (clears only on token refresh or OAuth reconnect, never on a successful ordinary sync) and `lastEventAt` is never written by any Dropbox path, so "No events recorded" always shows regardless of actual sync activity. Terra proved the indicator is red, not that syncing is currently broken. |
| 3 | Review lightbox has no zoom | Medium | **P3** | Works-as-designed, not a regression: the prototype lightbox never had zoom, PRD review-tool acceptance criteria don't list it, and synced-compare zoom is explicitly listed as deferred in `docs/todo.md`. |

## Additional issues sol found reading the code (not visible from terra's live run)

Verified directly by Claude (file:line), independent of sol's claim:

- **Dropbox webhook events can be permanently stranded.** `workers/webhook-ingress/src/index.ts`
  (`/webhooks/dropbox` handler, ~line 117): a handoff failure to the background DO is caught
  and swallowed, then the handler still returns `200 "ok"` — so Dropbox never retries the
  delivery. The handler also does not re-wake the DO on a deduplicated delivery, unlike the
  Tonomo handler a few lines below it, which explicitly does (comment: "the event is durably
  stored; an RPC failure must not make Tonomo retry a deduped delivery" — Dropbox has no
  equivalent safeguard).
- **`/__transform-source` signatures never expire** (pre-existing known gap — already tracked
  as `TODO(hardening)` in `docs/todo.md` and `portal/workers/app/src/routes/media.ts:28`).
  Confirmed still open: anyone who retains a signed transform-source URL keeps full-resolution
  original access indefinitely, including after project-membership revocation.
- **Comment/annotation creation fails silently.** `apps/web/src/components/Lightbox.tsx`:
  `postComment()` (~line 196) and `saveAnnotation()` (~line 163) wrap their POST in
  `try { … } finally { setIsSaving(false) }` with **no `catch`** — a failed request throws an
  unhandled rejection with no toast and no draft recovery. The sibling *edit* handlers
  (`saveCommentEdit`, `saveDrawingEdit`) correctly catch and show an error toast, so this is an
  inconsistency, not an intentional design choice.
- **Annotation creation accepts arbitrary JSON.** `workers/app/src/routes/annotations.ts:13`:
  the create schema types `strokes` as `z.unknown()`, while the edit schema (used for PATCH)
  validates strokes properly (`z.array(strokeInput).max(200)` with point/color/width bounds).
  Malformed stored stroke JSON could reach the lightbox renderer via an unchecked cast.

Sol also surfaced several **latent bugs from code inspection alone** (lower confidence — not
independently re-verified by Claude line-by-line, but plausible and worth a targeted look
during P1-4's staging pass): compare-mode layout class not reset when navigating from a paired
to an unpaired asset (`Lightbox.tsx`); floorplan PDF and preview use independent per-kind
version counters inside one group, so the "PDF + preview as one version" contract in
`docs/Implementation-Plan.md` isn't actually enforced (`collections.ts` /
`CollectionPanel.tsx`); external collection links never increment `receivedCount`, so the
workspace rail can show `0` beside a populated Video collection (`collections.ts:65`); rapid
collection-tab switching can apply a stale response from a previously-active tab
(`ProjectWorkspace.tsx`); `LazyImage` renders an identical blank placeholder for "still loading"
and "terminal failure," with no retry affordance (`LazyImage.tsx`); no CSRF/origin guard on
custom `/api` mutation routes despite `docs/Implementation-Plan.md` requiring one; lightbox
`role="dialog"` has no focus trap/restoration and several controls lack accessible names; the
50 MB document-upload endpoint buffers the full body through the Worker via `formData()`
despite an existing presigned-upload TODO.

## Prioritized plan

No P0 items — nothing found constitutes an active outage or acute data-risk requiring
immediate action.

**P1 — do first**
1. **Make Dropbox delivery self-healing and health truthful.** Always wake the DO for stored
   *or* deduplicated deliveries (matching the Tonomo pattern); return non-2xx on a synchronous
   wake failure so Dropbox retries, or move to a durable queue. Classify transient vs permanent
   errors with bounded backoff. Record webhook receipt / successful sync completion separately
   from sticky error state; clear transient errors (like a deploy-time DO reset) after the next
   successful operation rather than requiring token refresh or reconnect. Write `lastEventAt`.
   Files: `workers/webhook-ingress/src/index.ts`, `workers/background/src/dropbox/{client,sync}.ts`,
   `workers/background/src/do/dropbox-sync.ts`, `workers/app/src/routes/integrations.ts`,
   `apps/web/src/screens/Admin.tsx`. Effort M, medium blast radius (3 workers + integration
   status data model).
2. **Expire and scope transform-source signatures.** Sign `{key, expiry}` with tight clock
   skew instead of an unexpiring per-key HMAC; keep the authenticated `/media/asset` gate in
   front. Files: `workers/app/src/lib/transform-source.ts`, `workers/app/src/routes/media.ts`,
   `workers/app/src/index.ts`. Effort M, high image-serving blast radius — stage carefully.
   Security-relevant: closes a post-revocation access-retention gap.
3. **Surface create-comment/annotation failures; validate strokes on create.** Add `catch`
   paths with draft preservation and error toast (mirror the existing edit handlers); reuse the
   edit-time stroke schema for the create route. Files: `apps/web/src/components/Lightbox.tsx`,
   `workers/app/src/routes/annotations.ts`. Effort S–M, low blast radius.
4. **Stand up a mutation-safe staging QA corpus + E2E/background-worker test matrix.** A
   persistent staging project with RAW/Edited pairs (including one unpaired edit), root +
   `EXTRAS/` Dropbox fixtures, video links, two floorplan groups, multiple document/copy PDF
   versions. Closes every coverage gap this sweep hit, and gives the background Dropbox sync
   logic its first dedicated automated test suite. Effort L, low production risk.

**P2** — narrow-screen account/nav menu (Topbar + app.css, add capability-gated Dashboard/
Admin/identity/Sign-out behind a menu trigger) · model floorplan PDF+preview as a real
version-pair · fix collection `receivedCount` for external links + the tab-switch race ·
reset compare state on frame navigation · add CSRF/origin guard to custom `/api` mutations ·
real failed-media terminal state + lightbox focus/a11y.

**P3** — deliberate lightbox + synced-compare zoom (explicitly deferred, not urgent) · move
large document uploads off `formData()` onto the presigned-upload pattern already used
elsewhere.

## Next steps

Plan only — no implementation has started. When ready, P1 items go back through the
terra (implement) → sol (review) → Claude (gate) loop per the standing orchestration pattern.
Recommended starting pair: **P1-1 (Dropbox reliability)** and **P1-2 (transform-source
expiry)** — one is live RAW-sync reliability, the other is a real data-exposure hole.
