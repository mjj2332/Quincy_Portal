// Vendored from ReUI `rich-text-editor-2` (`rich-text-bubble-bar.tsx`) via the `tmp/ReUI-Test-1`
// sandbox (#492). Edits:
// 1. The registry's `Card` surface -> the Portal's popup surface (hairline border, `bg-popover`,
//    `--shadow-md`), the same one `reui/dropdown-menu` and `quincy/menu-surface.ts` draw: a floating
//    bar is an overlay, and `card` is the Portal's committed CONTENT surface (ADR 0002 / 0014).
// 2. `testId` prop, forwarded to the surface: tests select a Quincy-owned id, not a `data-slot`.
// 3. The surface has no outer `p-1`: the toolbar scroller already pads itself by `--space-1`, so the card was
//    8px taller than its controls (~46px against ~38px) and did not fit above row 2 of a first-block table (#535).
// 4. `focusFirstToolbarStop` and `fromOwnDom` are exported: the phone table group (`RichTextTableTools`) reuses
//    the Alt+F10 / Escape behaviour instead of copying the selectors.
// 6. `inactive` keeps the bar mounted but inert (focus cannot enter it, `focusFirstToolbarStop` refuses an inert
//    root), `aria-hidden` and `invisible`: the table bar's "no room" state, where the same controls render as the
//    toolbar's table group instead (#535). `tier` is the Quincy test hook `data-tier`.
// 5. Each mounted bar is registered against its editor (`editorOwnsBubbleBar`): a bubble portals out of the
//    editor's own DOM, so "is this focus in MY bar" cannot be answered by containment alone (#535).
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react"
import type { Editor } from "@tiptap/react"

import { cn } from "@/lib/utils"

import { RichTextToolbar } from "./rich-text-toolbar"

const FIRST_STOP = "[data-toolbar-item][tabindex='0']"
const ANY_STOP = "[data-toolbar-item]:not([disabled]):not([data-disabled])"

/** Asks a bubble plugin to show or hide its menu now. */
export function setRichTextBubble(
  editor: Editor,
  pluginKey: string,
  action: "show" | "hide"
) {
  const { view } = editor

  view.dispatch(view.state.tr.setMeta(pluginKey, action))
  if (action === "show") {
    view.dispatch(view.state.tr.setMeta(pluginKey, "updatePosition"))
  }
}

/** Focuses the roving tab stop inside `root`, else its first enabled control; false when it has none. */
export function focusFirstToolbarStop(root: ParentNode): boolean {
  // An inert subtree cannot take focus; saying so lets the caller's other handler (the toolbar group) run.
  if (root instanceof Element && root.closest("[inert]")) return false

  const stop =
    root.querySelector<HTMLElement>(FIRST_STOP) ??
    root.querySelector<HTMLElement>(ANY_STOP)

  if (!stop) return false
  stop.focus()
  return true
}

// Menus and popovers portal out, yet React still bubbles their events here.
export function fromOwnDom(event: { target: EventTarget; currentTarget: Element }) {
  return (
    event.target instanceof Node && event.currentTarget.contains(event.target)
  )
}

const barsByEditor = new WeakMap<Editor, Set<HTMLElement>>()

/** True when `node` sits inside a bubble bar mounted by this editor (not another editor's). */
export function editorOwnsBubbleBar(editor: Editor, node: Node | null): boolean {
  if (!node) return false
  for (const bar of barsByEditor.get(editor) ?? []) if (bar.contains(node)) return true
  return false
}

interface RichTextBubbleBarProps {
  editor: Editor
  pluginKey: string
  label: string
  /** Keeps the bar up while a field of its own holds focus. */
  holdOpen?: boolean
  /** The bar stays mounted but cannot be used or seen: another presentation of its controls is showing. */
  inactive?: boolean
  /** The table bar's placement tier, exposed as `data-tier` for browser measurement. */
  tier?: string
  /** A Quincy-owned test id on the bar's surface (test-seam guard F bans vendor `data-slot` hooks). */
  testId?: string
  children: ReactNode
}

/** The card a floating bar sits on: Alt+F10 reaches it from the text, Escape
 * goes back, and it lets go of its bubble once focus has left both. */
export function RichTextBubbleBar({
  editor,
  pluginKey,
  label,
  holdOpen = false,
  inactive = false,
  tier,
  testId,
  children,
}: RichTextBubbleBarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const holdRef = useRef(holdOpen)
  const pressingRef = useRef(false)

  useLayoutEffect(() => {
    holdRef.current = holdOpen
  }, [holdOpen])

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const bars = barsByEditor.get(editor) ?? new Set<HTMLElement>()
    bars.add(bar)
    barsByEditor.set(editor, bars)
    return () => {
      bars.delete(bar)
    }
  }, [editor])

  useEffect(() => {
    const { dom } = editor.view

    function release() {
      pressingRef.current = false
    }

    // A blur during a press on the bar is the bar's own doing. Any other blur
    // lets the bar go, since a press it took earlier latched the plugin's guard.
    function handleBlur({ event }: { event: FocusEvent }) {
      const pressed = pressingRef.current
      const next = event.relatedTarget

      queueMicrotask(() => {
        const bar = barRef.current

        if (editor.isDestroyed || !bar) return
        if (holdRef.current) {
          setRichTextBubble(editor, pluginKey, "show")
          return
        }
        if (pressed || !bar.isConnected || editor.view.hasFocus()) return

        const staysNear =
          (next instanceof Node && bar.parentElement?.contains(next)) ||
          bar.querySelector("[aria-expanded='true']") !== null

        if (!staysNear) setRichTextBubble(editor, pluginKey, "hide")
      })
    }

    // The WAI-ARIA editor convention; only a bar on screen is connected.
    function handleShortcut(event: KeyboardEvent) {
      const bar = barRef.current

      if (!event.altKey || event.key !== "F10" || !bar?.isConnected) return

      if (!focusFirstToolbarStop(bar)) return
      event.preventDefault()
    }

    editor.on("blur", handleBlur)
    dom.addEventListener("keydown", handleShortcut)
    document.addEventListener("pointerup", release, true)
    document.addEventListener("pointercancel", release, true)
    return () => {
      editor.off("blur", handleBlur)
      dom.removeEventListener("keydown", handleShortcut)
      document.removeEventListener("pointerup", release, true)
      document.removeEventListener("pointercancel", release, true)
    }
  }, [editor, pluginKey])

  // A menu that opens on pointerdown cancels the mousedown a bubble listens
  // for to survive the focus move, so a press on the bar itself is replayed.
  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!fromOwnDom(event)) return

    pressingRef.current = true
    event.currentTarget.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true })
    )
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !fromOwnDom(event)) return

    event.preventDefault()
    editor.commands.focus()
  }

  return (
    <div
      ref={barRef}
      data-testid={testId}
      data-tier={tier}
      inert={inactive || undefined}
      aria-hidden={inactive || undefined}
      className={cn("border border-border bg-popover text-popover-foreground shadow-[var(--shadow-md)]", inactive && "invisible")}
      onPointerDownCapture={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      <RichTextToolbar aria-label={label} aria-keyshortcuts="Alt+F10">
        {children}
      </RichTextToolbar>
    </div>
  )
}