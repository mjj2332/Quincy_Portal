# TB2 item 6 — BroadcastChannel timing and narrow requests

The observer and actor were two same-session tabs on the same synthetic project. The exact
project-data resources expected by the implementation were:

- detail: `["project-data", A, "detail"]`
- raw assets: `["project-data", A, "assets", "raw"]`
- edited assets: `["project-data", A, "assets", "edited"]`

## Detail-only example

At 04:08:54.545 the actor began a reversible A detail edit. The actor PATCH completed at
04:08:56.358. The observer then started exactly one A detail GET at 04:08:55.376, within the
same-session invalidation window, and the observer DOM showed the temporary detail value. No
observer raw or edited assets request accompanied that detail-only BroadcastChannel invalidation.

A second B detail-only sample was even tighter: actor PATCH request at 04:16:22.992, observer
detail request at 04:16:23.017 (25 ms), with no observer raw-assets request after the detail
change. The observer updated without a reload.

## RAW-only and cover/review examples

RAW A assets were present as two local records, but both were still `Processing preview`. Their
select, review, cover, delete, and Lightbox entry controls were disabled. Therefore a RAW-only
selection/review/cover mutation and its BroadcastChannel narrow-request proof are **not
applicable — local rendition/background-worker gap**, already documented in `docs/todo.md` and
`docs/lessons.md`. No fake RAW mutation was recorded.

## Disposition

Detail-only BroadcastChannel invalidation passed: same-session observer, exact affected query,
sub-two-second timing, no unrelated active collection request, no reload. RAW-only and rendered
asset examples remain explicitly N/A for the local fixture state.

