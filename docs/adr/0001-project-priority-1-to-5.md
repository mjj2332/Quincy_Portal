---
status: accepted
---

# Project priority narrows from 1–10 to 1–5, by clamping

Project priority was an integer 1–10 (nullable), constrained by a D1 CHECK and mirrored
in the `project.priority.changed` activity payload schema. We narrowed it to 1–5 so the
Board can render it as a five-star control, and we did so by **clamping**: any value
above 5 becomes 5, in the `projects` column and in historical activity payloads alike.

## Considered options

**Clamp (chosen).** `min(n, 5)`.

**Compress.** `ceil(n / 2)` — 1-2→1, 3-4→2, … 9-10→5. Preserves relative ordering across
the whole old range.

**Keep 1–10 stored, show 1–5.** Rejected outright: it permanently splits the stored scale
from the one humans use.

The production distribution decided it. Of 101 projects, 91 had no priority at all, and
the rest were 1 (×1), 6 (×1), 9 (×1), 10 (×7). The studio was using 10 to mean "most
urgent" rather than spreading across the range, so clamping preserves the intent exactly
where it matters — the top of the old scale becomes the top of the new one. Clamping and
compressing differ on **exactly one row**, the project at 6, which clamping promotes to
5. That was accepted as not worth a hand-coded exception in a migration.

## Consequences

Historical `project.priority.changed` payloads were rewritten, so the activity log no
longer records the exact number an actor set when that number was above 5. This is a
deliberate trade: the alternative was a permissive read schema (1–10) alongside a strict
write schema (1–5) for the life of the application. It was judged acceptable because no
consumer ever rendered the value — the notification body reads "<actor> <project>
priority changed." with no number, `ProjectActivityView` does not read the payload, and
the external feed rejects the event type entirely under `priority_withheld`.

A future reader finding a 1–5 column beside a rewritten 1–10 history should read this as
intentional, not as a migration bug.
