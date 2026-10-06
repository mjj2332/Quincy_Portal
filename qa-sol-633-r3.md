- **minor** — `portal/apps/web/src/lib/format-email.tsx:9`: The new `EmailText` element has no required reuse ledger entry. Reviewers cannot audit the hand-built `<wbr>` helper against the reuse rules. Add plan/PR ledger entries for the helper and changed Admin table/email cells, recording the helper’s searches, candidates, and rationale.

Reuse ledger: missing for EmailText and changed Admin TableWrap/email cells.

FIX FIRST