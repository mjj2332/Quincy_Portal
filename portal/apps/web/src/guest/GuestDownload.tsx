import { DownloadIcon, LockIcon } from "lucide-react";
import type { GuestVersionDto, GuestVideoDto } from "@quincy/shared";
import { Button } from "../components/reui/button";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/**
 * Download for the Version on screen (#741 14-ui-guest). The server decides: `downloadUrl` is non-null only for a live Release on a link that allows downloads, with the Video not locked, so the
 * page never builds the URL. It is a plain anchor (the browser's own download, resumable, with the attachment name the server sends). A released premium Video that is not unlocked gets the reason
 * instead of a button; an unreleased Version, or a link that does not allow downloads, gets nothing.
 */
export function GuestDownload({ video, version, allowDownload }: { video: Pick<GuestVideoDto, "premium" | "unlocked">; version: Pick<GuestVersionDto, "released" | "downloadUrl">; allowDownload: boolean }) {
  if (!allowDownload) return null;
  if (version.downloadUrl !== null) {
    return <Button variant="outline" nativeButton={false} data-testid="guest-download" className={TOUCH} render={<a href={version.downloadUrl} download />}><DownloadIcon aria-hidden="true" />Download</Button>;
  }
  if (version.released && video.premium && !video.unlocked) {
    return <span data-testid="guest-download-locked" className="inline-flex items-center gap-[var(--space-1)] text-foreground-secondary [font:var(--type-label)]"><LockIcon aria-hidden="true" className="size-3" />Premium video: the download opens once the studio unlocks it.</span>;
  }
  return null;
}
