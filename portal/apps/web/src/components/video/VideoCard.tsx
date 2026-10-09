import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { VideoDto } from "@quincy/shared";
import { Badge } from "../reui/badge";
import { Button } from "../quincy/Button";
import { Frame, FramePanel } from "../reui/frame";
import { ItemGroup, Item, ItemContent, ItemDescription, ItemTitle } from "../reui/item";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../reui/popover";
import { Spinner } from "../reui/spinner";
import { LazyImage } from "../LazyImage";
import { Notice } from "../quincy/Notice";
import { FilePickButton } from "../quincy/FileDropzone";
import type { VideoUploadState } from "../../lib/video-upload";
import { formatDuration, formatFps, formatVideoDate } from "./video-format";

const META = "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";

export const VIDEO_ACCEPT = ".mp4,video/mp4";

/**
 * One Video as a card (#741 4d-i): poster, newest Version, duration, a Versions list, and who is uploading. The Open review action,
 * selection and note chips arrive in later slices. `onVersionFile` checks and starts the upload and returns a message when the file is refused.
 */
export function VideoCard({ video, canUpload, myUpload, atUploadCap, onVersionFile }: {
  video: VideoDto;
  canUpload: boolean;
  /** My running upload of a new Version of this Video, if any. */
  myUpload?: VideoUploadState;
  /** Three uploads are already running (the server allows three): Upload is held back. */
  atUploadCap?: boolean;
  onVersionFile: (video: VideoDto, file: File) => Promise<string | null>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const newest = video.versions.find((version) => version.current) ?? video.versions[0]!;
  const nextNumber = Math.max(...video.versions.map((version) => version.version)) + 1;
  const portrait = newest.height > newest.width;
  const uploadingElsewhere = !myUpload && video.uploading;
  const busy = Boolean(myUpload || video.uploading);
  const count = video.versions.length;

  return <Frame data-testid="video-card" aria-label={video.title} role="group">
    <FramePanel className="flex flex-col gap-[var(--space-3)] p-0">
      <div data-testid="video-card-poster" data-orientation={portrait ? "portrait" : "landscape"} className="relative aspect-video overflow-hidden bg-invert text-invert-foreground">
        {newest.posterUrl
          ? <LazyImage src={newest.posterUrl} alt={`Poster of ${video.title}`} className="h-full w-full object-contain" />
          : <div data-testid="video-card-no-poster" className="flex h-full w-full items-center justify-center [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] opacity-70">No poster</div>}
        <Badge variant="secondary" className="absolute left-[var(--space-2)] top-[var(--space-2)]">{`v${newest.version}`}</Badge>
        {video.premium && <Badge variant="warning" className="absolute right-[var(--space-2)] top-[var(--space-2)]">Premium</Badge>}
        <Badge variant="invert" className="absolute bottom-[var(--space-2)] right-[var(--space-2)] border border-invert-foreground/20 [font-family:var(--font-mono)]">{formatDuration(newest.durationMs)}</Badge>
      </div>
      <div className="grid gap-[var(--space-3)] px-[var(--space-4)] pb-[var(--space-4)]">
        <div className="grid gap-[var(--space-1)]">
          <h3 className="serif [font:var(--type-h3)]">{video.title}</h3>
          <div className="flex flex-col items-start gap-[var(--space-1)]">
            <Popover>
              <PopoverTrigger render={<Button type="button" variant="text" className="-ml-[var(--space-2)] px-[var(--space-2)] pointer-coarse:min-h-11 max-[721px]:min-h-11" />}>{count === 1 ? "1 version" : `${count} versions`}<ChevronDown aria-hidden="true" className="size-3" /></PopoverTrigger>
              <PopoverContent align="start" aria-label={`Versions of ${video.title}`}>
                <PopoverTitle>Versions</PopoverTitle>
                <ItemGroup>
                  {video.versions.map((version) => <Item key={version.assetId} size="xs">
                    <ItemContent>
                      <ItemTitle>{`v${version.version}`}</ItemTitle>
                      <ItemDescription>{`${version.uploadedBy.name} · ${formatVideoDate(version.createdAt)} · ${formatFps(version.fps)}\u00a0fps`}</ItemDescription>
                    </ItemContent>
                  </Item>)}
                </ItemGroup>
              </PopoverContent>
            </Popover>
            <p className={META} data-testid="video-card-meta">{`${count > 1 ? `v${newest.version} by` : "by"} ${newest.uploadedBy.name} · ${formatVideoDate(newest.createdAt)} · ${formatFps(newest.fps)}\u00a0fps`}</p>
          </div>
        </div>
        {myUpload && <p role="status" className={`${META} flex items-center gap-[var(--space-2)]`} data-testid="video-card-uploading"><Spinner aria-hidden="true" role="presentation" className="size-3.5" />{`Uploading v${myUpload.version ?? nextNumber} · ${myUpload.percent}%`}</p>}
        {uploadingElsewhere && <p role="status" className={`${META} flex items-center gap-[var(--space-2)]`} data-testid="video-card-uploading-other"><Spinner aria-hidden="true" role="presentation" className="size-3.5" />{`${uploadingElsewhere.uploader.name} is uploading v${uploadingElsewhere.version}`}</p>}
        {message && <Notice tone="critical" role="alert">{message}</Notice>}
        {canUpload && !busy && <div className="flex flex-wrap gap-[var(--space-2)]">
          <FilePickButton
            accept={VIDEO_ACCEPT}
            variant="secondary"
            className="min-h-[44px]"
            disabled={checking || atUploadCap}
            onFile={(file) => { setMessage(null); setChecking(true); void onVersionFile(video, file).then((refused) => setMessage(refused)).finally(() => setChecking(false)); }}
          >{checking ? "Checking…" : `Upload v${nextNumber}`}</FilePickButton>
          {atUploadCap && <span className={META}>Three uploads are running. Finish or cancel one first.</span>}
        </div>}
      </div>
    </FramePanel>
  </Frame>;
}
