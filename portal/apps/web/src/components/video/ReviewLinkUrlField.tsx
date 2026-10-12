import { InputGroup, InputGroupAddon, InputGroupInput } from "../reui/input-group";
import { CopyTextButton } from "./CopyTextButton";

/**
 * A Review link's full address in a read-only input group with a Copy button: the reveal after Create or Replace, and the "Link" row of a link's settings (#815).
 * `c-input-group-40` (its visibility dropdown dropped) on the installed `reui/input-group`, the registry twin being `c-input-group-11`. There is no auto-copy:
 * a clipboard write after an awaited fetch loses the user activation in Safari, so the person presses Copy.
 */
export function ReviewLinkUrlField({ url }: { url: string }) {
  return <InputGroup className="max-[721px]:flex-wrap">
    <InputGroupInput readOnly aria-label="Review link URL" value={url} autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} className="min-w-0 [font-family:var(--font-mono)] max-[721px]:basis-full" />
    <InputGroupAddon align="inline-end" className="max-[721px]:basis-full max-[721px]:justify-end">
      <CopyTextButton text={url} className="min-h-11" />
    </InputGroupAddon>
  </InputGroup>;
}
