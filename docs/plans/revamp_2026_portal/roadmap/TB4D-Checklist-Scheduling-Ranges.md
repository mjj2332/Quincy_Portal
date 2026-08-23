# TB4D — Checklist Scheduling Ranges

**Primary user outcome:** project checklist work can carry a truthful optional schedule—unscheduled, due-only, or start/end range—without breaking existing due values/reminders.

**Sequence:** after TB4C, before TB4E  
**Dependencies:** TB2 freshness conventions, TB4 durable envelope, TB4C activity/registry, current checklist collaboration contract

## Schedule states

```text
Unscheduled        no start, no end
Due-only milestone end/due only
Scheduled range    start + end, start < end
```

- Preserve current `due_date` as effective end/due.
- Existing date-only and timed due values remain truthful; no start is invented.
- Start-only invalid.
- Same-day and multi-day ranges allowed.
- No recurrence.

## Time/storage

Canonical timezone is `Australia/Sydney`.

Additively persist optional start civil value, timed start/end UTC instants and offset/fold metadata, plus schedule/item version. Date-only end remains a literal calendar date and receives no fabricated midnight instant. Recheck migration number and prefer additive migration forms compatible with production D1 foreign keys.

Reject DST gaps; repeated wall time requires first/second occurrence selection.

## Editing and permission

Checklist scheduling stays task-level and uses the existing checklist collaboration mutation permission. The checklist item editor supports exact-minute entry and explicit conversion among unscheduled/due-only/range states. Calendar is a later second interaction surface over the same mutation command.

## Reminder/activity/notification

- End/due remains the existing due reminder boundary; start sends no notification in v1.
- End change resets/reversions due-reminder state under the guarded mutation.
- One schedule change is one checklist domain operation; no Calendar-specific event.
- Every committed operation remains audited/activity-recorded under the accepted domain contract.
- Broad same-item/same-actor schedule notifications coalesce within five minutes.
- Targeted assignee notification remains separate.

## API/conflict

Schedule mutation carries expected schedule/item version. Stale mutation returns `409` plus/alongside retrievable authoritative state; UI never silently retries or last-write-wins.

Expose enough authoritative start/end/due/version data for TB5C, but do not add the cross-project Calendar range endpoint here unless useful for proving indexes/query shape. TB5C owns the final range projection.

## Rollback

Disable range-specific UI/API fields and leave additive data. Preserve legacy due-only behavior and due reminders. Do not destructively rename/drop `due_date` merely for terminology.

## Tests/QA

- legacy date-only/timed rows;
- create/update/clear states;
- no-start migration;
- start-only rejection and start<end;
- multi-day;
- Sydney gap/fold;
- exact-minute values;
- version conflict/no auto-retry;
- reminder reset/end boundary;
- coalescing vs audit/activity truth;
- existing checklist assignment/reorder/comment behavior unchanged;
- desktop/compact/phone schedule editor;
- full gate/manual QA.

## Acceptance

Checklist scheduling is a deterministic, backward-compatible domain capability that can ship and remain useful without Calendar; TB5C can consume it without redefining due/reminder semantics.
