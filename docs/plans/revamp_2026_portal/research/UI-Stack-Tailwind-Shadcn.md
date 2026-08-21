# Research — Tailwind CSS v4 and shadcn

**Conclusion:** Strong fit as Quincy's incremental UI platform, with deliberate token mapping and global-reset control.

## Findings

### Tailwind v4

- Provides a first-party Vite plugin (`@tailwindcss/vite`).
- Uses CSS-first configuration and automatic source detection.
- Can explicitly add sources through `@source` when necessary.
- `@import "tailwindcss"` includes Preflight by default.
- Preflight can be disabled by importing theme/utilities without `preflight.css`.
- Tailwind v4 requires a modern browser baseline that must be accepted by the product owner.

### shadcn

- Distributes editable source code rather than hiding all implementation behind a package.
- `components.json` configures generation paths, CSS variables, prefix, base color, style and aliases.
- For Tailwind v4, the Tailwind config path is blank and the CSS path points to the real global stylesheet.
- CSS-variable theming is recommended.
- Some initialization choices are expensive to change after component generation.
- As of July 2026, Base UI is the default for new shadcn projects; Radix remains supported.
- Current components cover ordinary controls needed by Quincy, including fields, menus, dialogs, popovers, sheets and calendar/date-picker building blocks.

## Quincy fit

Advantages:

- source ownership aligns with no vendor UI lock-in;
- Tailwind can express Quincy tokens rather than a stock theme;
- generated components reduce repeated accessibility-heavy primitives;
- consistent component APIs are useful for human and agent development;
- incremental migration is possible.

Risks:

- stock shadcn aesthetic can erase Quincy identity;
- class strings can become another form of sprawl;
- generated code requires ongoing merge/review discipline;
- Preflight can globally change unrelated production surfaces;
- newest template assumptions must be tested against React 18 and the current toolchain;
- Base UI/Radix mixing can create duplicate primitives.

## Recommendation

- Tailwind v4 + shadcn approved as direction.
- Use Vite plugin.
- Disable Preflight initially.
- Map existing tokens to semantic variables.
- Start app-local.
- Add only components required by TB1.
- Test Base UI first; keep Radix alternative open until overlay behavior is proven.
- Keep React 18 during the UI foundation unless compatibility testing proves a separate upgrade is required.

## Official sources

- https://tailwindcss.com/blog/tailwindcss-v4
- https://tailwindcss.com/docs/preflight
- https://tailwindcss.com/docs/upgrade-guide
- https://ui.shadcn.com/docs
- https://ui.shadcn.com/docs/components-json
- https://ui.shadcn.com/docs/tailwind-v4
- https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default
- https://ui.shadcn.com/docs/changelog/2026-03-cli-v4
