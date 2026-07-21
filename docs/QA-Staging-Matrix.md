# Staging QA matrix

This is a mutation-safe staging corpus and verification matrix. It does not assert that any
of these resources currently exist; create them only in an isolated staging account with
throwaway data and credentials.

| Area | Safe corpus / action | Expected result |
| --- | --- | --- |
| Auth and routing | Admin, editor, photographer test users; anonymous requests | Route guards return the documented 401/403/404 ordering; production rendition fallback is a `302`, `Location` to Images, and `Cache-Control: private, no-store`. |
| RAW and renditions | Two disposable JPEGs, including a spaced filename and a 20+ MB real photo | Source signature rejects tampering; cold thumbnail/web requests return images and rendition rows only after validated WebP output. |
| Documents | One copy PDF and one floorplan PDF+JPEG preview in a disposable project | Presign → upload → complete creates one immutable version/audit; archive is rejected with active reservations; interrupted completing lease is recoverable and no assets land after archive. |
| Multipart cleanup | Deliberately interrupted multipart upload | Abort is retryable while R2 abort fails; ownership is retained until success/404, then terminal. |
| Delivery links | Duplicate manual/Tonomo URL rows in a disposable collection | Tonomo survivor wins dedupe; counts/status match assets+links; manual create/delete has exactly one audit atomically. |
| Dropbox | Disposable canonical Dropbox connection plus a historical unprefixed error | Successful recovery only clears the exact observed error; a concurrent sticky error remains; worker/UI use the deterministic canonical row. |
| Lightbox | One editable photo with a drawing draft | Escape/undo work while drawing; arrows and review keys do not navigate or mutate review until markup exits. |

External prerequisites to verify before any staging run: separate D1/R2/KV/Queue/DO resources,
staging Google OAuth redirect, Dropbox app/token with required sharing scope, configured Images
allowed origin and cold multi-PoP checks, `TRANSFORM_SOURCE_SECRET` installed identically on app
and background, R2 document-upload CORS exposing `ETag`, and an R2 multipart lifecycle cleanup
rule. The lifecycle rule is a backup, not a substitute for application abort retries.
