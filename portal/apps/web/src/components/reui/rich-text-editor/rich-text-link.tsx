// Vendored from ReUI `rich-text-editor-2` (`rich-text-link.tsx`) via the `tmp/ReUI-Test-1` sandbox
// (#491). Edits:
// 1. Import paths -> `@/components/reui/*`; `RichTextLinkBubble` (and its `BubbleMenu`,
//    `ButtonGroup`, `useEditorState` imports) is not vendored: the composer has no bubble.
// 2. `normalizeHref` is `isHttpUrl`, not the vendor's http/mailto/tel/bare-domain rule: the server
//    rejects everything but absolute HTTP(S) (a `mailto:` mark 400s on save). The error copy is the
//    legacy dialog's "Enter a non-empty absolute HTTP(S) URL."
// 3. Apply no longer inserts the typed address as text on a collapsed caret, and Enter/Apply on an
//    empty field shows the error rather than being a silent no-op: both are legacy behaviour the
//    editor tests assert (a collapsed caret keeps a stored mark; empty Apply errors).
// 4. Remove no longer calls `extendMarkRange` (a non-empty selection unlinks only itself, as legacy; `unsetLink`
//    already expands a collapsed caret). `extendMarkRange("link")` on Apply only when the field opened on an existing link (legacy parity).
// 5. `finalFocus` depends on the close reason: Apply/Remove -> the editor, everything else -> the
//    trigger. The popover is named "Add link"/"Edit link" (the legacy dialog title) so it does not
//    share the trigger's `aria-label="Link"`.
// 7. The popover's test id is a `testId` prop, passed by `QuincyRichTextEditor` (Quincy-owned hooks).
// 6. Pressed link trigger reads `bg-primary` like the other toolbar toggles.
// 8. Optional `onApplied(href)` on `RichTextLinkPopover`, threaded to `LinkForm` and called only after a successful Apply (never Remove):
//    the owner uses it to offer a link preview (#497). No other behaviour change.
import { useId, useRef, useState, type FormEvent, type RefObject } from "react"
import { type Editor } from "@tiptap/react"
import { isHttpUrl } from "@quincy/shared"

import { Field, FieldError } from "@/components/reui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/reui/input-group"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/reui/popover"
import { Toggle } from "@/components/reui/toggle"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/reui/tooltip"
import type { RichTextSnapshot } from "./rich-text-state"
import { keepEditorFocus, ShortcutKeys } from "./rich-text-toolbar"
import { LinkIcon, CheckIcon, Link2OffIcon } from "lucide-react"

/** A typed address as an href, or null when it is not an absolute HTTP(S) URL (what the server accepts). */
export function normalizeHref(value: string) {
  const href = value.trim();
  return isHttpUrl(href) ? href : null;
}

function removeLink(editor: Editor | null) {
  editor?.chain().focus().unsetLink().run()
}

interface LinkFormProps {
  editor: Editor | null
  href: string | null
  inputRef: RefObject<HTMLInputElement | null>
  onDone: (applied: boolean) => void
  onApplied?: (href: string) => void
}

function LinkForm({ editor, href, inputRef, onDone, onApplied }: LinkFormProps) {
  const [draft, setDraft] = useState(href ?? "")
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // The popover is portalled but React still bubbles synthetic events through the editor's
    // ancestors: a composer inside a <form> must not see this one.
    event.stopPropagation()

    const next = normalizeHref(draft)

    if (!editor || !next) {
      setInvalid(true)
      return
    }

    const chain = editor.chain().focus()

    // Extend only over a link that was already there: a plain selection keeps its own range, and a
    // collapsed caret keeps a stored mark so the next typed text is linked (parity with the legacy dialog).
    if (href !== null) chain.extendMarkRange("link")
    chain.setLink({ href: next }).run()

    onDone(true)
    onApplied?.(next)
  }

  return (
    <form onSubmit={apply}>
      <Field data-invalid={invalid || undefined}>
        <InputGroup>
          <InputGroupAddon>
            <LinkIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            value={draft}
            placeholder="https://example.com"
            aria-label="Link address"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => {
              setDraft(event.target.value)
              setInvalid(false)
            }}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="submit"
              size="icon-xs"
              aria-label="Apply link"
            >
              <CheckIcon aria-hidden="true" />
            </InputGroupButton>
            {href ? (
              <InputGroupButton
                size="icon-xs"
                aria-label="Remove link"
                onClick={() => {
                  removeLink(editor)
                  onDone(true)
                }}
              >
                <Link2OffIcon aria-hidden="true" />
              </InputGroupButton>
            ) : null}
          </InputGroupAddon>
        </InputGroup>
        {invalid ? (
          <FieldError id={errorId}>
            Enter a non-empty absolute HTTP(S) URL.
          </FieldError>
        ) : null}
      </Field>
    </form>
  )
}

interface RichTextLinkPopoverProps {
  editor: Editor | null
  state: RichTextSnapshot
  open: boolean
  /** The owner's own disabled state, which the snapshot may lag. */
  disabled?: boolean
  /** Quincy-owned test hook for the popover; the vendor file does not name one. */
  testId?: string
  onOpenChange: (open: boolean) => void
  /** Called with the address after a successful Apply (not Remove). */
  onApplied?: (href: string) => void
}

export function RichTextLinkPopover({
  editor,
  state,
  open,
  disabled = false,
  testId,
  onOpenChange,
  onApplied,
}: RichTextLinkPopoverProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Escape / outside press / re-pressing the trigger return focus to the trigger; Apply and Remove
  // return it to the editor, at the restored selection, so typing continues.
  const appliedRef = useRef(false)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) appliedRef.current = false
        onOpenChange(next)
      }}
    >
      <Tooltip>
        {/* The span carries the tooltip, so the trigger keeps its own props. */}
        <TooltipTrigger render={<span className="flex" />}>
          <PopoverTrigger
            render={
              <Toggle
                size="sm"
                aria-label="Link"
                pressed={state.link !== null}
                disabled={disabled || !state.canLink}
                onMouseDown={keepEditorFocus}
                className="px-0 aria-pressed:bg-primary aria-pressed:!text-[var(--accent-on)]"
                data-toolbar-item=""
              />
            }
          >
            <LinkIcon aria-hidden="true" />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          Link
          <ShortcutKeys keys={["mod", "K"]} />
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        aria-label={state.link === null ? "Add link" : "Edit link"}
        className="w-80"
        data-testid={testId}
        initialFocus={inputRef}
        finalFocus={() => (appliedRef.current ? (editor?.view.dom ?? true) : true)}
      >
        {/* Mounts per open, so the field always starts from the current link. */}
        <LinkForm
          editor={editor}
          href={state.link}
          inputRef={inputRef}
          onApplied={onApplied}
          onDone={(applied) => {
            appliedRef.current = applied
            onOpenChange(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
