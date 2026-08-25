# TB3 drafts, pagination, mentions, access, and audit

## Drafts

The full rich-text draft/edit preservation sequence was not completed before the intentional QA
principal deactivation. No unsent draft was submitted. A related visible regression was observed:
after successful Admin and QA posts, the composer still contained the posted text instead of
resetting to an empty document.

## Pagination and mentions

The >50 synthetic-comment volume, opaque cursor continuation, four-page head reset, rich-text
mention normalization, edit-only new mentions, and targeted mention persistence checks were not
attempted. No real client data was used.

## Author-only access

Admin-owned comments exposed Edit/Delete only to Admin; no cross-author mutation was submitted.
The residual QA-authored comment could not be deleted by Admin, consistent with the server’s exact
author-only 403 guard. Direct D1 deletion was deliberately not used because it would bypass the
audit/authorization contract.

## Access lifecycle

Removing A membership produced the QA terminal message `Project unavailable. Forbidden: you are not
assigned to this project` at 12:39:07.217Z. B was archived to attempt an unavailable-project state,
but an assigned QA principal still rendered B, so that exact 404 case was not satisfied. B was
restored and its temporary membership removed. Deactivation produced the local sign-in screen after
reload; no sign-in was attempted. Reactivation was confirmed in Admin at 12:41:37.115Z.

Audit and targeted notification counts were not independently queried in this manual run.
