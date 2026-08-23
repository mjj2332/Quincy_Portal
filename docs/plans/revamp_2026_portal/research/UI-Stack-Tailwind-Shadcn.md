# Research — React 19.2, Tailwind CSS v4 and shadcn

**Conclusion:** Strong fit as Quincy's incremental runtime/UI platform when React compatibility and design convergence are proved in separate releases. TB5C later adds one specialized FullCalendar official shadcn-registry exception.  
**Official-source recheck:** 2026-08-24

## React 19.2

Quincy is currently React 18.3.1 with `createRoot`, StrictMode and modern JSX. TB0A rechecks/pins the latest stable exact React `19.2.x` patch with matching React DOM and compatible exact type packages; minimum supporting dependency changes only; no Compiler/SSR/RSC/product refactor collateral.

Official sources:

- https://react.dev/blog/2024/04/25/react-19-upgrade-guide
- https://react.dev/blog/2025/10/01/react-19-2
- https://registry.npmjs.org/react/latest

## Tailwind CSS v4

Use `@tailwindcss/vite`, CSS-first configuration, one CSS entry and semantic token mapping. Disable Preflight initially and retain Quincy base styles. Accept the official browser floor already recorded by the package.

Official sources:

- https://tailwindcss.com/blog/tailwindcss-v4
- https://tailwindcss.com/docs/preflight
- https://tailwindcss.com/docs/compatibility

## shadcn baseline

Selected Quincy contract:

- Base UI first; React Aria/Radix only after measured blocker;
- Sera scaffold;
- Lucide;
- semantic CSS variables mapped to Quincy;
- app-local aliases/locations;
- no bulk component install;
- generated source is first-party reviewed code;
- stock shadcn/Sera appearance is not acceptance;
- dark mode excluded.

TB1 begins with **no third-party registries**.

Official sources:

- https://ui.shadcn.com/docs
- https://ui.shadcn.com/docs/components-json
- https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default
- https://ui.shadcn.com/docs/changelog/2026-07-react-aria
- https://ui.shadcn.com/docs/changelog/2026-04-sera

## TB5C specialized registry exception

After TB1 establishes the ordinary Base UI/Sera platform, TB5C may add **FullCalendar's official shadcn registry** for the Production Calendar. This exception is narrow:

- it does not authorize arbitrary registries;
- it does not replace Base UI as the ordinary primitive base;
- inspect generated source/dependencies before adoption;
- replace/wrap demo or incompatible ordinary primitives with Quincy-owned components;
- FullCalendar remains a scheduling engine, not visual authority;
- compare and pin the least-drift official flavor with matched Quincy evidence.

See [`Production-Calendar-FullCalendar-Shadcn.md`](./Production-Calendar-FullCalendar-Shadcn.md).

Official source:

- https://fullcalendar.io/docs/shadcn

## Risk controls

- React TB0A before Tailwind TB1;
- separate pipeline TB0B before UI work;
- fixed evidence/drift register;
- one styling owner;
- only active-bullet components;
- focused CSS retained where clearer;
- registry exception reviewed at its owning bullet;
- no whole-app conversion.
