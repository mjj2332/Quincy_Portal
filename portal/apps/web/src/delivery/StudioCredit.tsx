import { STUDIO_EMAIL, STUDIO_NAME } from "./studio";

/** "Quincy Productions · info@…": the name as text, the address as a mailto (`href`, which the caller builds: the footer adds the street as the subject). */
export function StudioCredit({ href, className, ...props }: { href: string; className?: string; "data-testid"?: string }) {
  return <p className={`m-0 [font:var(--type-label)] text-foreground-secondary ${className ?? ""}`} {...props}>{`${STUDIO_NAME} · `}<a href={href} className="underline underline-offset-2">{STUDIO_EMAIL}</a></p>;
}
