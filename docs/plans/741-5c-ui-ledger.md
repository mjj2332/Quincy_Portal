# #741 5c-ui reuse ledger

One line per new UI element. No hand-built element: no raw `<button>`, `<input>`, `<table>` or widget role outside `components/reui/` and `components/quincy/`.

| Element | Uses |
|---|---|
| Notes menu "⋯" (Copy shown notes, Paste N notes from vX…) | `components/quincy/menu.tsx` (`Menu`, `MenuPrimitive.Item`, `MENU_ITEM`) with `quincy/icon-button` `ICON_BUTTON`, composed as the note "⋯" in `VideoNoteThread` |
| Paste dialog shell, header, footer | `components/reui/dialog.tsx` (base-nova `dialog`), already installed |
| Frame offset field | `@reui/number-field`, vendored through the sandbox into `components/reui/number-field.tsx` (scrub area dropped, skin per `reui-skin.guard`); label `components/reui/label.tsx` |
| Notes table (tick, note, source TC, new TC) | `components/reui/table.tsx` |
| Per-note tick | `components/reui/checkbox.tsx` (Base UI `Checkbox`, renders a `role="checkbox"` span, allowlist-exempt inside `reui/`) |
| Visibility badge per row | `VisibilityBadge` in `VideoNoteThread` (`quincy/StatusPill`), exported and reused: render-only, so visibility cannot be changed |
| "Left out" list with reasons | `components/reui/item.tsx` (`ItemGroup`, `Item size="xs"`), as the Version details rows |
| Paste / Cancel / Try again | `components/quincy/Button.tsx` (over `reui/button`) |
| Notices (stale, error, "Pasted N notes", "Copied N notes") | `components/quincy/Notice.tsx` (`caution`, `critical`, `positive`) |
| "Copied from vX · originally by …" line | `quincy/Eyebrow` `META_TEXT`, as the thread's other meta lines |
