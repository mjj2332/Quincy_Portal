import type { QueryClient } from "@tanstack/react-query";
import { filmTitleFromFilename, type Role } from "@quincy/shared";
import { Button } from "../quincy/Button";
import { FileDropzone, FilePickButton } from "../quincy/FileDropzone";
import { Notice } from "../quincy/Notice";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";
import { Spinner } from "../reui/spinner";
import { addNewFilms, removeNewFilm, retryNewFilm, uploadNewFilms, useNewFilmBatch, type NewFilmEntry } from "../../lib/video-upload-store";
import { VIDEO_ACCEPT } from "./VideoCard";
import { formatDuration, formatFps } from "./video-format";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

function facts(entry: NewFilmEntry) {
  const probe = entry.probe;
  return probe ? `${formatFps(probe.fps)} fps · ${probe.width}×${probe.height} · ${formatDuration(probe.durationMs)}` : null;
}

/**
 * The "new films" drop box and its list (#845). Every picked file is checked in the browser first; nothing is requested from the server until Upload. Each film
 * is titled by its file name (#828), so there is no title to type. The queue lives in the upload store, so it outlives this panel; a started film leaves the
 * list for the upload tray. The drop box is never locked: more films can be added while others are checking or uploading.
 */
export function NewFilmUploader({ userId, queryClient, projectId, role }: { userId: string | null; queryClient: QueryClient | undefined; projectId: string; role: Role }) {
  const rows = useNewFilmBatch(userId, projectId);
  const receive = (files: File[]) => { if (userId) addNewFilms({ userId, queryClient, projectId, role, files }); };
  const waiting = rows.filter((row) => row.status === "ready");
  // A caution several rows carry (the fast-start warning) is said once above the list; one unique to a row stays on it.
  const counts = new Map<string, number>();
  for (const row of rows) for (const caution of new Set(row.cautions)) counts.set(caution, (counts.get(caution) ?? 0) + 1);
  const shared = [...counts].filter(([, count]) => count > 1).map(([caution]) => caution);
  const checking = rows.some((row) => row.status === "checking");

  return <div className="grid gap-[var(--space-3)]" data-testid="new-film-uploader">
    <FileDropzone multiple onFiles={receive} data-testid="new-film-dropzone" className="upload-zone">
      <div className="ey">New films</div>
      <h2 className="upload-zone__title">Drop MP4 or MOV films here</h2>
      <p>H.264, constant frame rate, up to 2 GB each. Frame rate and timecode are read from each file.</p>
      <FilePickButton multiple accept={VIDEO_ACCEPT} variant="secondary" className={`min-h-[44px] ${TOUCH}`} onFiles={receive}>Choose files</FilePickButton>
    </FileDropzone>
    {shared.length > 0 && <div className="grid gap-[var(--space-2)]" data-testid="new-film-shared-cautions">
      {shared.map((caution) => <Notice key={caution} tone="caution" role="status">{caution}</Notice>)}
    </div>}
    {rows.length > 0 && <ItemGroup>
      {rows.map((row) => {
        const line = facts(row);
        const title = filmTitleFromFilename(row.file.name);
        const detail = `${row.file.name}${line ? ` · ${line}` : ""}`;
        return <Item key={row.key} role="listitem" variant="outline" data-testid="new-film-row" data-status={row.status} className="flex-wrap rounded-[var(--radius-card)]">
          <ItemContent className="min-w-[12rem]">
            <ItemTitle className="font-normal [overflow-wrap:anywhere]">{title}</ItemTitle>
            {detail !== title && <ItemDescription className="line-clamp-none [overflow-wrap:anywhere]">{detail}</ItemDescription>}
            {row.status === "checking" && <ItemDescription className="line-clamp-none flex items-center gap-[var(--space-2)]" role="status"><Spinner aria-hidden="true" />Checking…</ItemDescription>}
            {row.status === "queued" && <ItemDescription className="line-clamp-none" role="status">Waiting to upload</ItemDescription>}
            {row.cautions.filter((caution) => !shared.includes(caution)).map((caution) => <Notice key={caution} tone="caution" role="status">{caution}</Notice>)}
            {(row.status === "rejected" || row.status === "refused") && row.message && <Notice tone="critical" role="alert">{row.message}</Notice>}
          </ItemContent>
          <ItemActions>
            {row.status === "refused" && <Button type="button" variant="secondary" className={TOUCH} aria-label={`Retry ${row.file.name}`} onClick={() => retryNewFilm(row.key)}>Retry</Button>}
            <Button type="button" variant="text" className={TOUCH} aria-label={`Remove ${row.file.name}`} onClick={() => removeNewFilm(row.key)}>Remove</Button>
          </ItemActions>
        </Item>;
      })}
    </ItemGroup>}
    {waiting.length > 0 && userId && <div className="flex flex-wrap gap-[var(--space-2)]">
      <Button type="button" className="min-h-[44px]" disabled={checking} onClick={() => uploadNewFilms(userId, projectId)}>{`Upload ${waiting.length} film${waiting.length === 1 ? "" : "s"}`}</Button>
    </div>}
  </div>;
}
