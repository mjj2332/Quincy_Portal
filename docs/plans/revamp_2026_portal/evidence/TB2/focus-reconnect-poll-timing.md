# TB2 items 4–5 — focus/reconnect and visible bounded poll

## Required tab relationship note

This run used two disposable tabs in the same already-authenticated local Chrome session: an
observing tab and an actor tab. This is an explicit same-session proxy for the plan's second
authorized session. It is not a genuinely separate principal or browser profile. This proxy is
adequate for server-side change plus query freshness, but the same-session BroadcastChannel can
also invalidate an exact key immediately.

## Focus / hidden-tab attempt

- The observing tab reported `document.visibilityState="visible"` before and after tab-control
  attempts.
- The Chrome browser connector did not expose a real active/inactive tab switch to the page;
  `Page.setWebLifecycleState({state:"hidden"})` returned `Unidentified lifecycle state`, while
  `frozen` left `document.visibilityState` as `visible`.
- Therefore the required >15 s hidden-tab stale-refetch and zero-hidden-poll assertions are
  **not applicable in this harness**. No visible state was silently relabeled as hidden.

## Reconnect run

Network settings on the observer: CDP `Network.emulateNetworkConditions(offline=true)`; the actor
remained online. The observer still reported `visibilityState="visible"`.

| UTC | Event |
|---|---|
| 04:04:04.435 | Actor began a reversible A detail edit while observer was offline. |
| 04:04:05.230 | Actor PATCH request started. |
| 04:04:06.275 | Observer connectivity restored (`offline=false`). |
| 04:04:06.301 | Observer started exact A detail and A raw-assets refetches, 26 ms after restore. |
| 04:04:08.192 | Observer DOM showed the temporary detail value. |

The temporary detail value was then cleared and saved back to the original empty value. No draft
content was submitted.

## Visible bounded poll run

The B observer remained visible and untouched. Normal project-data poll requests were captured at
approximately 30 s cadence: raw assets at 04:06:12.526 → 04:06:42.548 (30.022 s), then a later
sequence at 04:07:18.897 → 04:07:48.915 (30.018 s). No ordinary raw/detail request was faster
than the configured 30 s interval in the untouched sequence.

The precise post-poll proxy sample was:

| UTC | Event | Delta |
|---|---|---:|
| 04:16:19.218 | B observer raw poll started | — |
| 04:16:22.992 | B actor PATCH request started after the observed poll | 3.774 s after poll |
| 04:16:23.017 | B observer exact detail refetch started | 25 ms after PATCH |
| Immediately after a 700 ms observation wait | B observer DOM showed the temporary value | within 1 s of refetch |

The observer did not request B raw assets as a side effect of the detail-only change. The temporary
value was cleared and saved back to empty afterward. The same-session proxy is explicit above; the
timing is not presented as a cross-profile result.
