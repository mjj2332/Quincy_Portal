import { type ComponentPropsWithRef, type MouseEvent } from "react";
import { locationStore, shouldInterceptInternalLink } from "../lib/router";

// `ComponentPropsWithRef<"a">`, not `AnchorHTMLAttributes<HTMLAnchorElement>` — Base UI's
// `Menu.LinkItem` needs the actual anchor DOM node for item registration, roving focus and
// typeahead, and passes it via `ref` on its render prop. React 19 makes `ref` an ordinary prop
// for function components, so no `forwardRef` is needed here; the existing `{ to, onClick,
// ...props }` destructure already carries it through the `<a {...props}>` spread below.
type InternalLinkProps = ComponentPropsWithRef<"a"> & { to: string };

/** A real anchor that progressively enhances ordinary mouse clicks into SPA history changes. */
export function InternalLink({ to, onClick, ...props }: InternalLinkProps) {
  return <a
    {...props}
    href={to}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (shouldInterceptInternalLink(event, window.location.origin)) {
        event.preventDefault();
        locationStore().push(to);
      }
    }}
  />;
}
