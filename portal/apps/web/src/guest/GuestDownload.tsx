import { DownloadIcon, LockIcon } from "lucide-react";
import type { GuestVersionDto, GuestVideoDto } from "@quincy/shared";
import { Button } from "../components/reui/button";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/**
 * Download for the Version on screen (#741 14-ui-guest). The server decides: `downloadUrl` is non-null only for a live Release on a link that allows downloads, with the Video not locked, so the
 * page never builds the URL. It is a plain anchor (the browser's own download, resumable, with the attachment name the server sends). A released premium Video that is not unlocked gets the reason
 * instead of a button; an unreleased Version, or a link that does not allow downloads, gets nothing.
 * Whether the route needs a verified guest is the link's download policy (ADR 0025): the Delivery review link needs no code, so there `downloadOpen` is true and it is the anchor
 * straight away; on any other link an unverified guest (`downloadOpen` false) gets a button that opens the verify dialog (`onNeedVerify`). Once verified it renders as the anchor and the guest presses it again (a click
 * made for them after the async verification would be blocked as a popup).
 */
export function GuestDownload({ video, version, allowDownload, downloadOpen, onNeedVerify }: { video: Pick<GuestVideoDto, "premium" | "unlocked">; version: Pick<GuestVersionDto, "released" | "downloadUrl">; allowDownload: boolean; /** A download needs no code now: the guest is verified, or the link's download policy needs none. */ downloadOpen: boolean; onNeedVerify: () => void }) {
  if (!allowDownload) return null;
  if (version.downloadUrl !== null && !downloadOpen) {
    return <Button type="button" variant="outline" data-testid="guest-download" className={TOUCH} onClick={onNeedVerify}><DownloadIcon aria-hidden="true" />Download</Button>;
  }
  if (version.downloadUrl !== null) {
    return <Button variant="outline" nativeButton={false} data-testid="guest-download" className={TOUCH} render={<a href={version.downloadUrl} download />}><DownloadIcon aria-hidden="true" />Download</Button>;
  }
  return <GuestDownloadLocked video={video} version={version} allowDownload={allowDownload} />;
}

/**
 * The reason a released premium Video has no Download: the studio has not unlocked it. The desktop delivery row shows it in Download's place (`GuestDownload`); a phone, which has
 * no delivery row, shows it in the quiet line at the end of the notes (#879 PR 3b, S2). The same gates either way: downloads allowed, no URL, released, premium, not unlocked.
 */
export function GuestDownloadLocked({ video, version, allowDownload }: { video: Pick<GuestVideoDto, "premium" | "unlocked">; version: Pick<GuestVersionDto, "released" | "downloadUrl">; allowDownload: boolean }) {
  if (!allowDownload || version.downloadUrl !== null || !version.released || !video.premium || video.unlocked) return null;
  return <span data-testid="guest-download-locked" className="inline-flex items-center gap-[var(--space-1)] text-foreground-secondary [font:var(--type-label)]"><LockIcon aria-hidden="true" className="size-3" />Premium video: the download opens once the studio unlocks it.</span>;
}
