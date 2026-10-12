import { InputGroup, InputGroupAddon, InputGroupInput } from "../reui/input-group";
import { CopyTextButton } from "./CopyTextButton";

/**
 * A Review link's full address in a read-only input group with a Copy button: the reveal after Create or Replace, and the "Link" row of a link's settings (#815).
 * `c-input-group-40` (its visibility dropdown dropped) on the installed `reui/input-group`, the registry twin being `c-input-group-11`. There is no auto-copy:
 * a clipboard write after an awaited fetch loses the user activation in Safari, so the person presses Copy.
 */
export function ReviewLinkUrlField({ url, id }: { url: string; id?: string }) {
  // The whole group wears the read-only tint, so input and Copy read as one field; on a phone Copy drops to its own row under a rule.
  return <InputGroup className="bg-surface-sunken max-[721px]:flex-wrap">
    <InputGroupInput readOnly id={id} aria-label={id === undefined ? "Review link URL" : undefined} data-testid="review-link-url" value={url} autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} className="min-w-0 font-[family-name:var(--font-mono)] max-[721px]:basis-full" />
    <InputGroupAddon align="inline-end" className="max-[721px]:basis-full max-[721px]:justify-end max-[721px]:border-t max-[721px]:border-border max-[721px]:pt-[var(--space-2)]">
      <CopyTextButton text={url} className="min-h-11" />
    </InputGroupAddon>
  </InputGroup>;
}
