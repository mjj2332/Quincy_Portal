/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: The Frames tab. Edit: the registry mapped its demo frames' ids to bespoke icons; every Project frame now takes the neutral `FRAME_ICON_FALLBACK`.
 */
import { useState } from "react"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/reui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/reui/input-group"
import { Kbd } from "@/components/reui/kbd"
import {
  PanelList,
  PanelRow,
  PanelRowSkeletons,
  PanelScroll,
} from "./board-panel"
import { FRAME_ICON_FALLBACK } from "./data"
import type { BoardFrame } from "./export-dialog"
import type { WhiteboardScene } from "./whiteboard"
import { TypeIcon, Maximize2Icon, SearchIcon, XIcon } from "lucide-react"

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`

// #498: the registry mapped its demo frames' ids to bespoke icons; a Project's frames all get the neutral one.
const frameIcon = (_id: string) => FRAME_ICON_FALLBACK

const TEXT_ICON = (
  <TypeIcon aria-hidden="true" />
)

type Match = {
  /** The element a result reveals: a frame, a shape for its label, or free text. */
  target: string
  text: string
  place: string
  icon: React.ReactNode
}

/** Frame names and board text that contain the query, one result per target. */
function findMatches(
  elements: WhiteboardScene["elements"],
  frameNames: Readonly<Record<string, string>>,
  needle: string
) {
  const byId = new Map(elements.map((element) => [element.id, element]))
  const seen = new Set<string>()
  const matches: Match[] = []
  for (const element of elements) {
    if (element.type === "frame") {
      const name = element.name ?? "Frame"
      if (!name.toLowerCase().includes(needle) || seen.has(element.id)) continue
      seen.add(element.id)
      matches.push({
        target: element.id,
        text: name,
        place: "Frame",
        icon: frameIcon(element.id),
      })
    } else if (element.type === "text") {
      const text = element.originalText.replace(/\s+/g, " ").trim()
      if (!text.toLowerCase().includes(needle)) continue
      const target = element.containerId ?? element.id
      if (seen.has(target)) continue
      seen.add(target)
      const frameId = (byId.get(target) ?? element).frameId
      matches.push({
        target,
        text,
        place: (frameId && frameNames[frameId]) || "Board",
        icon: TEXT_ICON,
      })
    }
  }
  return matches
}

export function FramesTab({
  frames,
  frameNames,
  elements,
  itemCount,
  loading,
  activeFrame,
  searchRef,
  onSelect,
  onReveal,
}: {
  frames: readonly BoardFrame[]
  frameNames: Readonly<Record<string, string>>
  elements: WhiteboardScene["elements"]
  /** Everything on the board except frames and the text inside shapes. */
  itemCount: number
  loading: boolean
  /** "board" for the whole board, a frame id, or null once the board is cleared. */
  activeFrame: string | null
  /** Focused when the board asks for Find (Mod+F, the menu's Find on Canvas). */
  searchRef: React.RefObject<HTMLInputElement | null>
  onSelect: (frameId: string | null) => void
  /** Selects and shows one search result. */
  onReveal: (id: string) => void
}) {
  // Lives inside the tab, so the query clears whenever the panel closes.
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  const matches = needle ? findMatches(elements, frameNames, needle) : []

  let body: React.ReactNode
  if (loading) {
    // Whole Board and the demo's five frames.
    body = <PanelRowSkeletons widths={[88, 40, 64, 80, 104, 64]} />
  } else if (needle) {
    body = matches.length ? (
      <PanelList>
        {matches.map((match) => (
          <PanelRow
            key={match.target}
            icon={match.icon}
            title={match.text}
            meta={[match.place]}
            onSelect={() => onReveal(match.target)}
          />
        ))}
      </PanelList>
    ) : (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{TEXT_ICON}</EmptyMedia>
          <EmptyTitle>No Matches</EmptyTitle>
          <EmptyDescription>No frame or note says that.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  } else if (!frames.length) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{FRAME_ICON_FALLBACK}</EmptyMedia>
          <EmptyTitle>No Frames Yet</EmptyTitle>
          <EmptyDescription>
            Press <Kbd>F</Kbd> on the canvas to draw one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  } else {
    body = (
      <PanelList>
        <PanelRow
          icon={
            <Maximize2Icon aria-hidden="true" />
          }
          title="Whole Board"
          meta={[plural(frames.length, "frame"), plural(itemCount, "item")]}
          current={activeFrame === "board"}
          onSelect={() => onSelect(null)}
        />
        {frames.map((frame) => (
          <PanelRow
            key={frame.id}
            icon={frameIcon(frame.id)}
            title={frame.name}
            meta={[plural(frame.count, "item")]}
            current={activeFrame === frame.id}
            onSelect={() => onSelect(frame.id)}
          />
        ))}
      </PanelList>
    )
  }

  return (
    <>
      <div className="shrink-0 px-3 pb-2">
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            value={query}
            placeholder="Search board"
            aria-label="Search board"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Escape empties a filled search before it closes anything.
              if (event.key === "Escape" && query) {
                event.preventDefault()
                event.stopPropagation()
                setQuery("")
              }
            }}
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("")
                  searchRef.current?.focus()
                }}
              >
                <XIcon aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <span role="status" aria-live="polite" className="sr-only">
          {needle
            ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}`
            : ""}
        </span>
      </div>
      <PanelScroll>{body}</PanelScroll>
    </>
  )
}