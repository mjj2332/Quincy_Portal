# TB4 access removal and single producer

Local-only evidence. All project, recipient, and comment identifiers are redacted.

## Access removal

At 2026-08-26T01:04:33Z, the second-principal membership was removed in the real Admin Edit form while the mention outbox was still eligible for delivery. The subsequent local recovery pass observed:

- outbox: `pending/queued → suppressed`;
- outbox delivery attempts: 1;
- email ledger: `suppressed`, attempts 0;
- in-app ledger: `suppressed`, attempts 0;
- safe error code: `reauthorization_suppressed`;
- audit action: `notification.delivery.suppressed`.

The worker integration test also passed removal/re-add, removal between channels, deleted mapping, and deleted comment cases. Re-add through the UI displayed a transient 500 alert after persistence; D1 verified the membership was restored before cleanup. A dedicated repro pass (see manual-qa.md item 5) confirmed this was NOT a TB4 defect: the comment-edit route itself returned 200 with the correct body on all 3 repeat attempts, and the 500 traced to the unrelated project-membership route hitting this repo's already-documented local wrangler dev/D1 flakiness.

All lease values are redacted as `****`. No comment text, email address, payload JSON, cookie, token, or raw provider error is included.

## Single producer

The live create/edit path generated one outbox occurrence per accepted mention source key. Source tracing and tests confirmed:

- project comments use the shared `project.comment.mentioned` outbox producer;
- Notice Board continues to use its separate direct notification producer;
- no legacy or duplicate project-comment producer was touched;
- app producer/admin tests and Notice Board tests passed.

The fixture comments, mappings, delivery rows, outboxes, memberships, and synthetic recipient were deleted after capture. The labeled project remains unarchived for the orchestrating session.
