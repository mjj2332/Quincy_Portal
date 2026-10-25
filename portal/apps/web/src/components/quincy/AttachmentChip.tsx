import type { ReactNode } from "react";
import { FileArchiveIcon, FileAudioIcon, FileIcon, FileImageIcon, FileSpreadsheetIcon, FileTextIcon, FileVideoIcon, PresentationIcon, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { attachmentKindFor, attachmentUrl as defaultAttachmentUrl, type AttachmentKind } from "../../lib/attachments-core";
import { Button } from "../reui/button";

/**
 * A file chip (#927 frame C4 `.cmp-file`, owner decision A4 for Attachments, #952): 40px (--space-6 + --space-2) on the raised chrome, a
 * softened hairline, 4px in from its ends, a 32px thumb, the name cut at 15ch with the full name on hover, the size, then its controls. The
 * note box's draft strip draws photos, videos and Attachments with it; a posted comment draws its Attachments with it as download links.
 *
 * Guest-safe (`guest/guest-boundary.guard.test.ts`): no `lib/api`, so the Review-link page can draw a guest note's files (#956).
 */
export const FILE_CHIP = "inline-flex h-[calc(var(--space-6)+var(--space-2))] max-w-full items-center gap-[var(--space-2)] rounded-[var(--radius-md)] border border-[color-mix(in_srgb,var(--border)_55%,transparent)] bg-card px-[var(--space-1)] text-foreground";
export const FILE_CHIP_META = "whitespace-nowrap [font:var(--type-eyebrow)] text-foreground-secondary";
/** The 32px thumb slot, for a spinner or a type icon (the frame's `KIND_ICON` in `.thumb`). */
export const FILE_CHIP_THUMB = "grid size-[var(--space-6)] shrink-0 place-items-center rounded-[var(--radius-sm)] bg-muted text-foreground-secondary";

/** A file's size as the frame writes it (C4): one decimal in MB, whole KB below that. */
export const fileSize = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;

const KIND_ICON: Record<AttachmentKind, LucideIcon> = {
  pdf: FileTextIcon, document: FileTextIcon, sheet: FileSpreadsheetIcon, slides: PresentationIcon, archive: FileArchiveIcon,
  image: FileImageIcon, audio: FileAudioIcon, video: FileVideoIcon, file: FileIcon,
};

/** A file name as its stem and its extension (with the dot), or the whole name and "" when it has none (a dotfile, or "v1.2 final"). */
export function splitFileName(name: string): [stem: string, extension: string] {
  const match = /^(.+?)(\.[^.\s]{1,10})$/u.exec(name);
  return match ? [match[1]!, match[2]!] : [name, ""];
}

/**
 * The chip's name (C4 `.nm`), at most 15ch, in the file's own case (the posted chip is a `Button`, whose label type is uppercase). Only the
 * stem is cut, so a long name keeps its extension in view ("Floor plan….zip"); the full name reads as one string and is on the chip's hover.
 */
export function FileChipName({ name }: { name: string }) {
  const [stem, extension] = splitFileName(name);
  return <span data-testid="file-chip-name" className="flex min-w-0 max-w-[15ch] whitespace-nowrap normal-case tracking-[var(--tracking-normal)] [font:var(--type-label)]">
    <span data-testid="file-chip-stem" className="min-w-0 truncate">{stem}</span>
    {extension && <span data-testid="file-chip-extension" className="shrink-0">{extension}</span>}
  </span>;
}

/** The thumb slot with the file's type icon, by its extension. */
export function AttachmentThumb({ name, className }: { name: string; className?: string }) {
  const Icon = KIND_ICON[attachmentKindFor(name)];
  return <span aria-hidden="true" className={cn(FILE_CHIP_THUMB, className)}><Icon className="size-4" /></span>;
}

/**
 * The posted Attachments of one run of the document, as a list. Inside `.rich-text` the unlayered `.rich-text ul` (a bullet, an indent)
 * outranks `list-none p-0`, so the list carries `rich-text__attachment-list`, which `app.css` takes them off again, as for the task list.
 */
export function AttachmentList({ children }: { children: ReactNode }) {
  return <ul role="list" aria-label="Attachments" data-testid="attachment-list" className="rich-text__attachment-list m-0 flex list-none flex-wrap gap-[calc(var(--space-1)*1.5)] p-0">{children}</ul>;
}

/**
 * One posted Attachment: the installed `Button` as a same-origin download link (the server forces the download, so the page never
 * navigates). 44px on a coarse pointer. With no name (the server no longer serves the file: its comment or Project went), a plain
 * "File unavailable" chip that does nothing.
 */
export function AttachmentChip({ attachmentId, name, bytes, attachmentUrl = defaultAttachmentUrl }: { attachmentId: string; name?: string; bytes?: number; attachmentUrl?: (attachmentId: string) => string }) {
  if (!name) {
    return <li className="min-w-0 max-w-full">
      <span data-testid="attachment-chip" data-state="unavailable" className={cn(FILE_CHIP, "pe-[var(--space-2)] text-foreground-secondary")}>
        <AttachmentThumb name="" />
        <FileChipName name="File unavailable" />
      </span>
    </li>;
  }
  const size = typeof bytes === "number" ? fileSize(bytes) : null;
  return <li className="min-w-0 max-w-full">
    <Button
      variant="ghost" nativeButton={false} data-testid="attachment-chip" data-state="ready"
      aria-label={size ? `Download ${name}, ${size}` : `Download ${name}`} title={name}
      className={cn(FILE_CHIP, "justify-start pe-[var(--space-2)] normal-case tracking-[var(--tracking-normal)] hover:bg-muted pointer-coarse:min-h-11")}
      render={<a href={attachmentUrl(attachmentId)} download />}
    >
      <AttachmentThumb name={name} />
      <FileChipName name={name} />
      {size && <span className={FILE_CHIP_META}>{size}</span>}
    </Button>
  </li>;
}
