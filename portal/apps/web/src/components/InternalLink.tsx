import { type AnchorHTMLAttributes, type MouseEvent } from "react";
import { locationStore, shouldInterceptInternalLink } from "../lib/router";

type InternalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

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
