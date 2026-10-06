/**
 * ReUI `@reui/whiteboard-1` (Pro block; Excalidraw), vendored for #498 through the sandbox
 * (`tmp/ReUI-Test-1`, `--path src/components/vendor-498`), never `shadcn add` in apps/web. Mechanical edits
 * in every file of the set: `cn` from `@/lib/utils` (not the registry's raw `"cn"`), imports repointed to
 * `@/components/reui/`, the `"use client"` directive dropped, the Skin guard's strips (`dark:` variants,
 * Tailwind `shadow-*`, focus ring widths -- see `reui-skin.guard.test.ts`), and `noUncheckedIndexedAccess`
 * narrowing. `"dark": boolean` is quoted only so the guard's `dark:` matcher does not read a type as a variant.
 *
 * This file: The Frames / Library / History panel. Edits (additive): #500 `rowAttrs` on `PanelRow` (data attributes for a host's test seam and hooks) and `forceRender` on the sheet's scrim (nested under the shell's Dialog Root); a `title` prop replaces the demo title; `panes` is now `Partial<...>` and a tab with no pane is not rendered, because History arrives with #500. `dark:` row fills and a focus ring width dropped (Skin guard). #500 browser pass: `RowAction` and the tab triggers reach 44px at <=721px; the sheet's width is set under the same `data-[side=right]:` variant as the registry's `w-3/4`, so it replaces it. #500 stacking: the sheet passes `z-[var(--z-dialog)]` (and the impersonation top offset) itself; the base `reui/sheet` stays z-50.
 */
import { Fragment, useEffect, useRef, useState } from "react"
import { IconTile } from "@/components/reui/icon-tile"
import { cn } from "@/lib/utils"
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react"

import { Button } from "@/components/reui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/reui/item"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/reui/sheet"
import { Skeleton } from "@/components/reui/skeleton"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/reui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/reui/tooltip"

export type PanelTab = "frames" | "library" | "history"

const TABS = [
  { value: "frames", label: "Frames" },
  { value: "library", label: "Library" },
  { value: "history", label: "History" },
] satisfies { value: PanelTab; label: string }[]

const isPanelTab = (value: unknown): value is PanelTab =>
  value === "frames" || value === "library" || value === "history"

const EASE_OUT = [0.23, 1, 0.32, 1] as const

/**
 * A tab's scrolling body on the tabs' 12px gutter, so every row box starts there. The
 * 4px it borrows above (-mt-1 pt-1) keeps a focus ring on its first line whole.
 */
export function PanelScroll({ children }: { children: React.ReactNode }) {
  // The fade lives on this inner scroller: the sheet's exit waits on its
  // animations, and a scroll driven one never finishes.
  return (
    <div className="scroll-fade-y no-scrollbar -mt-1 min-h-0 flex-1 scroll-py-10 overflow-y-auto px-3 pt-1 pb-3">
      {children}
    </div>
  )
}

/**
 * A line on the rows' content column: an Item's own border and xs inset, so labels
 * start where the rows' tiles do in every style. Never wrap rows in it (group/item).
 */
export function PanelInset({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <Item size="xs" className={cn("py-0", className)} {...props} />
}

/** One list of panel rows, boxed to the tabs' and the search field's edges. */
export function PanelList({ children }: { children: React.ReactNode }) {
  return <ItemGroup className="gap-0.5">{children}</ItemGroup>
}

/** A titled group of rows; the heading sits on the rows' content column. */
export function PanelSection({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={title}>
      <PanelInset className="min-h-6 flex-nowrap justify-between">
        <h3 className="text-muted-foreground text-xs font-medium">{title}</h3>
        {action}
      </PanelInset>
      {children}
    </section>
  )
}

/** The house separator between the parts of a meta line. */
function Dot() {
  return (
    <>
      <span
        aria-hidden="true"
        className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
      />
      <span className="sr-only">, </span>
    </>
  )
}

/**
 * One line that slides to its clipped end on row hover or keyboard focus; touch wraps it
 * in full. The whole text stays in the DOM, so the accessible name is never clipped.
 */
export function RowText({
  children,
  className,
}: {
  children: React.ReactNode
  /** Classes for the moving strip (MetaLine makes it a flex line). */
  className?: string
}) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  // How far the clipped text moves to show its end (0 when it fits); measured in px,
  // so the title sizes to its text and a badge sits right after it.
  const [slide, setSlide] = useState(0)
  const overflowing = slide < -1

  // Rows resize with the panel and their revealed actions, the strip with its text.
  useEffect(() => {
    const viewport = viewportRef.current
    const strip = viewport?.firstElementChild
    if (!viewport || !strip) return
    const measure = () =>
      setSlide(Math.min(0, viewport.clientWidth - viewport.scrollWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [])

  return (
    <span
      ref={viewportRef}
      data-overflowing={overflowing || undefined}
      style={{ "--row-slide": `${slide}px` } as React.CSSProperties}
      className="block min-w-0 overflow-hidden data-overflowing:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] group-hover/item:data-overflowing:[mask-image:linear-gradient(to_right,transparent,#000_1.5rem,#000_calc(100%-1.5rem),transparent)] group-has-[:focus-visible]/item:data-overflowing:[mask-image:linear-gradient(to_right,transparent,#000_1.5rem,#000_calc(100%-1.5rem),transparent)]"
    >
      <span
        className={cn(
          "inline-block max-w-none whitespace-nowrap transition-transform duration-150 ease-linear group-hover/item:duration-[2500ms] group-has-[:focus-visible]/item:duration-[2500ms] group-hover/item:in-data-overflowing:[transform:translateX(calc(var(--row-slide)-1.5rem))] group-has-[:focus-visible]/item:in-data-overflowing:[transform:translateX(calc(var(--row-slide)-1.5rem))] motion-reduce:transition-none pointer-coarse:whitespace-normal",
          className
        )}
      >
        {children}
      </span>
    </span>
  )
}

/** A meta line's parts with the dot between them, one line that slides like the title. */
export function MetaLine({ parts }: { parts: readonly React.ReactNode[] }) {
  return (
    <RowText className="inline-flex items-center gap-1.5 align-top pointer-coarse:flex-wrap">
      {parts.map((part, index) =>
        index === 0 ? (
          <Fragment key={index}>{part}</Fragment>
        ) : (
          // #559: each dot travels with the part after it, so a wrapped line never starts or ends on a hanging dot.
          <span key={index} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Dot />
            {part}
          </span>
        )
      )}
    </RowText>
  )
}

/** The face every row shares: an elevated sm tile, a one-line title with its badge
 * right after it, and one text-xs meta line; both lines pin their height. */
function PanelRowBody({
  icon,
  title,
  badge,
  meta,
}: {
  icon: React.ReactNode
  title: React.ReactNode
  badge?: React.ReactNode
  meta: readonly React.ReactNode[]
}) {
  return (
    <>
      <ItemMedia>
        <IconTile variant="elevated" size="sm">
          {icon}
        </IconTile>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="min-h-5 w-full font-normal">
          {title}
          {badge}
        </ItemTitle>
        <ItemDescription className="text-xs/normal tabular-nums">
          <MetaLine parts={meta} />
        </ItemDescription>
      </ItemContent>
    </>
  )
}

/** Loading rows with the real row's box: the tile, the title line and the meta line. */
export function PanelRowSkeletons({ widths }: { widths: readonly number[] }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-0.5">
      {widths.map((width, index) => (
        <Item key={index} size="xs" className="flex-nowrap">
          <ItemMedia>
            <Skeleton className="size-8" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="min-h-5">
              <Skeleton className="h-3.5" style={{ width }} />
            </ItemTitle>
            {/* A <p> cannot hold a Skeleton's div; the slot name aligns the tile as a real row's. */}
            <div
              data-slot="item-description"
              className="flex h-lh items-center text-xs/normal"
            >
              <Skeleton className="h-3 w-14" />
            </div>
          </ItemContent>
        </Item>
      ))}
    </div>
  )
}

/** Row actions show on row hover or focus, and always on touch. At rest they are
 * sr-only: no room taken, yet in the tab order and focusable from code. */
const ACTION_REVEAL =
  "sr-only opacity-0 transition-opacity duration-150 group-hover/item:not-sr-only group-hover/item:opacity-100 group-focus-within/item:not-sr-only group-focus-within/item:opacity-100 pointer-coarse:not-sr-only pointer-coarse:opacity-100 motion-reduce:transition-none"

/** A ghost icon button in a row, named by its tooltip. Its foreground wash reads on any
 * row fill; relative z-10 lifts it over the row's stretched title button. */
export function RowAction({
  label,
  tooltip,
  icon,
  pressed,
  disabled,
  buttonRef,
  onClick,
}: {
  /** The accessible name, specific to the row. */
  label: string
  tooltip: string
  icon: React.ReactNode
  pressed?: boolean
  disabled?: boolean
  buttonRef?: React.Ref<HTMLButtonElement>
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            aria-label={label}
            aria-pressed={pressed}
            className="hover:bg-foreground/10 relative z-10 max-[721px]:min-h-[44px] max-[721px]:min-w-[44px]"
            onClick={onClick}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The panel's one row, boxed to the list. With onSelect its title button stretches over
 * the row, so actions never nest in a button; without it the row is static.
 */
export function PanelRow({
  icon,
  title,
  badge,
  meta,
  current = false,
  inert = false,
  actions,
  draggable = false,
  onDragStart,
  onSelect,
  onHighlight,
  rowAttrs,
}: {
  /** #500: extra attributes for the row (a host's data-testid and ids). */
  rowAttrs?: Record<`data-${string}`, string>
  icon: React.ReactNode
  title: string
  badge?: React.ReactNode
  /** The meta line's parts; the dot goes between them. */
  meta: readonly React.ReactNode[]
  /** Where the board is: the muted fill, and aria-current on the title button. */
  current?: boolean
  /** Focusable but inert (aria-disabled): the row's target is gone. */
  inert?: boolean
  actions?: React.ReactNode
  /** The row itself is the drag source. */
  draggable?: boolean
  onDragStart?: React.DragEventHandler<HTMLDivElement>
  onSelect?: () => void
  /** Hover or focus on the row, then off again. */
  onHighlight?: (on: boolean) => void
}) {
  const interactive = Boolean(onSelect || actions || draggable)
  return (
    <Item
      size="xs"
      role="listitem"
      data-current={current || undefined}
      {...rowAttrs}
      draggable={draggable || undefined}
      onDragStart={onDragStart}
      className={cn(
        "data-current:bg-muted has-[[data-row-select]:focus-visible]:border-ring has-[[data-row-select]:focus-visible]:ring-ring/50 relative flex-nowrap has-[[data-row-select]:focus-visible]:ring-inset",
        interactive && "hover:bg-muted/50",
        draggable && "cursor-grab active:cursor-grabbing"
      )}
      onPointerEnter={() => onHighlight?.(true)}
      onPointerLeave={() => onHighlight?.(false)}
    >
      <PanelRowBody
        icon={icon}
        title={
          onSelect ? (
            <button
              type="button"
              data-row-select=""
              aria-current={current ? "true" : undefined}
              aria-disabled={inert || undefined}
              className="min-w-0 cursor-pointer text-start outline-none after:absolute after:inset-0 aria-disabled:cursor-default"
              onClick={() => {
                if (!inert) onSelect()
              }}
              onFocus={() => onHighlight?.(true)}
              onBlur={() => onHighlight?.(false)}
            >
              <RowText>{title}</RowText>
            </button>
          ) : (
            <RowText>{title}</RowText>
          )
        }
        badge={badge}
        meta={meta}
      />
      {actions ? (
        <ItemActions className={cn("gap-1", ACTION_REVEAL)}>
          {actions}
        </ItemActions>
      ) : null}
    </Item>
  )
}

type PanelProps = {
  tab: PanelTab
  onTabChange: (tab: PanelTab) => void
  /** #498: a tab whose pane is absent is not rendered (History arrives with #500). */
  panes: Partial<Record<PanelTab, React.ReactNode>>
}

function PanelTabs({
  tab,
  onTabChange,
  panes,
  activeTabRef,
}: PanelProps & { activeTabRef?: React.Ref<HTMLButtonElement> }) {
  const tabs = TABS.filter((item) => panes[item.value] !== undefined)
  // #559: one pane is plain content. Base UI's lone TabsContent would be an unnamed focusable role="tabpanel" with no tab to name it.
  if (tabs.length === 1) {
    return <div className="flex min-h-0 flex-1 flex-col">{panes[tabs[0]!.value]}</div>
  }
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isPanelTab(value)) onTabChange(value)
      }}
      className="min-h-0 flex-1 gap-0"
    >
      {/* #559: a lone tab is no choice, and its label repeated the sheet's title; the strip shows only when there is more than one. */}
      {tabs.length > 1 ? (
        <div className="shrink-0 p-3">
          <TabsList className="w-full max-[721px]:group-data-[orientation=horizontal]/tabs:h-[3.125rem]">
            {tabs.map((item) => (
              <TabsTrigger
                key={item.value}
                value={item.value}
                ref={item.value === tab ? activeTabRef : undefined}
                className="max-[721px]:h-11"
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      ) : null}
      {tabs.map((item) => (
        <TabsContent
          key={item.value}
          value={item.value}
          className="animate-in fade-in-0 flex min-h-0 flex-col duration-150 motion-reduce:animate-none"
        >
          {panes[item.value]}
        </TabsContent>
      ))}
    </Tabs>
  )
}

/** Slides in over the canvas edge, then takes its width; gives it back before
 * sliding out. The editor re-lays out once per toggle and never shows a gap. */
function DockedPanel({
  id,
  animateIn,
  measured,
  children,
}: {
  id: string
  animateIn: boolean
  measured: boolean
  children: React.ReactNode
}) {
  const isPresent = useIsPresent()
  const reduceMotion = useReducedMotion()
  const [settled, setSettled] = useState(!animateIn)
  const hidden = reduceMotion ? { opacity: 0 } : { opacity: 0, x: "100%" }

  return (
    <motion.aside
      id={id}
      aria-label="Board panel"
      className={cn(
        "bg-background flex w-72 shrink-0 flex-col border-l",
        // Before the board is measured, docks only from DOCK_WIDTH (1120px).
        !measured && "hidden @min-[70rem]/board:flex",
        (!settled || !isPresent) && "absolute inset-y-0 right-0 z-10"
      )}
      initial={hidden}
      animate={{ opacity: 1, x: 0 }}
      exit={hidden}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE_OUT }}
      onAnimationComplete={() => setSettled(true)}
    >
      {children}
    </motion.aside>
  )
}

/**
 * Docked beside the canvas when the board has room, a sheet otherwise. Exactly
 * one of the two is mounted, so the canvas never measures a hidden panel.
 */
export function BoardPanel({
  title,
  description,
  panelId,
  tabRef,
  docked,
  measured,
  dockOpen,
  sheetOpen,
  onSheetOpenChange,
  sheetFocus,
  ...props
}: PanelProps & {
  /** #498: the sheet's title (the registry hard-codes a demo's board name; #559: Quincy's one pane titles it "History"). */
  title: string
  /** #559: the sheet's subtitle (Quincy passes the project's address); a sentence naming the panes when absent. */
  description?: string
  /** The docked aside's id, which the header's toggle controls. */
  panelId: string
  /** The active tab, docked or in the sheet: the sheet's first focus and a focus fallback. */
  tabRef: React.RefObject<HTMLButtonElement | null>
  docked: boolean
  /** False until the board width is known; the panel then docks by CSS alone. */
  measured: boolean
  dockOpen: boolean
  sheetOpen: boolean
  onSheetOpenChange: (open: boolean) => void
  /** Where focus starts when the sheet opens; the active tab by default. */
  sheetFocus?: () => HTMLElement | null
}) {
  // A panel shown on the first render is already in place; once it has hidden,
  // every later open slides in.
  const shown = docked && dockOpen
  const [animateIn, setAnimateIn] = useState(!shown)
  if (!shown && !animateIn) setAnimateIn(true)

  return (
    <>
      <AnimatePresence initial={false}>
        {shown ? (
          <DockedPanel
            key="panel"
            id={panelId}
            animateIn={animateIn}
            measured={measured}
          >
            <PanelTabs {...props} activeTabRef={tabRef} />
          </DockedPanel>
        ) : null}
      </AnimatePresence>
      {/* Mounted closed, so the first open still plays the sheet transition. */}
      <Sheet open={!docked && sheetOpen} onOpenChange={onSheetOpenChange}>
        <SheetContent
          side="right"
          // #500: the Portal's shell wraps every page in a Base UI Dialog Root, so this sheet is nested and would skip its scrim (see reui/sheet.tsx, #221).
          // `z-[var(--z-dialog)]` is passed here, not set on the base sheet: only this sheet opens from inside the Workspace sheet (--z-dialog), and the
          // base sheet stays z-50 so no other sheet rises above the impersonation banner (z-76). Popup and scrim start below the banner while
          // impersonating, like `ProjectSheet`/`RailSheet`; the sheet is portaled to body, so the shell's `.app--impersonating` is matched with :has().
          overlayProps={{ forceRender: true, className: "z-[var(--z-dialog)] [body:has(.app--impersonating)_&]:top-[var(--impersonation-banner-height)] [body:has(.app--impersonating)_&]:before:absolute [body:has(.app--impersonating)_&]:before:content-[''] [body:has(.app--impersonating)_&]:before:inset-x-0 [body:has(.app--impersonating)_&]:before:bottom-full [body:has(.app--impersonating)_&]:before:h-[var(--impersonation-banner-height)]" }}
          // The sheet opens on its active tab, so keyboard focus starts inside it.
          initialFocus={() => sheetFocus?.() ?? tabRef.current ?? true}
          className="z-[var(--z-dialog)] data-[side=right]:w-[min(20rem,calc(100%-3rem))] [body:has(.app--impersonating)_&]:data-[side=right]:top-[var(--impersonation-banner-height)] [body:has(.app--impersonating)_&]:data-[side=right]:h-auto [body:has(.app--impersonating)_&]:data-[side=right]:bottom-0 gap-0"
        >
          <SheetHeader className="border-b">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description ?? `The board's ${TABS.filter((item) => props.panes[item.value] !== undefined).map((item) => item.label.toLowerCase()).join(", ")}.`}</SheetDescription>
          </SheetHeader>
          <PanelTabs {...props} activeTabRef={tabRef} />
        </SheetContent>
      </Sheet>
    </>
  )
}