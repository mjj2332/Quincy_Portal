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
| "Left out" list with reasons | Hand-built `<ul>` of divided rows. Searched: `reui/item.tsx` (`Item size="xs"`) fails because its title and description carry literal `text-sm` / `text-xs` that cannot be overridden by the `[font:var(--type-*)]` shorthand (utility vs shorthand order), and `variant="outline"` draws cards, not rows matching the table; `reui/table.tsx` fails because the reasons are not columns |
| Paste / Cancel / Try again | `components/quincy/Button.tsx` (over `reui/button`) |
| Notices (stale, error, "Pasted N notes", "Copied N notes") | `components/quincy/Notice.tsx` (`caution`, `critical`, `positive`) |
| "Copied from vX · originally by …" line | `quincy/Eyebrow` `META_TEXT`, as the thread's other meta lines |
| Frame offset: Quincy adaptation (round 5) | `reui/number-field.tsx` draws its focus outline on the group (`has-[:focus-visible]`, the global rule's tokens) and sets `focus-visible:!outline-none` on the inner input |
| "None of the copied notes can be pasted onto this version." paragraph | Hand-built `<p>` with `[font:var(--type-body-sm)]`. Searched: `ui` empty-state / `reui/empty` candidates fail because this is one line inside a dialog body, not a page-level empty state; the offset field is hidden while it shows |
| Per-note tick, unticked border | `reui/checkbox.tsx` unchanged. Instance override `data-unchecked:border-[var(--control-off)]` (greige-500, 5.69:1 on the white dialog): the default `border-input` is greige-200, 1.68:1, under the 3:1 non-text minimum. Coarse-pointer hit area `pointer-coarse:after:-inset-3.5` (44px) |
| Table on phones | The same `reui/table.tsx` markup, stacked below 721px with `max-[721px]:` classes (no second DOM) |
