# TB2 items 8–9 — draft, selection, scroll, and Lightbox preservation

## Draft / interaction preservation

Project A was on the RAW tab. The following local-only state was created and intentionally not
submitted:

- non-default `Labeled 0` filter (`chip is-active`);
- window scroll `window.scrollY=347.5`;
- unsent comment `TB2 unsent comment — cancel after refresh`;
- open subtask composer with title `TB2 draft subtask (cancel)`;
- assignee popover selected Quincy Admin;
- due-date popover opened and inspected;
- RAW tab remained active.

At 04:08:54.545 an actor tab triggered a reversible detail refresh. At 04:08:55.376 the observer
requested only A detail. After the refresh, exact comment text, subtask title, assignee, active RAW
tab, `Labeled 0` filter, and `window.scrollY=347.5` remained. The detail DOM showed the temporary
actor value. The native date input exposed its typed property value during the popover attempt,
but the available browser input path did not commit that value into the React composer state;
therefore due-date preservation is not claimed as a pass.

The subtask composer was cancelled, the comment editor was cleared with keyboard selection and
Backspace, the filter was returned to `All 2`, and scroll was returned to 0. No comment or subtask
POST occurred.

Multi-tile selection was **not applicable — both local A RAW tiles were disabled while their
previews were processing**. No selection mutation was attempted.

## Lightbox preservation

**Not applicable — local rendition pipeline gap.** A's two RAW assets remained in `Processing
preview`, so no middle rendered asset could be opened, no review panel/annotation draft/zoom/
panel-scroll state could be created, and no current/different asset deletion scenario could be
run safely. This is the documented local background-worker/rendition limitation, not an inferred
pass or a fabricated thumbnail result.

