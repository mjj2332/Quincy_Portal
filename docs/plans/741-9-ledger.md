# #741 slice 9: reuse ledger

Searches run on the ReUI MCP (live, 2026-10-10): "export download menu", "dropdown checkbox radio items", "download error status". Closest hits: `c-dropdown-menu-13` (share and export dropdown, built on `dropdown-menu`), `c-menubar-3` / `c-context-menu-6` / `c-context-menu-7` (checkbox and radio items), `c-alert-8` (error alert). No registry version gap to record: nothing is installed or upgraded. No raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or widget `role` literal is added, so `config/ui-primitive-allowlist.ts` is untouched (the menu roles come from Base UI).

| Element | Item | Note |
|---|---|---|
| "Export markers" group in the Notes actions menu | `components/quincy/menu.tsx` (`Menu`, `MenuPrimitive.Group` / `GroupLabel`), the surviving Quincy-owned Base UI menu | `c-dropdown-menu-13` composes the registry `dropdown-menu`, which would be a second menu skin beside the one the panel's copy items already use. The group joins the existing ⋯ menu as the plan settles. |
| "Include internal notes" checkbox item | `MenuPrimitive.CheckboxItem` + `CheckboxItemIndicator` with `MENU_ITEM`; indicator is lucide `CheckIcon` | Same structure as `reui/dropdown-menu`'s `DropdownMenuCheckboxItem` (indicator at the end), restyled with Quincy tokens, not its `rounded-md` / `focus:bg-accent` skin. |
| All / Open only / Resolved only radios | `MenuPrimitive.RadioGroup` / `RadioItem` / `RadioItemIndicator` with `MENU_ITEM` | Same as `DropdownMenuRadioItem`; the panel's own status filter is a `ToggleGroup` in the panel and stays separate by decision 3. |
| Separator and marker count line | `MenuPrimitive.Separator` with the `bg-border` hairline; count in the label type token | Same as `DropdownMenuSeparator`. The count line has no registry equivalent (plain text). |
| Two format items with a filename preview and the EDL hint | `MenuPrimitive.Item` with `MENU_ITEM`; preview and hint are `span`s in the label type token (`text-foreground-secondary`, `text-signal-critical`) | Wrapping secondary text inside an item has no ReUI item (the registry's menu items are single-line); `overflow-wrap:anywhere` for long Unicode names. |
| "Preparing export…", empty-file and failure messages | `components/quincy/Notice` (`role` status / alert) | `c-alert-8` is an icon + title alert; `Notice` is the panel's existing inline notice (paste status, orphan notice) and keeps one look. |
| "Download FCPXML" and "Try again" actions | `components/quincy/Button` (`variant="text"`) with the panel's 44px coarse / phone min-height | Same as the orphan notice's Dismiss. |
| Trigger | unchanged: the panel's existing ⋯ (`ICON_BUTTON`), now shown for anyone who can copy or export | No new element. |

## Departures from the plan body

- Settled decision 2 overrides the body's archived refusal: an archived Project still exports, so the group stays enabled there (a test pins it). The copy items stay hidden when archived, as in 5c.
- The plan places the control in the viewer header; settled decision 6 puts it in the notes panel's ⋯ menu, which is what is built. Because the control lives in the notes panel, "hide in compare mode" has nothing to hide yet: this build's viewer has no compare mode (7c has not merged). 7c must keep the notes panel (and so this menu) out of the compare layout, or pass `exportEnabled={false}` there.
