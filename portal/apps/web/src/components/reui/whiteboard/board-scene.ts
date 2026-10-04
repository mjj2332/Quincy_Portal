/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: Static scene content. DROPPED: the registry's demo board (`BOARD_FRAMES`, `BOARD_SKELETON`, `boardSkeleton`, the wireframe file). KEPT: the note/node/arrow/frame builders, `LIBRARY_ITEMS` (static starter shapes) and `TEMPLATE_SKELETONS`; none needs storage.
 */
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform"

import type { WhiteboardLibraryItem } from "./whiteboard"

type Skeleton = ExcalidrawElementSkeleton

/** Tailwind 200 shades, as sRGB hex like the editor's own colours. */
const PAPER = {
  yellow: "#fff085", // yellow-200
  green: "#b9f8cf", // green-200
  blue: "#bedbff", // blue-200
  red: "#ffc9c9", // red-200
  violet: "#ddd6ff", // violet-200
} as const

const INK = "#171717" // neutral-900
const WHITE = "#ffffff"
const RULE = "#d4d4d4" // neutral-300

type Size = { width: number; height: number }

// One text size (20; 16 reads under 10px at the 60% opening zoom) and one box
// per kind, fitted to its text, shared by the board, library and templates.
const TEXT_SIZE = 20
const NOTE: Size = { width: 240, height: 76 }
const QUESTION: Size = { width: 200, height: 100 }
const CHIP: Size = { width: 56, height: 36 }
const NODE: Size = { width: 120, height: 56 }
const DECISION: Size = { width: 152, height: 120 }

type NoteSpec = {
  id: string
  x: number
  y: number
  size?: Size
  color: keyof typeof PAPER
  text: string
  seed: number
}

function note({ id, x, y, size = NOTE, color, text, seed }: NoteSpec) {
  return {
    type: "rectangle",
    id,
    x,
    y,
    ...size,
    seed,
    backgroundColor: PAPER[color],
    strokeColor: "transparent",
    fillStyle: "solid",
    roughness: 0,
    roundness: { type: 3 },
    label: {
      text,
      fontSize: TEXT_SIZE,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor: INK,
    },
  } satisfies Skeleton
}

type NodeSpec = {
  id: string
  x: number
  y: number
  text: string
  seed: number
  shape?: "rectangle" | "diamond"
}

function node({ id, x, y, text, seed, shape = "rectangle" }: NodeSpec) {
  return {
    type: shape,
    id,
    x,
    y,
    ...(shape === "diamond" ? DECISION : NODE),
    seed,
    strokeColor: INK,
    backgroundColor: WHITE,
    fillStyle: "solid",
    roundness: { type: 3 },
    label: { text, fontSize: TEXT_SIZE },
  } satisfies Skeleton
}

type ArrowPoints = NonNullable<Extract<Skeleton, { type: "arrow" }>["points"]>

type ArrowSpec = {
  id: string
  from: string
  to: string
  x: number
  y: number
  seed: number
  /** Relative to x and y, starting at [0, 0]; a middle point bends the arrow. */
  points: readonly (readonly [number, number])[]
  label?: string
}

// Arrows stop 6 units short of the shapes they bind, as Excalidraw draws them.
function arrow({ id, from, to, x, y, seed, points, label }: ArrowSpec) {
  const xs = points.map(([px]) => px)
  const ys = points.map(([, py]) => py)
  return {
    type: "arrow",
    id,
    x,
    y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    // Excalidraw brands its points; these are the same plain [x, y] pairs.
    points: points as unknown as ArrowPoints,
    seed,
    strokeColor: INK,
    start: { id: from },
    end: { id: to },
    ...(label ? { label: { text: label, fontSize: TEXT_SIZE } } : {}),
  } satisfies Skeleton
}

function frame(id: string, name: string, children: readonly Skeleton[]) {
  const ids = children.flatMap((child) =>
    "id" in child && child.id ? [child.id] : []
  )
  // Children come first: Excalidraw clips a frame's content by element order.
  return [
    ...children,
    { type: "frame", id, name, children: ids } satisfies Skeleton,
  ]
}

// prettier-ignore
export const LIBRARY_ITEMS: readonly WhiteboardLibraryItem[] = [
  {
    id: "lib_sticky",
    name: "Sticky Note",
    skeleton: [note({ id: "lib_sticky_note", x: 0, y: 0, color: "yellow", seed: 2101, text: "Note" })],
  },
  {
    id: "lib_decision",
    name: "Decision",
    skeleton: [node({ id: "lib_decision_shape", x: 0, y: 0, text: "Decide?", seed: 2201, shape: "diamond" })],
  },
  {
    id: "lib_phone",
    name: "Phone Screen",
    skeleton: [
      { type: "rectangle", id: "lib_phone_body", x: 0, y: 0, width: 156, height: 312, seed: 2301, strokeColor: INK, backgroundColor: WHITE, fillStyle: "solid", roundness: { type: 3 } },
      { type: "rectangle", id: "lib_phone_bar", x: 58, y: 10, width: 40, height: 6, seed: 2302, strokeColor: "transparent", backgroundColor: RULE, fillStyle: "solid", roughness: 0, roundness: { type: 3 } },
    ],
  },
  {
    id: "lib_comment",
    name: "Comment",
    skeleton: [note({ id: "lib_comment_note", x: 0, y: 0, color: "blue", seed: 2401, text: "Comment" })],
  },
  {
    id: "lib_vote",
    name: "Vote Chip",
    skeleton: [note({ id: "lib_vote_chip", x: 0, y: 0, size: CHIP, color: "violet", seed: 2501, text: "+1" })],
  },
]

// prettier-ignore
// Templates insert with fresh ids, so the same one can land twice.
export const TEMPLATE_SKELETONS = {
  tpl_retro: frame("tpl_retro_frame", "Retro", [
    note({ id: "tpl_retro_well", x: 0, y: 0, color: "green", seed: 3101, text: "Went well" }),
    note({ id: "tpl_retro_improve", x: 256, y: 0, color: "red", seed: 3102, text: "To improve" }),
    note({ id: "tpl_retro_actions", x: 512, y: 0, color: "blue", seed: 3103, text: "Action items" }),
  ]),
  tpl_flow: [
    node({ id: "tpl_flow_start", x: 0, y: 0, text: "Start", seed: 3201 }),
    node({ id: "tpl_flow_step", x: 200, y: 0, text: "Step", seed: 3202 }),
    node({ id: "tpl_flow_end", x: 400, y: 0, text: "Finish", seed: 3203 }),
    arrow({ id: "tpl_flow_a1", from: "tpl_flow_start", to: "tpl_flow_step", x: 126, y: 28, points: [[0, 0], [68, 0]], seed: 3211 }),
    arrow({ id: "tpl_flow_a2", from: "tpl_flow_step", to: "tpl_flow_end", x: 326, y: 28, points: [[0, 0], [68, 0]], seed: 3212 }),
  ],
  tpl_matrix: frame("tpl_matrix_frame", "Impact vs Effort", [
    note({ id: "tpl_matrix_wins", x: 0, y: 0, color: "green", seed: 3301, text: "Quick wins" }),
    note({ id: "tpl_matrix_bets", x: 256, y: 0, color: "blue", seed: 3302, text: "Big bets" }),
    note({ id: "tpl_matrix_later", x: 0, y: 92, color: "yellow", seed: 3303, text: "Later" }),
    note({ id: "tpl_matrix_skip", x: 256, y: 92, color: "red", seed: 3304, text: "Skip" }),
  ]),
  tpl_journey: frame("tpl_journey_frame", "Journey", [
    note({ id: "tpl_journey_discover", x: 0, y: 0, color: "violet", seed: 3401, text: "Discover" }),
    note({ id: "tpl_journey_choose", x: 256, y: 0, color: "violet", seed: 3402, text: "Choose" }),
    note({ id: "tpl_journey_pay", x: 512, y: 0, color: "violet", seed: 3403, text: "Pay" }),
    note({ id: "tpl_journey_track", x: 768, y: 0, color: "violet", seed: 3404, text: "Track" }),
  ]),
} satisfies Record<string, readonly Skeleton[]>

export type TemplateId = keyof typeof TEMPLATE_SKELETONS