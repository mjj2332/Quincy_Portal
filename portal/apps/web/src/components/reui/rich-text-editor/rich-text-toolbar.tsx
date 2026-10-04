// Vendored from ReUI `rich-text-editor-2` (`rich-text-toolbar.tsx`) via the `tmp/ReUI-Test-1`
// sandbox (#491). Edits:
// 1. `cn` -> `@/lib/utils`; `@/components/ui/*` and `@/components/vendor-491/*` -> `@/components/reui/*`
//    (Quincy's own adapted `button` is kept, not the vendored one).
// 2. The toolbar's `no-scrollbar` / `scroll-fade-x` utilities do not exist in Quincy's Tailwind and
//    would silently do nothing: replaced with the scrollbar-hiding utilities and the <=721px
//    right-edge mask the legacy field toolbar used (`RichTextEditor.tsx`, #376).
// 3. A pressed `RichTextToggle` reads `bg-primary` / `--accent-on`, the legacy toolbar's pressed
//    state, rather than nova's `bg-muted` (which the hover state shares).
// 4. `RichTextButton` (Undo/Redo) overrides `reui/button`'s `disabled:opacity-50` with transparent +
//    muted text and `disabled:opacity-100`: disabled is colour, never dimming (the #376 rule).
// 5. `RichTextToolbarSeparator`: `data-vertical:self-center` -> `data-[orientation=vertical]:self-center` (Base UI emits
//    `data-orientation`; the bare form matched nothing; `reui-skin.guard` now rejects it).
// 5b. The phone fade mask follows scroll position (`data-fade` start/end/both/none) instead of staying on at the end.
// 5c. The scroller carries `p-[var(--space-1)]` so the overflow clip does not cut the controls' focus
//    outlines (3px ring + 2px offset); Undo/Redo are 44px at <=721px.
// 5d. `RICH_TEXT_PHONE_QUERY` is the JS twin of this file's `max-[721px]:` variants (Tailwind emits
//    `@media (width < 721px)`), so the editor can swap presentations at exactly the same width (#535). The fade is
//    re-measured after every render, so it follows the controls that appear and disappear (the table group).
// 6. Roving tabindex is kept as-is: the toolbar is ONE tab stop (the legacy bar had ~12) and arrow
//    keys / Home / End walk it. Intended; flagged to design-review.
import {
  useLayoutEffect,
  useState,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { cn } from "@/lib/utils"

import { Button } from "@/components/reui/button"
import { Kbd, KbdGroup } from "@/components/reui/kbd"
import { Separator } from "@/components/reui/separator"
import { Toggle } from "@/components/reui/toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/reui/tooltip"

/** The phone breakpoint, matching Tailwind's `max-[721px]:` (NOT `(max-width: 721px)`, which also matches 721px). */
export const RICH_TEXT_PHONE_QUERY = "(width < 721px)"

// Every control carries this, so arrow keys can walk the bar in DOM order.
const TOOLBAR_ITEM = "[data-toolbar-item]"

const subscribeToPlatform = () => () => {}

/** The server has no navigator, so it renders Mac keys and the client corrects. */
export function useIsApplePlatform() {
  return useSyncExternalStore(
    subscribeToPlatform,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => true
  )
}

const APPLE_KEYS: Record<string, string> = {
  mod: "⌘",
  alt: "⌥",
  shift: "⇧",
}

const OTHER_KEYS: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
}

/** Menu shortcuts read as one compact string: ⌘⇧L on Apple, Ctrl+Shift+L elsewhere. */
export function useShortcutLabel(keys: readonly string[]) {
  const apple = useIsApplePlatform()
  const names = apple ? APPLE_KEYS : OTHER_KEYS

  return keys.map((key) => names[key] ?? key).join(apple ? "" : "+")
}

export function ShortcutKeys({ keys }: { keys: readonly string[] }) {
  const names = useIsApplePlatform() ? APPLE_KEYS : OTHER_KEYS

  return (
    <KbdGroup>
      {keys.map((key) => (
        <Kbd key={key}>{names[key] ?? key}</Kbd>
      ))}
    </KbdGroup>
  )
}

function isEnabled(item: HTMLElement) {
  return !item.hasAttribute("disabled") && !item.hasAttribute("data-disabled")
}

/** Arrows wrap at the ends, as the toolbar pattern expects. */
function stepFrom(key: string, current: number, last: number) {
  switch (key) {
    case "ArrowRight":
      return current === last ? 0 : current + 1
    case "ArrowLeft":
      return current === 0 ? last : current - 1
    case "Home":
      return 0
    case "End":
      return last
    default:
      return null
  }
}

/** One tab stop for the whole bar; arrows, Home and End move inside it. */
export function RichTextToolbar({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<"none" | "start" | "end" | "both">("none")
  const activeRef = useRef<HTMLElement | null>(null)

  function items() {
    return Array.from(
      ref.current?.querySelectorAll<HTMLElement>(TOOLBAR_ITEM) ?? []
    )
  }

  function rove(active: HTMLElement | null) {
    const all = items()
    const enabled = all.filter(isEnabled)
    const stop = active && enabled.includes(active) ? active : enabled[0]

    for (const item of all) {
      item.tabIndex = item === stop ? 0 : -1
    }
  }

  // Controls enable and disable with the caret, so the tab stop re-settles
  // after every render instead of pointing at a disabled button.
  useLayoutEffect(() => {
    rove(activeRef.current)
    // Children come and go (the phone table group), so the fade follows them; setFade bails out on an equal value.
    measureFade()
  })

  // Fade only the side that has more content: scrolled to the end, the last control (Redo) is not faded.
  function measureFade() {
    const el = ref.current
    if (!el) return
    const more = (start: boolean, end: boolean) =>
      setFade(start && end ? "both" : start ? "start" : end ? "end" : "none")
    more(el.scrollLeft > 1, el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }

  useLayoutEffect(() => {
    measureFade()
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measureFade)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  function handleFocus(event: FocusEvent<HTMLDivElement>) {
    if (event.target.matches(TOOLBAR_ITEM)) {
      activeRef.current = event.target
      rove(event.target)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = items().filter(isEnabled)
    const current = enabled.findIndex((item) => item === event.target)

    if (current === -1) return

    const next = stepFrom(event.key, current, enabled.length - 1)

    if (next === null) return

    event.preventDefault()
    enabled[next]?.focus()
    enabled[next]?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-orientation="horizontal"
      data-fade={fade}
      onScroll={measureFade}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex items-center gap-1 p-[var(--space-1)] overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[721px]:data-[fade=end]:[mask-image:linear-gradient(to_right,black_85%,transparent)] max-[721px]:data-[fade=start]:[mask-image:linear-gradient(to_left,black_85%,transparent)] max-[721px]:data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function RichTextToolbarGroup({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 items-center gap-0.5"
    >
      {children}
    </div>
  )
}

export function RichTextToolbarSeparator() {
  return (
    <Separator
      orientation="vertical"
      className="h-4 shrink-0 data-[orientation=vertical]:self-center"
    />
  )
}

// A pointer press must not pull focus out of the text, or the caret blinks
// away and the selection the command needs is painted as lost.
export function keepEditorFocus(event: { preventDefault: () => void }) {
  event.preventDefault()
}

interface RichTextToggleProps {
  label: string
  shortcut?: readonly string[]
  pressed: boolean
  disabled?: boolean
  /** Commands toggle themselves, so the next pressed state is not needed. */
  onToggle: () => void
  children: ReactNode
}

export function RichTextToggle({
  label,
  shortcut,
  pressed,
  disabled,
  onToggle,
  children,
}: RichTextToggleProps) {
  // An icon has no label to pad, so the toggle stays square (px-0).
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="sm"
            aria-label={label}
            pressed={pressed}
            disabled={disabled}
            onPressedChange={onToggle}
            onMouseDown={keepEditorFocus}
            className="px-0 aria-pressed:bg-primary aria-pressed:!text-[var(--accent-on)]"
            data-toolbar-item=""
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut ? <ShortcutKeys keys={shortcut} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}

interface RichTextButtonProps {
  label: string
  shortcut?: readonly string[]
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}

export function RichTextButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: RichTextButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            onMouseDown={keepEditorFocus}
            className="max-[721px]:size-11 disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100"
            data-toolbar-item=""
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut ? <ShortcutKeys keys={shortcut} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}