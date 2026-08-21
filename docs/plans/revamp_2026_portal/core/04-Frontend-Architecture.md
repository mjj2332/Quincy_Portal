# Frontend Architecture

**Status:** Proposed technical contract for the UI platform  
**Related:** [UI research](../research/UI-Stack-Tailwind-Shadcn.md), [TB1](../roadmap/TB1-Tailwind-Shadcn-Foundation.md)

## 1. Architecture objective

Adopt Tailwind CSS v4 and source-owned shadcn components without replacing Quincy's brand or forcing an application-wide rewrite.

```text
Feature/domain components
  ├── components/quincy/        recurring branded composites
  ├── components/ui/            generic shadcn-generated primitives
  ├── feature-local components  domain workflows
  └── focused CSS               complex/specialized layouts where clearer
          │
          ▼
Tailwind v4 semantic theme + existing Quincy source tokens
```

## 2. Proposed directory model

```text
portal/apps/web/
  components.json
  src/
    components/
      ui/
        button.tsx
        input.tsx
        field.tsx
        dropdown-menu.tsx
        dialog.tsx
        popover.tsx
        ...
      quincy/
        project-field.tsx
        destructive-action.tsx
        project-card.tsx
        ...
      existing feature folders/
    features/
      discussions/
      notifications/
      kanban/
    lib/
      utils.ts
      queries/
      dates/
    styles/
      index.css
      fonts.css
      tokens/
      app.css or legacy.css
```

Start app-local. Do not create a shared UI package without a real second app consumer.

## 3. Tailwind v4 integration

Proposed integration:

- `tailwindcss` and `@tailwindcss/vite` pinned at the `portal/` root.
- Add the Tailwind Vite plugin to the existing web config.
- Use v4 CSS-first theme configuration.
- Do not add a v3-style `tailwind.config.js` unless later required by an approved blocker.
- Keep one global CSS entry imported by `main.tsx`.
- Verify automatic source detection includes app source and generated components but not prototype/build output.

## 4. Preflight policy

Recommended initial policy: **disable Tailwind Preflight**.

Quincy already has a base/reset layer. Full Preflight removes default margins, resets borders, unstyles headings/lists and changes media behavior globally. Enabling it during the first component proof would obscure whether regressions came from the component or a global reset.

Initial import should include the Tailwind theme and utilities but omit `preflight.css`. A later dedicated whole-app decision may enable it after an explicit diff and visual/accessibility audit.

## 5. Semantic token bridge

Existing Quincy values remain the source during migration. Map them to semantic variables such as:

```text
--background
--foreground
--card
--card-foreground
--popover
--popover-foreground
--primary
--primary-foreground
--secondary
--secondary-foreground
--muted
--muted-foreground
--accent
--accent-foreground
--destructive
--border
--input
--ring
--radius
--positive
--caution
--information
```

Expose them through Tailwind v4 theme mappings so feature code uses semantic utilities:

```text
bg-background
text-foreground
border-border
text-muted-foreground
bg-destructive
ring-ring
```

Avoid raw framework palettes and arbitrary brand hex values in feature JSX.

## 6. shadcn ownership

shadcn-generated source is first-party Quincy code.

Rules:

- review every generated file and dependency;
- add only components required by the active tracer bullet;
- never run a bulk `add --all` migration;
- commit/preserve local customizations before update/overwrite operations;
- inspect upstream diffs before replacing generated components;
- use official registry components initially;
- third-party registries require explicit source/dependency/security review;
- no component may contain feature API calls or authorization rules.

## 7. Proposed `components.json` choices

Must be finalized in TB0 before initialization:

- `rsc: false`;
- `tsx: true`;
- Tailwind config path blank for v4;
- CSS path pointing to the actual global stylesheet;
- CSS variables enabled;
- aliases matching both TypeScript and Vite;
- `ui` under `src/components/ui`;
- `utils` under `src/lib/utils`;
- Base UI or Radix selected once;
- one style/base-color/icon combination selected deliberately.

Base UI is the current recommendation; Radix remains a valid alternative if the overlay proof demonstrates a benefit.

## 8. Component layers

### Generic primitives: `components/ui`

- Button, Input, Textarea, Label, Field, Dialog, Dropdown Menu, Popover, Select, Checkbox, Tabs, Sheet and similar.
- Generic variants only.
- Native semantics and refs/props remain available.
- No domain access or API behavior.

### Quincy composites: `components/quincy`

- Repeated product patterns with Quincy naming and visual rules.
- Can combine primitives.
- Examples: project field, metadata trigger, destructive confirmation, project card shell.
- Created only after one clear contract or two real consumers justify them.

### Feature components

- Data queries/mutations.
- Access-aware behavior.
- Draft state.
- Feature-specific focus handoff.
- Domain composition.

## 9. Utility-class discipline

Tailwind must not replace `app.css` debt with repeated unreadable strings.

Create a component/variant when a class combination is a repeated semantic pattern. Keep focused CSS when it is clearer for:

- media/lightbox geometry;
- annotation/canvas layers;
- complex keyframes;
- Tiptap internals;
- interaction states difficult to express readably;
- specialized grids or stacking contexts.

The objective is explicit ownership and less coupling, not 100% Tailwind coverage.

## 10. Coexistence during migration

Each element has one clear styling owner:

- untouched surface: legacy CSS;
- migrated primitive/control: Tailwind/shadcn;
- specialized retained surface: focused owned CSS.

Delete obsolete selectors only when their last consumer migrates. Do not convert all `app.css` in one release.

## 11. Server-state provider

TanStack Query is proposed for route-aware server state beginning in TB2.

Do not convert every component immediately. Establish one provider and a query-key factory, then migrate one feature at a time.

UI state remains ordinary React state when it is local and ephemeral:

- open dialog;
- unsaved editor draft;
- active drag;
- local filter input;
- lightbox index.

Server state belongs in route/resource-keyed queries.

## 12. Routing

Keep the typed custom router initially.

The route layer decides what resource/context is displayed. The query layer decides how the associated server data is cached, refreshed and invalidated.

A router-library evaluation is justified only when nested route matching, loaders, pending states or typed search parameters become materially costly—not merely because deep links exist.

## 13. Specialized libraries

- Keep Tiptap v3 for rich text.
- Keep dnd-kit for sortable behavior unless the board proof exposes a measured limitation.
- Keep Floating UI for existing/specialized overlays until migrated individually.
- Do not pre-install MUI X; evaluate only inside the date/time slice.
- Do not add a form library as part of the styling foundation.

## 14. Accessibility

Generated primitives are not sufficient evidence. Test actual Quincy compositions for:

- focus and Escape behavior;
- focus return;
- outside pointer/focus;
- nested portals;
- collaboration-panel clipping;
- labels/errors;
- icon names;
- menu keyboard behavior;
- reduced motion;
- phone-width reachability.

## 15. First UI proof

TB1 should install the foundation and migrate only one bounded ProjectFields section. It must prove:

- token fidelity;
- build/source detection;
- Preflight policy;
- generated-code maintainability;
- field accessibility;
- legacy coexistence;
- bundle/CSS impact.

No wider migration proceeds until that checkpoint is accepted.
