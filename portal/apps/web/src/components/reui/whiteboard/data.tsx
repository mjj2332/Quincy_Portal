/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: Static icons and templates. DROPPED: the demo people, board, viewers and seeded versions (they belong to `presence`/`history-tab`, #499/#500) and the toast icons. KEPT: `TEMPLATES`, `MENU_ICONS`, `FRAME_ICON_FALLBACK`.
 */
import type { TemplateId } from "./board-scene"
import { KanbanIcon, RouteIcon, LayoutGridIcon, FlagIcon, UploadIcon, SaveIcon, Trash2Icon, BookOpenIcon, LayersIcon } from "lucide-react"

/** Frames someone draws get a neutral glyph. */
export const FRAME_ICON_FALLBACK = (
  <LayersIcon aria-hidden="true" />
)

export type Template = {
  id: TemplateId
  name: string
  description: string
  icon: React.JSX.Element
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "tpl_retro",
    name: "Retro Board",
    description: "Wins, fixes and actions",
    icon: (
      <KanbanIcon aria-hidden="true" />
    ),
  },
  {
    id: "tpl_flow",
    name: "User Flow",
    description: "Steps joined by arrows",
    icon: (
      <RouteIcon aria-hidden="true" />
    ),
  },
  {
    id: "tpl_matrix",
    name: "Impact Matrix",
    description: "Impact against effort",
    icon: (
      <LayoutGridIcon aria-hidden="true" />
    ),
  },
  {
    id: "tpl_journey",
    name: "Journey Map",
    description: "Discover to track",
    icon: (
      <FlagIcon aria-hidden="true" />
    ),
  },
]

// prettier-ignore
export const MENU_ICONS = {
  open: <UploadIcon aria-hidden="true" />,
  save: <SaveIcon aria-hidden="true" />,
  clear: <Trash2Icon aria-hidden="true" />,
  library: <BookOpenIcon aria-hidden="true" />,
}
