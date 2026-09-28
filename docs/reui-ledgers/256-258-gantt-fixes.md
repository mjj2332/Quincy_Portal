# #256 / #257 / #258 Gantt fixes — reuse ledger and known gaps

Per AGENTS.md "Reuse ledger": one line per UI element added or changed on `fix/gantt-256-257-258`. Copy into the PR body.

Searches ran against the local `tmp/ReUI_Full_Source_Code/` copy: the ReUI MCP was not connected on 2026-09-28, so this ledger may lag the live registry.

| Element | Source | Notes |
|---|---|---|
| Tree name column fills the panel (`treePanel.nameColumnFill`) | `components/reui/gantt/gantt-view.tsx` + `gantt.tsx`: an additive, default-off extension of the vendored `treePanel` | Searched: `nameColumnWidth` across `reui-blocks-main` (`c-gantt-5`, `gantt-3/run-board`) and `reui-templates-main/tempo-tasks`. Every ReUI consumer passes a fixed px `nameColumnWidth`, and none makes it follow the splitter. A fixed width cannot follow a live splitter drag (the vendor mutates `style.width` outside React), so the fill is pure CSS (`flexGrow`, with the width as a floor). Vendor edit-log entry. |
| Tree header label "Projects" | vendored `gantt-i18n` `labels.resources`, overridden via `<Gantt i18n>` | No new element. |
| Edited review hatch on bars | `lib/stage-colors.ts` `STAGE_HATCH_CLASS`, applied through the new additive `GanttEvent.className` (`gantt-types.tsx`, `gantt-bar.tsx`) | Modelled on the vendor's own off-day body hatch (`gantt-view.tsx`, "whisper-faint diagonal hatch"). Searched "hatch"/"striped"/`repeating-linear-gradient`: only that off-day texture and chart fills in templates. No per-event pattern API exists in ReUI's gantt, and `classNames.event` is one global string, so a vendor hook was unavoidable. Token-driven (`--gantt-event-color`), no literals. Off on `data-completed` and `data-milestone`. Owner chose a secondary cue over a new hue (2026-09-28). |
| Hatched legend and filter swatch | `components/quincy/StageSwatch.tsx` `pattern` prop (existing Quincy swatch from #255) | Same class as the bars, over a 25% tint. |
| Legend label colour | existing `text-foreground-secondary` role (`--text-secondary`, ≈9:1 on paper) | Replaces `text-muted-foreground` (≈3.5:1). |
| Dated time label on hollow-start and completed bars | vendor `formatEventTime` (`mergeGanttI18n(GANTT_I18N)`), zoned with vendored `toZoned` | Replaces a Quincy `Intl` lookalike. No new element. |

## Known gaps (not fixed, by decision)
- The drag ghost and the offscreen indicator chip (`gantt-view.tsx`) paint the stage colour only, with no hatch, so the two review stages look alike mid-drag and on the offscreen chip.
- `ganttFormatEventTime` matches the live `<Gantt>` settings only while `<Gantt>` receives exactly `GANTT_I18N`, `timeZone={GANTT_TIME_ZONE}` and no `locale`. The completion DOM test's aria-label containment check catches drift.
- The name cell's floor is 180px, the splitter minimum. In a container narrower than that, the vendor's `clampContainer` can shrink the pane below 180px, and the name cell then overflows instead of shrinking. Check in the browser pass.
