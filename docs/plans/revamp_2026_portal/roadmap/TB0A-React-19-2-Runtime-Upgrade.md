# TB0A — React 19.2 Runtime Upgrade

**Primary user outcome:** Quincy runs on the latest stable React 19.2 patch with unchanged intended product behavior and visual output.

**Sequence:** after TB0, before TB0B/TB1  
**Schema:** none expected  
**Deployment:** app Worker only

## Version contract

At implementation time:

- recheck npm and pin the latest stable exact `react@19.2.x` and identical `react-dom` patch;
- pin latest compatible exact React 19.2 type packages;
- as of 2026-08-22 the current stable React package is `19.2.8`;
- commit/review lockfile;
- no canary/RC/caret/unbounded latest range.

## Scope

- Reviewed official React 19 migration and TypeScript codemods.
- Direct fixes for remaining removed API/type/runtime issues.
- Keep `createRoot`, StrictMode, modern JSX transform, Vite SPA, custom router.
- Minimum supporting dependency updates only after a demonstrated blocker.
- Audit render-error test assumptions and retain React defaults unless a real reporting sink exists.
- Record bundle deltas and focused before/after visual parity.

## Explicit non-goals

- React Compiler.
- SSR/Server Components/hydration/Partial Pre-rendering.
- `Activity`, Actions/form rewrite, `useEffectEvent` sweep, ref-as-prop rewrite.
- router/framework migration.
- Tailwind/shadcn setup.
- product redesign.

## Verification focus

- all existing automated gates;
- zero reviewed React warnings;
- mount/unmount/effects/timers/subscriptions;
- callback/object refs and generated IDs;
- portals/focus/Escape/return;
- Tiptap/mentions;
- Lightbox/LazyImage/PhotoGrid;
- Collaboration/checklist/dnd-kit;
- sign-in/routing/Dashboard/Workspace/Admin/notice/notifications;
- desktop/compact/phone representative evidence.

## Rollback

Re-deploy the previous app Worker/web bundle. No data/schema rollback. Do not combine production deployment with TB1.

## Acceptance

- exact React 19.2 pins and reviewed lockfile;
- full gate green;
- local authenticated workflows and passive production smoke pass;
- no intended visual/product change;
- compatibility findings recorded;
- TB0A accepted before TB0B/TB1.
