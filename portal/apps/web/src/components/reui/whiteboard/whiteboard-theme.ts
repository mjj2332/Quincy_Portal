/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: Maps Excalidraw's CSS variables onto Quincy's tokens. Unchanged. Quincy has no dark tokens, so the Portal always passes `theme="light"`.
 */
import { useCallback, useSyncExternalStore, type RefObject } from "react"

export const WHITEBOARD_THEME = [
  // Density for the editor's own controls (properties, pickers, the phone bar):
  // 32px buttons and 16px icons; Excalidraw grows both above 1920 device pixels
  "[:root:has(&)_.excalidraw]:[--default-button-size:2rem]!",
  "[:root:has(&)_.excalidraw]:[--lg-button-size:2rem]!",
  "[:root:has(&)_.excalidraw]:[--default-icon-size:1rem]!",
  "[:root:has(&)_.excalidraw]:[--lg-icon-size:1rem]!",
  // Type and radius: the editor's two radius variables follow the --radius token
  "[:root:has(&)_.excalidraw]:[--ui-font:var(--font-sans)]!",
  "[:root:has(&)_.excalidraw]:[--border-radius-lg:var(--radius)]!",
  "[:root:has(&)_.excalidraw]:[--border-radius-md:calc(var(--radius)_-_2px)]!",
  // Surfaces: islands, panels and the sidebar sit on the neutral background and
  // part from the canvas by a 1px ring; menus and pickers take the popover token
  "[:root:has(&)_.excalidraw]:[--island-bg-color:var(--background)]!",
  "[:root:has(&)_.excalidraw]:[--popup-bg-color:var(--popover)]!",
  "[:root:has(&)_.excalidraw]:[--popup-secondary-bg-color:var(--popover)]!",
  "[:root:has(&)_.excalidraw]:[--popup-text-color:var(--popover-foreground)]!",
  "[:root:has(&)_.excalidraw]:[--sidebar-bg-color:var(--background)]!",
  "[:root:has(&)_.excalidraw]:[--sidebar-border-color:var(--border)]!",
  "[:root:has(&)_.excalidraw]:[--default-bg-color:var(--background)]!",
  "[:root:has(&)_.excalidraw]:[--color-surface-lowest:var(--background)]!",
  "[:root:has(&)_.excalidraw]:[--color-surface-low:var(--background)]!",
  "[:root:has(&)_.excalidraw]:[--color-surface-mid:var(--muted)]!",
  "[:root:has(&)_.excalidraw]:[--color-surface-high:var(--muted)]!",
  "[:root:has(&)_.excalidraw]:[--button-gray-1:var(--muted)]!",
  "[:root:has(&)_.excalidraw]:[--button-gray-2:var(--border)]!",
  "[:root:has(&)_.excalidraw]:[--button-gray-3:var(--input)]!",
  "[:root:has(&)_.excalidraw]:[--input-bg-color:transparent]!",
  "[:root:has(&)_.excalidraw]:[--input-border-color:var(--input)]!",
  // Text and icons
  "[:root:has(&)_.excalidraw]:[--color-on-surface:var(--foreground)]!",
  "[:root:has(&)_.excalidraw]:[--keybinding-color:var(--muted-foreground)]!",
  "[:root:has(&)_.excalidraw]:[--color-disabled:color-mix(in_oklab,var(--muted-foreground)_50%,transparent)]!",
  "[:root:has(&)_.excalidraw]:[--link-color:var(--primary)]!",
  "[:root:has(&)_.excalidraw]:[--color-logo-text:var(--foreground)]!",
  // Primary family: fills, hover, pressed and the selected tool
  "[:root:has(&)_.excalidraw]:[--color-primary:var(--primary)]!",
  "[:root:has(&)_.excalidraw]:[--color-primary-darker:color-mix(in_oklab,var(--primary)_80%,transparent)]!",
  "[:root:has(&)_.excalidraw]:[--color-primary-hover:color-mix(in_oklab,var(--primary)_80%,transparent)]!",
  "[:root:has(&)_.excalidraw]:[--color-brand-hover:color-mix(in_oklab,var(--primary)_80%,transparent)]!",
  "[:root:has(&)_.excalidraw]:[--color-brand-active:var(--primary)]!",
  "[:root:has(&)_.excalidraw]:[--color-primary-darkest:var(--ring)]!",
  "[:root:has(&)_.excalidraw]:[--color-primary-light:color-mix(in_oklab,var(--primary)_12%,var(--background))]!",
  "[:root:has(&)_.excalidraw]:[--color-surface-primary-container:color-mix(in_oklab,var(--primary)_12%,var(--background))]!",
  "[:root:has(&)_.excalidraw]:[--color-on-primary-container:var(--primary)]!",
  "[:root:has(&)_.excalidraw]:[--color-icon-white:var(--primary-foreground)]!",
  "[:root:has(&)_.excalidraw]:[--color-slider-track:var(--primary)]!",
  "[:root:has(&)_.excalidraw]:[--color-slider-thumb:var(--primary)]!",
  // Hairlines, fields, elevation and focus
  "[:root:has(&)_.excalidraw]:[--default-border-color:var(--border)]!",
  "[:root:has(&)_.excalidraw]:[--dialog-border-color:var(--border)]!",
  "[:root:has(&)_.excalidraw]:[--list-border-color:var(--border)]!",
  "[:root:has(&)_.excalidraw]:[--ExcTextField--border:var(--input)]!",
  "[:root:has(&)_.excalidraw]:[--ExcTextField--border-hover:var(--input)]!",
  "[:root:has(&)_.excalidraw]:[--ExcTextField--border-active:var(--ring)]!",
  "[:root:has(&)_.excalidraw]:[--ExcTextField--placeholder:var(--muted-foreground)]!",
  "[:root:has(&)_.excalidraw]:[--ExcTextField--background:transparent]!",
  // Islands (properties, the phone bar) lift like the kit's controls: a ring plus the
  // theme's shadow-sm; menus and pickers take the popover's shadow-md
  "[:root:has(&)_.excalidraw]:[--shadow-island:0_0_0_1px_color-mix(in_oklab,var(--foreground)_10%,transparent),var(--shadow-sm)]!",
  "[:root:has(&)_.excalidraw_:is(.dropdown-menu-container,.picker,.context-menu,.Toast,.ElementLinkDialog,.focus-visible-none>.Island)]:[--shadow-island:0_0_0_1px_color-mix(in_oklab,var(--foreground)_10%,transparent),var(--shadow-md)]!",
  "[:root:has(&)_.excalidraw]:[--library-dropdown-shadow:var(--shadow-island)]!",
  "[:root:has(&)_.excalidraw]:[--modal-shadow:none]!",
  "[:root:has(&)_.excalidraw]:[--sidebar-shadow:none]!",
  "[:root:has(&)_.excalidraw]:[--focus-highlight-color:color-mix(in_oklab,var(--ring)_50%,transparent)]!",
  "[:root:has(&)_.excalidraw]:[--select-highlight-color:var(--primary)]!",
  // Scrollbar fallback for the scrollers the rules below leave visible (stats, link)
  "[:root:has(&)_.excalidraw]:[--scrollbar-thumb:var(--border)]!",
  "[:root:has(&)_.excalidraw]:[--scrollbar-thumb-hover:color-mix(in_oklab,var(--muted-foreground)_50%,transparent)]!",
  // Dark only: the tints need more primary to stay apart from the muted hover
  "[:root:has(&)_.excalidraw.theme--dark]:[--color-primary-light:color-mix(in_oklab,var(--primary)_24%,var(--background))]!",
  "[:root:has(&)_.excalidraw.theme--dark]:[--color-surface-primary-container:color-mix(in_oklab,var(--primary)_24%,var(--background))]!",
  "[:root:has(&)_.excalidraw.theme--dark]:[--ExcTextField--background:color-mix(in_oklab,var(--input)_30%,transparent)]!",
  // Menus, pickers and dialogs read as popovers, with accent hover
  "[:root:has(&)_.excalidraw_:is(.dropdown-menu-container,.properties-content)]:[--island-bg-color:var(--popover)]!",
  "[:root:has(&)_.excalidraw_:is(.dropdown-menu-container,.properties-content)]:[--button-hover-bg:var(--accent)]!",
  "[:root:has(&)_.excalidraw.excalidraw-modal-container]:[--island-bg-color:var(--popover)]!",
  "[:root:has(&)_.excalidraw.excalidraw-modal-container]:[--button-hover-bg:var(--accent)]!",
  "[:root:has(&)_.excalidraw_:is(.dropdown-menu:not(.manual-hover)_.dropdown-menu-item:is(:hover,:focus-visible),.dropdown-menu-item--hovered)]:[--color-on-surface:var(--accent-foreground)]!",
  String.raw`[:root:has(&)_.excalidraw.theme--dark_:is(.App-menu\_\_left,.App-mobile-menu)]:[--button-hover-bg:var(--accent)]!`,
  String.raw`[:root:has(&)_.excalidraw_.layer-ui\_\_search-header_.ExcTextField\_\_input]:bg-muted!`,
  String.raw`[:root:has(&)_.excalidraw_.Modal\_\_background]:bg-black/10!`,
  String.raw`[:root:has(&)_.excalidraw_.Modal\_\_background]:backdrop-blur-xs!`,
  String.raw`[:root:has(&)_.excalidraw_.Modal\_\_content]:[border-radius:var(--border-radius-lg)]!`,
  // The kit's controls (whiteboard-controls.tsx) replace the editor's; its menu button
  // and tool island stay unseen, so the properties island and hints keep their offsets
  "[:root:has(&)_.excalidraw_.main-menu-trigger]:invisible!",
  "[:root:has(&)_.excalidraw_.main-menu-trigger.dropdown-menu-button--mobile]:hidden!",
  "[:root:has(&)_.excalidraw_.App-toolbar.Island]:invisible!",
  "[:root:has(&)_.excalidraw_.HintViewer]:visible!",
  "[:root:has(&)_.excalidraw_:is(.zoom-actions,.mobile-misc-tools-container)]:hidden!",
  // Undo and redo too: the kit's footer clicks these hidden buttons (0.18.1 has no API)
  "[:root:has(&)_.excalidraw_:is(.undo-redo-buttons,.App-toolbar-content>div:has(>[data-testid=button-undo]))]:hidden!",
  // The phone bar takes 44px controls (WCAG 2.5.5); set by the phone-layout predicate, never measured (#564), so widening returns 2rem
  "data-[phone-layout]:[--wb-control-size:44px]",
  "[:root:has(&)_.excalidraw_.App-bottom-bar]:[--default-button-size:var(--wb-control-size,2rem)]!",
  "[:root:has(&)_.excalidraw_.App-bottom-bar>.Island_.App-toolbar-content]:p-1!",
  "[:root:has(&)_.excalidraw_.App-bottom-bar>.Island_.App-toolbar-content]:gap-1!",
  // It keeps one control's height in view only, when the editor empties it
  "[:root:has(&)_.excalidraw_.App-bottom-bar>.Island_.App-toolbar-content]:min-h-[calc(var(--wb-control-size,2rem)+0.5rem)]!",
  // The phone bar takes the kit's control size; its buttons for a selection sit
  // between the kit's zoom and More and its undo and redo (two controls wide)
  "[:root:has(&)_.excalidraw_.App-bottom-bar>.Island_.App-toolbar-content]:justify-start!",
  "[:root:has(&)_.excalidraw_.App-bottom-bar>.Island_.App-toolbar-content]:ps-[calc(var(--wb-footer-width,0px)+0.5rem)]!",
  "[:root:has(&)_.excalidraw_.App-bottom-bar>.Island_.App-toolbar-content]:pe-[calc(var(--wb-control-size,2rem)*2+0.5rem)]!",
  // A touch screen's finalize button, shown while drawing a line, follows the footer
  String.raw`[:root:has(&)_.excalidraw_.layer-ui\_\_wrapper\_\_footer-left]:ps-[calc(var(--wb-footer-width,0px)+0.5rem)]!`,
  "[:root:has(&)_.excalidraw_.dropdown-menu-button:hover]:[--background:var(--muted)]!",
  // Menus: shadcn's DropdownMenu recipe for all. 4px inset, 28px rows, 6px sides,
  // xs muted labels and shortcuts, flush separators, accent hover and focus
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-container]:p-1!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-container]:gap-0!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item]:h-7!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item]:m-0!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item]:w-full!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item]:border-0!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item]:px-1.5!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item]:gap-1.5!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item]:text-sm!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item:focus-visible]:[box-shadow:none]!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item:focus-visible]:bg-accent!",
  // Disabled items, as shadcn's DropdownMenuItem draws them
  "[:root:has(&)_.excalidraw_.dropdown-menu-item:disabled]:opacity-50!",
  "[:root:has(&)_.excalidraw_.dropdown-menu-item:disabled]:pointer-events-none!",
  String.raw`[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item\_\_text]:gap-1.5!`,
  String.raw`[:root:has(&)_.excalidraw_.dropdown-menu_:is(.dropdown-menu-item\_\_shortcut,.dropdown-menu-item\_\_shortcut--orphaned)]:text-xs!`,
  String.raw`[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item\_\_shortcut]:tracking-widest!`,
  String.raw`[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item\_\_shortcut]:ps-4!`,
  String.raw`[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item\_\_shortcut]:opacity-100!`,
  String.raw`[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-item\_\_shortcut]:text-muted-foreground!`,
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-group-title]:text-xs!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-group-title]:font-medium!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-group-title]:text-muted-foreground!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-group-title]:m-0!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-group-title]:px-1.5!",
  "[:root:has(&)_.excalidraw_.dropdown-menu_.dropdown-menu-group-title]:py-1!",
  // The separator is an unclassed div with an inline margin
  "[:root:has(&)_.excalidraw_.dropdown-menu-container>div:not([class])]:-mx-1!",
  "[:root:has(&)_.excalidraw_.dropdown-menu-container>div:not([class])]:my-1!",
  // The context menu, on the same recipe; its checked rows mark the state with
  // a trailing check, as the Board menu's checkbox items do, never a leading glyph
  "[:root:has(&)_.excalidraw_.context-menu]:p-1!",
  "[:root:has(&)_.excalidraw_.context-menu]:border-0!",
  "[:root:has(&)_.excalidraw_.context-menu]:[border-radius:var(--border-radius-lg)]!",
  "[:root:has(&)_.excalidraw_.context-menu]:[box-shadow:var(--shadow-island)]!",
  "[:root:has(&)_.excalidraw_.context-menu-item]:flex!",
  "[:root:has(&)_.excalidraw_.context-menu-item]:items-center!",
  "[:root:has(&)_.excalidraw_.context-menu-item]:h-7!",
  "[:root:has(&)_.excalidraw_.context-menu-item]:min-w-32!",
  "[:root:has(&)_.excalidraw_.context-menu-item]:gap-1.5!",
  "[:root:has(&)_.excalidraw_.context-menu-item]:px-1.5!",
  "[:root:has(&)_.excalidraw_.context-menu-item]:py-0!",
  "[:root:has(&)_.excalidraw_.context-menu-item]:[border-radius:var(--border-radius-md)]!",
  "[:root:has(&)_.excalidraw_.context-menu-item]:text-sm!",
  "[:root:has(&)_.excalidraw_.context-menu-item:is(:hover,:focus-visible)]:[--select-highlight-color:var(--accent)]!",
  "[:root:has(&)_.excalidraw_.context-menu-item:is(:hover,:focus-visible)]:[--popup-bg-color:var(--accent-foreground)]!",
  "[:root:has(&)_.excalidraw_.context-menu-item:focus-visible]:bg-accent!",
  "[:root:has(&)_.excalidraw_.context-menu-item:focus-visible]:outline-none!",
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_label]:me-0!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_label]:flex!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_label]:flex-1!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_label]:items-center!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_label]:gap-4!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_shortcut]:text-xs!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_shortcut]:tracking-widest!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_shortcut:not(:empty)]:ps-4!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_shortcut]:opacity-100!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item\_\_shortcut]:text-muted-foreground!`,
  "[:root:has(&)_.excalidraw_.context-menu-item.checkmark]:before:hidden!",
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item.checkmark_.context-menu-item\_\_label]:after:ms-auto!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item.checkmark_.context-menu-item\_\_label]:after:size-4!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item.checkmark_.context-menu-item\_\_label]:after:shrink-0!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item.checkmark_.context-menu-item\_\_label]:after:bg-current!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item.checkmark_.context-menu-item\_\_label]:after:[content:""]!`,
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item.checkmark_.context-menu-item\_\_label]:after:[mask:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='black'%20stroke-width='2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M20%206%209%2017l-5-5'/%3E%3C/svg%3E")_right/1rem_1rem_no-repeat]!`,
  "[:root:has(&)_.excalidraw_.context-menu-item-separator]:border-border!",
  "[:root:has(&)_.excalidraw_.context-menu-item-separator]:-mx-1!",
  "[:root:has(&)_.excalidraw_.context-menu-item-separator]:my-1!",
  // Delete reads as shadcn's destructive item instead of Excalidraw's raw red
  String.raw`[:root:has(&)_.excalidraw_.context-menu-item.dangerous_.context-menu-item\_\_label]:text-destructive!`,
  "[:root:has(&)_.excalidraw_.context-menu-item.dangerous:hover]:bg-destructive/10!",
  "[:root:has(&)_.excalidraw.theme--dark_.context-menu-item.dangerous:hover]:bg-destructive/20!",
  // The editor's own toast, when no onToast takes it: a popover chip
  "[:root:has(&)_.excalidraw_.Toast]:bg-popover!",
  "[:root:has(&)_.excalidraw_.Toast]:py-2!",
  "[:root:has(&)_.excalidraw_.Toast]:text-sm!",
  "[:root:has(&)_.excalidraw_.Toast]:[border-radius:var(--border-radius-lg)]!",
  "[:root:has(&)_.excalidraw_.Toast]:[box-shadow:var(--shadow-island)]!",
  // Welcome screen and hints: our font and muted text instead of the gray ramp
  String.raw`[:root:has(&)_.excalidraw_:is(.welcome-screen-decor,.welcome-screen-menu-item,.welcome-screen-menu-item\_\_shortcut,.HintViewer,.Dialog\_\_close)]:text-muted-foreground!`,
  String.raw`[:root:has(&)_.excalidraw_.welcome-screen-menu-item:hover_.welcome-screen-menu-item\_\_text]:text-foreground!`,
  "[:root:has(&)_.excalidraw_.welcome-screen-decor]:[font-family:inherit]!",
  String.raw`[:root:has(&)_.excalidraw_.welcome-screen-menu-item\_\_icon_svg]:size-4!`,
  String.raw`[:root:has(&)_.excalidraw_:is(.ExcTextField\_\_label,.ExcTextField\_\_input_input)]:[font-family:inherit]!`,
  // The tooltip is one <body> level node outside every .excalidraw
  "[:root:has(&)_.excalidraw-tooltip]:bg-foreground!",
  "[:root:has(&)_.excalidraw-tooltip]:text-background!",
  "[:root:has(&)_.excalidraw-tooltip]:[border-radius:var(--border-radius-md)]!",
  "[:root:has(&)_.excalidraw-tooltip]:px-3!",
  "[:root:has(&)_.excalidraw-tooltip]:py-1.5!",
  "[:root:has(&)_.excalidraw-tooltip]:text-xs!",
  "[:root:has(&)_.excalidraw-tooltip]:font-normal!",
  "[:root:has(&)_.excalidraw-tooltip]:[--ui-font:var(--font-sans)]!",
  // Colour and font pickers: the popover fill, no arrow, 24px palette swatches;
  // focus-visible-none marks only the picker popover's content
  "[:root:has(&)_.excalidraw_.focus-visible-none>.Island]:[--island-bg-color:var(--popover)]!",
  "[:root:has(&)_.excalidraw_.focus-visible-none>.Island]:p-2!",
  "[:root:has(&)_.excalidraw_.focus-visible-none>span]:hidden!",
  String.raw`[:root:has(&)_.excalidraw_.color-picker\_\_button--large]:size-6!`,
  String.raw`[:root:has(&)_.excalidraw_.color-picker-content--default]:grid-cols-[repeat(5,1.5rem)]!`,
  String.raw`[:root:has(&)_.excalidraw_.library-menu-items-container\_\_header]:text-sm!`,
  String.raw`[:root:has(&)_.excalidraw_.library-menu-items-container\_\_header]:font-medium!`,
  String.raw`[:root:has(&)_.excalidraw_.library-menu-items-container\_\_header]:text-foreground!`,
  // The library's Search and Library switch at shadcn Tabs weight: a muted list,
  // the active tab on the background with foreground text
  "[:root:has(&)_.excalidraw_.default-sidebar_.sidebar-triggers]:bg-muted!",
  "[:root:has(&)_.excalidraw_.default-sidebar_.sidebar-triggers]:border-transparent!",
  "[:root:has(&)_.excalidraw_.sidebar-tab-trigger]:[--button-color:var(--muted-foreground)]!",
  "[:root:has(&)_.excalidraw_.sidebar-tab-trigger]:[--button-hover-color:var(--foreground)]!",
  "[:root:has(&)_.excalidraw_.sidebar-tab-trigger]:[--button-active-bg:var(--button-bg)]!",
  "[:root:has(&)_.excalidraw_.sidebar-tab-trigger[data-state=active]]:[--button-bg:var(--background)]!",
  "[:root:has(&)_.excalidraw_.sidebar-tab-trigger[data-state=active]]:[--button-hover-bg:var(--background)]!",
  "[:root:has(&)_.excalidraw.theme--dark_.sidebar-tab-trigger[data-state=active]]:[--button-bg:color-mix(in_oklab,var(--input)_30%,transparent)]!",
  "[:root:has(&)_.excalidraw.theme--dark_.sidebar-tab-trigger[data-state=active]]:[--button-hover-bg:color-mix(in_oklab,var(--input)_30%,transparent)]!",
  "[:root:has(&)_.excalidraw.theme--dark_.default-sidebar_.sidebar-tab-trigger[data-state=active]]:[border:1px_solid_var(--input)]!",
  "[:root:has(&)_.excalidraw_.sidebar-tab-trigger[data-state=active]]:text-foreground!",
  // Stats at popover density: a sm title, xs muted section labels and no bold row
  "[:root:has(&)_.excalidraw_.exc-stats_h2]:text-sm!",
  "[:root:has(&)_.excalidraw_.exc-stats_h2]:font-medium!",
  String.raw`[:root:has(&)_.excalidraw_.exc-stats\_\_row--heading]:font-medium!`,
  "[:root:has(&)_.excalidraw_.exc-stats_h3]:text-xs!",
  "[:root:has(&)_.excalidraw_.exc-stats_h3]:font-medium!",
  "[:root:has(&)_.excalidraw_.exc-stats_h3]:text-muted-foreground!",
  // Declutter, pinned to the 0.18.1 DOM (re-check on any upgrade): one home per
  // control; help and the library live elsewhere
  String.raw`[:root:has(&)_.excalidraw_.layer-ui\_\_wrapper\_\_footer-right]:hidden!`,
  String.raw`[:root:has(&)_.excalidraw_.sidebar-trigger\_\_label-element:has(.default-sidebar-trigger)]:hidden!`,
  // Hints only while a creation tool is active (the canvas marks the kit's tool), in
  // muted text under the tools
  "[&[data-wb-tool=selection]_.HintViewer]:hidden!",
  // One 16px glyph in every trigger: the menu and tab triggers keep a padding
  // that squeezes their icon to 12px inside the 32px box
  "[:root:has(&)_.excalidraw_:is(.dropdown-menu-button,.sidebar-tab-trigger)]:p-0!",
  "[:root:has(&)_.excalidraw_:is(.dropdown-menu-button,.sidebar-tab-trigger)_svg]:size-4!",
  "[:root:has(&)_.excalidraw_:is(.dropdown-menu-button,.sidebar-tab-trigger)_svg]:shrink-0!",
  // Excalidraw's icons draw 0.8 to 1.2px lines at 16px; stroked ones take lucide's
  // 1.33px. Filled glyphs and the fill, width and style swatches keep theirs
  "[:root:has(&)_.excalidraw_svg[focusable=false]:not([fill=currentColor],:has([fill=currentColor],[fill^=var]),[data-testid^=fill-]_svg,label:has(>[data-testid^=strokeWidth])_svg,label:has(>[name=strokeStyle])_svg)_:is(path,line,polyline,polygon,circle,ellipse,rect)]:[vector-effect:non-scaling-stroke]!",
  "[:root:has(&)_.excalidraw_svg[focusable=false]:not([fill=currentColor],:has([fill=currentColor],[fill^=var]),[data-testid^=fill-]_svg,label:has(>[data-testid^=strokeWidth])_svg,label:has(>[name=strokeStyle])_svg)_:is(path,line,polyline,polygon,circle,ellipse,rect)]:[stroke-width:1.33px]!",
  // Properties island: narrower, 28px controls, tight sections; the fade sits on
  // the inner column, since a mask on the island would clip its ring
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left]:w-44!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left]:p-0!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left]:flex!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left]:flex-col!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left]:overflow-hidden!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left>.panelColumn]:min-h-0!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left>.panelColumn]:overflow-y-auto!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left>.panelColumn]:overflow-x-hidden!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left>.panelColumn]:p-2!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left>.panelColumn]:scroll-py-10!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left>.panelColumn]:scroll-fade-y!`,
  String.raw`[:root:has(&)_.excalidraw_.App-menu\_\_left>.panelColumn]:no-scrollbar!`,
  "[:root:has(&)_.excalidraw_.App-mobile-menu]:scroll-fade-y!",
  "[:root:has(&)_.excalidraw_.App-mobile-menu]:no-scrollbar!",
  String.raw`[:root:has(&)_.excalidraw_:is(.App-menu\_\_left,.App-mobile-menu)]:[--default-button-size:1.75rem]!`,
  String.raw`[:root:has(&)_.excalidraw_:is(.App-menu\_\_left,.App-mobile-menu)_.panelColumn]:gap-y-2!`,
  String.raw`[:root:has(&)_.excalidraw_:is(.App-menu\_\_left,.App-mobile-menu)_.panelColumn_.buttonList]:gap-1!`,
  String.raw`[:root:has(&)_.excalidraw_:is(.App-menu\_\_left,.App-mobile-menu)_.panelColumn_.buttonList]:py-0!`,
  String.raw`[:root:has(&)_.excalidraw_:is(.App-menu\_\_left,.App-mobile-menu)_.panelColumn_:is(legend,h3,.control-label)]:text-muted-foreground!`,
  String.raw`[:root:has(&)_.excalidraw_:is(.App-menu\_\_left,.App-mobile-menu)_.color-picker\_\_button]:size-5!`,
  String.raw`[:root:has(&)_.excalidraw_:is(.App-menu\_\_left,.App-mobile-menu)_.color-picker\_\_button.active-color]:size-6!`,
  "[:root:has(&)_.excalidraw_.range-wrapper]:mb-1!",
  "[:root:has(&)_.excalidraw_.range-wrapper]:text-xs!",
  // Every other scroller: no browser scrollbar, a fade on the inner lists only,
  // so two fades never stack and island rings stay whole
  String.raw`[:root:has(&)_.excalidraw_:is(.library-menu-items-container\_\_items,.layer-ui\_\_search-result-container,.ScrollableList\_\_wrapper)]:scroll-fade-y!`,
  String.raw`[:root:has(&)_.excalidraw_:is(.library-menu-items-container\_\_items,.layer-ui\_\_search-result-container,.ScrollableList\_\_wrapper)]:no-scrollbar!`,
  String.raw`[:root:has(&)_.excalidraw_:is(.library-menu-items-container,.dropdown-menu-container,.Modal\_\_content)]:no-scrollbar!`,
  // The context menu's popover scrolls only once Excalidraw pins an inline
  // overflow on a short board; the fade waits for it, so the ring stays whole
  "[:root:has(&)_.excalidraw_.popover[style*=overflow]]:scroll-fade-y!",
  "[:root:has(&)_.excalidraw_.popover[style*=overflow]]:no-scrollbar!",
  "[:root:has(&)_.excalidraw_.popover[style*=overflow]]:scroll-py-10!",
  // Replaced by the embed: its skeleton is the one loading state
  "[&_.LoadingMessage]:hidden!",
  // Excalidraw's public library browser and publish flow, never yours; the empty
  // public section hides, but published items from an opened .excalidrawlib show
  "[:root:has(&)_.excalidraw_.library-menu-browse-button]:hidden!",
  // Its footer only ever holds that button: no hairline over an empty strip
  "[:root:has(&)_.excalidraw_.library-menu-control-buttons--at-bottom]:hidden!",
  "[:root:has(&)_.excalidraw_[data-testid=lib-dropdown--remove]]:hidden!",
  String.raw`[:root:has(&)_.excalidraw_.library-menu-items-container\_\_header--excal:not(:has(+.library-menu-items-container\_\_grid))]:hidden!`,
  String.raw`[:root:has(&)_.excalidraw_.library-menu-items-container\_\_header--excal+div:not(.library-menu-items-container\_\_grid)]:hidden!`,
  // Replaced by the host: presence renders in your own toolbar
  String.raw`[:root:has(&)_.excalidraw_:is(.UserList\_\_wrapper,.UserList-Wrapper)]:hidden!`,
].join(" ")

/** The canvas is cleared, so the host background shows through in both themes. */
export const CANVAS_BACKGROUND = "transparent"

/** Hairline grid colour (background="grid"): 1px lines on the Grid's cell edges.
 * whiteboard-canvas.tsx moves and fades it; exports skip it. */
export const CANVAS_GRID = [
  "[--wb-grid-line:color-mix(in_oklab,var(--foreground)_4%,transparent)]",
  "dark:[--wb-grid-line:color-mix(in_oklab,var(--foreground)_5%,transparent)]",
].join(" ")

/** Paper colour for exports; a dark export inverts it with the drawing. */
export const EXPORT_BACKGROUND = "#ffffff"

export type WhiteboardTheme = "light" | "dark" | "auto"

const getServerTheme = () => "light" as const

/**
 * Resolves "auto" from a `.dark` class on <html> or any ancestor of the board,
 * the switch the host tokens use, and follows it live when it toggles there.
 */
export function useWhiteboardTheme(
  theme: WhiteboardTheme,
  rootRef: RefObject<HTMLElement | null>
) {
  // Only the board's own ancestor chain is watched, never the busy subtree below it.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const observer = new MutationObserver(onStoreChange)
      let node: HTMLElement | null = rootRef.current ?? document.documentElement
      for (; node; node = node.parentElement) {
        observer.observe(node, { attributes: true, attributeFilter: ["class"] })
      }
      return () => observer.disconnect()
    },
    [rootRef]
  )

  const getSnapshot = useCallback(() => {
    if (theme !== "auto") return theme
    const dark =
      rootRef.current?.closest(".dark") != null ||
      document.documentElement.classList.contains("dark")
    return dark ? ("dark" as const) : ("light" as const)
  }, [theme, rootRef])

  return useSyncExternalStore(subscribe, getSnapshot, getServerTheme)
}