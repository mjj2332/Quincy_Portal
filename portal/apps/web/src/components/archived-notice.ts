import { cn } from "../lib/utils";

/** #450/#452: the one-line "read-only while archived" notice under a control (Checklist, Team). Tokens only. */
export const ARCHIVED_NOTICE_CLASS = "m-0 w-fit [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";

/** #455: the same notice under a header cell: capped at `28ch` so it wraps rather than widening the control row. */
export const ARCHIVED_HEADER_NOTICE_CLASS = cn(ARCHIVED_NOTICE_CLASS, "max-w-[28ch]");
