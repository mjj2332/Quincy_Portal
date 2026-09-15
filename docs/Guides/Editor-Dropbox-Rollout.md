# Editor Dropbox rollout

Implementation is opt-in. No production migration, folder linking, webhook replay, or feature activation is performed merely by building or deploying this code.

## Confirmed workflow

- Editor workspace: `/Editor/01_ACTIVE EDITS`.
- New Project root: `2026-10 October/01/<Tonomo project folder name>`, based on the scheduled shoot's civil date. September 2026 stays `09. September`; January 2027 is `2027-01 January`.
- Children: `0. Input`, `1. Output`, `Editing Notes`. Mappings created or linked before 2026-09-15 keep their plain `Input`/`Output` paths; reviewed linking recognises both spellings, and nothing is renamed in Dropbox. Existing mapped paths stay fixed after rescheduling.
- Input imports DNG/JPEG originals into RAW review; Output imports edited JPEGs without assuming one output equals one original. Importing is not client publication.
- Existing active Projects require reviewed folder identity. Exact date/name matches are suggestions, not authority. An Admin can provide an explicit reviewed alternate for a legacy name/date without moving files.
- Tonomo RAW paths remain separate, preserving AutoHDR identity. A ready Editor mapping takes over I/O. Pending/review mappings retain legacy RAW intake where available, but do not permit edited publication into an unverified destination.
- Portal's own exports use `Manual-Uploads/<asset-id>/<filename>` below Input/Output. This is a reserved echo-suppression subtree; users should place externally edited files elsewhere under Output.

## Activation order

1. Back up production D1 and review migration `0041_editor_folder_mappings.sql`. It adds a table and indexes, with no rebuild of Projects.
2. Deploy background, webhook-ingress, then app with `DROPBOX_EDITOR_AUTOMATION_ENABLED="0"` in both background and app. Validate existing behavior before activation.
3. Review active Project candidates using `GET /api/integrations/dropbox/editor-folders?cursor=<optional UUID>`. Pages contain at most 25 Projects. Unresolved entries are `needs_review`; never guess an address match. Legacy Projects hand-named outside the derived path (`<month>/<dd>/<Tonomo RAW leaf>`) are inspected instead with `POST /api/integrations/dropbox/editor-folders/inspect`, body `{ "projectId": <uuid>, "rootPath": <the hand-named Editor root> }`; `derivedRootPath` in the response shows what automatic discovery would have used, for comparison against the reviewed root.
   - `projects.shoot_date` must be a canonical `YYYY-MM-DD`; rows still showing `needs_review` with "Invalid shoot date" are `awaiting_raw` legacy rows pending the follow-up migration.
4. Link a reviewed candidate with `POST /api/integrations/dropbox/editor-folders/link`, body `{ "reviewed": true, "candidate": <reviewed object> }`. This endpoint requires `manageIntegrations`, validates current Project snapshots, and re-reads exact Dropbox folder IDs and paths. An established mapping cannot be relocated through linking. The `candidate` object from a `POST …/editor-folders/inspect` response (when `status` is `"candidate"`) is pasted verbatim as this endpoint's `candidate` body.
5. Before enabling auto-creation, set background `EDITOR_AUTOCREATE_AFTER_MS` to the agreed deployment cutover instant in epoch milliseconds. The default `"0"` disables automatic creation for unmapped Projects. Earlier Projects continue through reviewed linking; their folders are never automatically recreated.
6. Enable `DROPBOX_EDITOR_AUTOMATION_ENABLED="1"` in both Workers for the pilot. Linking while enabled enqueues an initial sync so files that predate the monitor cursor are not missed. A mapping linked while disabled retains a pending initial-sync marker; the minute recovery scan enqueues it after activation. The marker is completed only after both Input and Output finish their bounded scans. Review DNG previews and file counts before expanding the batch.
   - Pilot completed 2026-09-14 on one `editing_autohdr` Project: the Editor monitor durable object bound to `/Editor/01_ACTIVE EDITS` and the initial sync ingested Input and Output on the first run. The flag is now `"1"` in both committed `wrangler.jsonc` files, so a redeploy no longer turns Editor automation off.
7. Monitor `GET /api/integrations/dropbox/monitors/editor` and the Project jobs endpoint. Failed Editor jobs can be retried through the existing Admin job retry endpoint. The Editor cursor is independent of RAW and AutoHDR.

## Webhook recovery

The `action: "changed"` fix unwraps the nested order and validates its identity against the outer order reference. It preserves existing field-merge semantics; it does not introduce unconditional overwriting of manually populated Project fields. The four observed payloads without any order identity are a separate invalid payload class and remain visible for review.

After a deployed fix is verified, replay only the reviewed changed-event failures through the existing Admin retry workflow. Do not bulk discard invalid events or blindly replay old metadata. Replays can trigger downstream reconciliation once automation is enabled.

## DNG verification gate

Original DNG bytes remain immutable and downloadable. Browser review uses a separate cached derivative, never DNG bytes labelled JPEG. Test representative studio DNGs, including orientation and embedded-preview format, before production activation. A successful import alone does not prove a usable review preview. BigTIFF, missing previews, or unsupported preview encodings must surface a diagnostic rather than masquerade as a completed preview.

The Canon EOS R5m2 sample uses JPEG XL compression 52546 for its review-size SubIFDs. The bounded decoder accepts reduced JPEG XL previews up to 1,048,576 pixels (the verified sample is 1024×683), with 4 MiB compressed/output caps and separate 64/32 MiB decoder/encoder linear-memory caps. JPEG-embedded previews remain supported. This is an embedded-preview pipeline, not a full sensor-RAW developer; a DNG without a usable embedded preview remains an explicit preview failure with its original retained.

## Rollback

Disable the Editor flags in both Workers to stop Editor ingestion/provisioning and restore legacy routing. Keep mapping rows and files intact. This does not move files back to Tonomo or undo imported assets, so review the operational consequences with the studio before toggling. Never delete the mapping table to simulate rollback.
