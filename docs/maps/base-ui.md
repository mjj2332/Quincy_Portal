Answers: Base UI facts agents otherwise reverse-engineer from node_modules — package layout, open-change reasons, Menu `anchor`, focus return, nested dialogs.

Installed: `"version": "1.7.0"` portal/node_modules/@base-ui/react/package.json:3. **Read the bundled docs first:** `portal/node_modules/@base-ui/react/docs/react/components/` has one Markdown page per component (`menu.md`, `dialog.md`, `popover.md` …), API tables included.

## Layout
- CommonJS package (`"type": "commonjs"` portal/node_modules/@base-ui/react/package.json:60); no `esm/` dir. Every directory holds `.js` + `.d.ts` (require) beside `.mjs` + `.d.mts` (import), e.g. `portal/node_modules/@base-ui/react/menu/root/` (`MenuRoot.js`, `MenuRoot.mjs`, `MenuRoot.d.ts`, `MenuRoot.d.mts`). Conditions: `"exports"` portal/node_modules/@base-ui/react/package.json:61.
- One dir per component, a sub-dir per part. `Menu` = `index.parts` re-exports: `MenuPositioner as Positioner` portal/node_modules/@base-ui/react/menu/index.parts.d.ts:11, `MenuRoot as Root` portal/node_modules/@base-ui/react/menu/index.parts.d.ts:15.
- Floating UI is vendored at `portal/node_modules/@base-ui/react/floating-ui-react/` and is **not** exported, so `FloatingFocusManager` props are reachable only through popup props below.

## Open-change reasons (`eventDetails.reason`)
- Single source of the literals: portal/node_modules/@base-ui/react/internals/reason-parts.js — `'none'` portal/node_modules/@base-ui/react/internals/reason-parts.js:7, `'trigger-press'` portal/node_modules/@base-ui/react/internals/reason-parts.js:8, `'trigger-hover'` portal/node_modules/@base-ui/react/internals/reason-parts.js:9, `'trigger-focus'` portal/node_modules/@base-ui/react/internals/reason-parts.js:10, `'outside-press'` portal/node_modules/@base-ui/react/internals/reason-parts.js:11, `'item-press'` portal/node_modules/@base-ui/react/internals/reason-parts.js:12, `'close-press'` portal/node_modules/@base-ui/react/internals/reason-parts.js:13, `'focus-out'` portal/node_modules/@base-ui/react/internals/reason-parts.js:25, `'escape-key'` portal/node_modules/@base-ui/react/internals/reason-parts.js:26, `'list-navigation'` portal/node_modules/@base-ui/react/internals/reason-parts.js:28, `'cancel-open'` portal/node_modules/@base-ui/react/internals/reason-parts.js:34, `'sibling-open'` portal/node_modules/@base-ui/react/internals/reason-parts.js:35, `'imperative-action'` portal/node_modules/@base-ui/react/internals/reason-parts.js:39 (the file also has input/slider/toast reasons).
- Type callbacks with the per-component union, not `string`: `MenuRootChangeEventReason` portal/node_modules/@base-ui/react/menu/root/MenuRoot.d.ts:111 (namespaced `Menu.Root.ChangeEventReason` / `ChangeEventDetails` portal/node_modules/@base-ui/react/menu/root/MenuRoot.d.ts:137), `DialogRootChangeEventReason` portal/node_modules/@base-ui/react/dialog/root/DialogRoot.d.ts:85, `PopoverRootChangeEventReason` portal/node_modules/@base-ui/react/popover/root/PopoverRoot.d.ts:84.
- Details carry `reason`, a per-reason `event`, `cancel` portal/node_modules/@base-ui/react/internals/createBaseUIEventDetails.d.ts:55, `allowPropagation()`, `isCanceled`.

## Menu `anchor`
`MenuPositionerProps` portal/node_modules/@base-ui/react/menu/positioner/MenuPositioner.d.ts:37 extends the shared positioning params; `anchor?: Element | null | VirtualElement | RefObject | (() => …)`, default the trigger: `anchor` portal/node_modules/@base-ui/react/internals/useAnchorPositioning.d.ts:79.

## Focus: `closeOnFocusOut`, `finalFocus` → `returnFocus`
| Fact | Where |
|---|---|
| `closeOnFocusOut` defaults `true` | `closeOnFocusOut = true` portal/node_modules/@base-ui/react/floating-ui-react/components/FloatingFocusManager.js:127 |
| Dialog derives it from `disablePointerDismissal`; Menu/Popover leave the default | `closeOnFocusOut: !disablePointerDismissal` portal/node_modules/@base-ui/react/dialog/popup/DialogPopup.js:93 |
| `returnFocus` defaults `true` | `returnFocus = true` portal/node_modules/@base-ui/react/floating-ui-react/components/FloatingFocusManager.js:124 |
| Public prop is `finalFocus` on each Popup, forwarded as `returnFocus` | `returnFocus: finalFocus` portal/node_modules/@base-ui/react/dialog/popup/DialogPopup.js:95, `returnFocus: finalFocus` portal/node_modules/@base-ui/react/popover/popup/PopoverPopup.js:109, `returnFocus: finalFocus` portal/node_modules/@base-ui/react/menu/popup/MenuPopup.js:114 |
| Menu default: top-level and context menus return focus; a submenu without an active trigger does not | `returnFocus` portal/node_modules/@base-ui/react/menu/popup/MenuPopup.js:105 |
| A `finalFocus` function returning `undefined` or `false` means **no** return; `null`/`true` mean the default target | `resolvedReturnFocusValue === undefined` portal/node_modules/@base-ui/react/floating-ui-react/components/FloatingFocusManager.js:469 |
| Default target: trigger if still connected, else the element focused before open; an unmounted trigger is skipped | `domReference?.isConnected` portal/node_modules/@base-ui/react/floating-ui-react/components/FloatingFocusManager.js:475 |
| Return happens in a microtask at unmount; a default return is skipped if focus already left the floating tree | `queueMicrotask` portal/node_modules/@base-ui/react/floating-ui-react/components/FloatingFocusManager.js:496 |
| `finalFocus` receives only the close interaction type, never the reason | `finalFocus` portal/node_modules/@base-ui/react/dialog/popup/DialogPopup.d.ts:34 |

- A popup/sheet container that `initialFocus` lands on needs `focus-visible:!outline-none` (base.css's unlayered ring would outline it): docs/lessons.md § "A programmatically focused container rings"; pinned by portal/apps/web/src/components/quincy/container-focus.guard.test.ts.

## Nested dialogs
- "Nested" means a parent `Dialog.Root` in the React tree, not the DOM: `nested` portal/node_modules/@base-ui/react/dialog/root/useRenderDialogRoot.js:37.
- A nested `Dialog.Backdrop` renders nothing unless `forceRender`: `forceRender || !nested` portal/node_modules/@base-ui/react/dialog/backdrop/DialogBackdrop.js:48. `AlertDialog.Backdrop` is the same component: `DialogBackdrop as Backdrop` portal/node_modules/@base-ui/react/alert-dialog/index.parts.d.ts:2.
- Popup exposes `data-nested` portal/node_modules/@base-ui/react/dialog/popup/DialogPopupDataAttributes.d.ts:21, `data-nested-dialog-open` portal/node_modules/@base-ui/react/dialog/popup/DialogPopupDataAttributes.d.ts:25, and `--nested-dialogs` portal/node_modules/@base-ui/react/dialog/popup/DialogPopupCssVars.d.ts:6.
- A modal dialog's outside press closes it only on its own backdrop: `disablePointerDismissal` portal/node_modules/@base-ui/react/dialog/root/useDialogRoot.js:64.

## In this repo
- Every page sits inside the shell's Sheet, so every dialog is nested: `forceRender` portal/apps/web/src/components/reui/alert-dialog.tsx:71, `forceRender` portal/apps/web/src/components/quincy/ProjectSheet.tsx:155.
- `"outside-press"` portal/apps/web/src/components/quincy/ProjectSheet.tsx:132 branches on the reason.
- `anchor` portal/apps/web/src/components/quincy/menu.tsx:182; `finalFocus() ?? true` portal/apps/web/src/components/quincy/menu.tsx:187 so an `undefined` return is not read as `false`.
- `finalFocus={binding.returnFocus}` portal/apps/web/src/components/board/card-menu.tsx:91 (pending-move gate).

Lessons: docs/lessons.md § "Floating-UI focus restoration on Escape must be synchronous"; § "Adopting base-nova's sidebar" (`finalFocus` undefined = false); § "The Project sheet: four traps" (`forceRender`); § "`RestoreFocus` is keyboard-only"; § "A focus test can pass because something else restored focus"; § "Calendar and Timeline item menu (#463)"; § "The Project discussion composer is" (`finalFocus` is not told why).

Last verified against 495766e9
