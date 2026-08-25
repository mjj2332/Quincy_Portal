# TB3 direct Collaboration route

Target A, local only.

- Arrival URL: `/projects/A?collaboration=open`.
- Arrival start: 2026-08-25 12:15:37.292Z.
- Canonical/render observation: 2026-08-25 12:15:38.448Z; delta 1,156 ms.
- Actual URL: `/projects/A`; Collaboration overlay open once; A heading rendered; active element
  was the Hide Collaboration button; document visibility was `visible`.
- Back and Forward returned the canonical `/projects/A` route with the Collaboration panel still
  rendered. History traversal left focus on the document body, matching the observed current
  behavior rather than inventing a new focus claim.
- Modified-click on the Dashboard project link opened a regular same-session Admin tab on A; the
  inherited Admin account was confirmed. A close was attempted during cleanup. After the connector
  reset, final regular-tab retention was not independently confirmed.
- Reopening the arrival URL again canonicalized to `/projects/A` and reopened Collaboration.
- Stage-hidden collaboration-only was not attempted: no safe stage-change control was available in
  the real Admin/project UI for these fixtures, and permanent/destructive fixture manipulation was
  out of scope.
