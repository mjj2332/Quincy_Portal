# Research — React 19.2, Tailwind CSS v4 and shadcn

**Conclusion:** Strong fit as Quincy's incremental runtime/UI platform when React compatibility and design convergence are proved in separate releases.  
**Official-source recheck:** 2026-08-22

## React 19.2

- Quincy is currently on React 18.3.1, the warning bridge recommended by React before upgrading to 19.
- Current root already uses `createRoot`, StrictMode, and the modern JSX transform.
- React 19 still includes breaking runtime/type changes: removed deprecated APIs, changed render-error reporting, stricter ref callback/type behavior, and required initial values for `useRef` in the React 19 type definitions.
- Official migration/runtime and TypeScript codemods exist but require review.
- The current stable React package is `19.2.8` as of this recheck.

Recommendation:

- TB0A upgrades to the latest stable exact `19.2.x` patch at implementation time;
- keep React DOM on the identical patch and compatible exact type packages;
- retain StrictMode and the Vite SPA;
- minimum supporting dependency changes only;
- no React Compiler, SSR, Server Components, or new-feature refactor in the compatibility release.

Official sources:

- https://react.dev/blog/2024/04/25/react-19-upgrade-guide
- https://react.dev/blog/2025/10/01/react-19-2
- https://registry.npmjs.org/react/latest

## Tailwind CSS v4

- first-party Vite plugin;
- CSS-first configuration and automatic source detection;
- normal all-in-one import includes Preflight;
- theme/utilities can be imported without Preflight;
- official browser floor: Chrome 111, Safari 16.4, Firefox 128.

Recommendation:

- use `@tailwindcss/vite`;
- keep one CSS entry;
- disable Preflight initially and retain Quincy base styles;
- map existing tokens into semantic Tailwind variables;
- accept official browser floor for this closed internal product.

Official sources:

- https://tailwindcss.com/blog/tailwindcss-v4
- https://tailwindcss.com/docs/preflight
- https://tailwindcss.com/docs/compatibility

## shadcn

Current facts:

- source-owned generated components;
- `components.json` controls style, paths, base color, CSS variables, prefix, aliases, RSC/TSX, icon library, and registries;
- Tailwind v4 config path is blank and CSS path points to the real entry;
- CSS variables are recommended;
- Base UI is the default for new projects; Radix remains supported;
- React Aria is also a first-class option;
- Sera is an editorial, typography-led, square-cornered scaffold;
- initialization choices are expensive to change after generation.

Selected Quincy contract:

- Base UI first; React Aria/Radix only after a measured blocker;
- Sera scaffold;
- Lucide icons;
- neutral generated base replaced/mapped through Quincy semantic values;
- CSS variables, no prefix, app-local aliases/locations;
- no third-party registries initially;
- no bulk component install;
- generated source is first-party reviewed code;
- stock Sera/shadcn appearance is not acceptance.

Official sources:

- https://ui.shadcn.com/docs
- https://ui.shadcn.com/docs/components-json
- https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default
- https://ui.shadcn.com/docs/changelog/2026-07-react-aria
- https://ui.shadcn.com/docs/changelog/2026-04-sera

## Quincy fit and risk controls

Advantages:

- editable source and no UI vendor lock-in;
- semantic token bridge;
- reusable accessibility-heavy primitives;
- incremental migration;
- consistent agent/human component APIs.

Risks:

- stock framework aesthetic;
- class-string sprawl;
- global Preflight regressions;
- generated-source maintenance;
- primitive-base mixing;
- runtime-upgrade and UI-tooling regressions becoming hard to distinguish.

Controls:

- React TB0A before Tailwind TB1;
- separate pipeline TB0B before UI work;
- fixed matched evidence and drift register;
- one styling owner;
- only active-bullet components;
- focused CSS retained where clearer;
- no dark mode or whole-app conversion.
