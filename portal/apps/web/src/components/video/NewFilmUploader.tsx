import { useId, useState } from "react";
import { Film } from "lucide-react";
import type { Mp4Probe } from "@quincy/shared";
import { Button } from "../quincy/Button";
import { FileDropzone, FilePickButton } from "../quincy/FileDropzone";
import { Notice } from "../quincy/Notice";
import { QuincyField } from "../quincy/QuincyField";
import { checkVideoFile, defaultFilmTitle } from "../../lib/video-upload";
import { VIDEO_ACCEPT } from "./VideoCard";
import { formatDuration, formatFps } from "./video-format";

const HINT = "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary";

type Picked = { file: File; probe: Mp4Probe; cautions: string[] };

/** The "new film" drop target and its title form (#741 4d-i). The file is checked in the browser first; nothing is requested from the server until Upload. */
export function NewFilmUploader({ atUploadCap, onStart }: {
  atUploadCap: boolean;
  onStart: (input: Picked & { title: string }) => void;
}) {
  const titleId = useId();
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [title, setTitle] = useState("");

  async function receive(file: File) {
    setProblem(null); setPicked(null); setChecking(true);
    const result = await checkVideoFile(file);
    setChecking(false);
    if (!result.ok) { setProblem(result.message); return; }
    setPicked({ file, probe: result.probe, cautions: result.cautions });
    setTitle(defaultFilmTitle(file.name));
  }

  const trimmed = title.trim();
  const titleError = picked && (trimmed.length === 0 ? "Give the film a title." : trimmed.length > 200 ? "Keep the title to 200 characters." : undefined);

  return <div className="grid gap-[var(--space-3)]" data-testid="new-film-uploader">
    <FileDropzone
      onFile={(file) => void receive(file)}
      disabled={checking || atUploadCap}
      data-testid="new-film-dropzone"
      className="flex flex-wrap items-center gap-[var(--space-4)] p-[var(--space-4)] bg-card border-dashed border-[length:var(--border-width-hair)] border-border data-[dragging=true]:bg-secondary"
    >
      <Film aria-hidden="true" className="size-7 shrink-0 text-foreground-secondary" />
      <div className="grid min-w-[16rem] flex-1 gap-[var(--space-1)]">
        <strong className="[font:var(--weight-medium)_var(--text-base)/var(--leading-normal)_var(--font-sans)]">Drop an MP4 to start a new film</strong>
        <span className={HINT}>H.264, constant frame rate, up to 2 GB. Frame rate and timecode are read from the file.</span>
        {atUploadCap && <span className={HINT}>Three uploads are running. Finish or cancel one first.</span>}
      </div>
      <FilePickButton accept={VIDEO_ACCEPT} variant="primary" className="min-h-[44px]" disabled={checking || atUploadCap} onFile={(file) => void receive(file)}>{checking ? "Checking…" : "Upload new film"}</FilePickButton>
    </FileDropzone>
    {problem && <Notice tone="critical" role="alert" data-testid="new-film-problem">{problem}</Notice>}
    {picked && <form
      className="grid gap-[var(--space-3)] p-[var(--space-4)] bg-secondary border-solid border-[length:var(--border-width-hair)] border-border"
      data-testid="new-film-form"
      onSubmit={(event) => { event.preventDefault(); if (titleError) return; onStart({ ...picked, title: trimmed }); setPicked(null); setTitle(""); }}
    >
      <QuincyField id={titleId} label="Film title" value={title} maxLength={400} onChange={(event) => setTitle(event.target.value)} error={titleError} />
      <p className={HINT} data-testid="new-film-probe">{`${picked.file.name} · ${formatFps(picked.probe.fps)} fps · ${picked.probe.width}×${picked.probe.height} · ${formatDuration(picked.probe.durationMs)}`}</p>
      {picked.cautions.map((caution) => <Notice key={caution} tone="caution" role="status">{caution}</Notice>)}
      <div className="flex flex-wrap gap-[var(--space-2)]">
        <Button type="submit" className="min-h-[44px]" disabled={Boolean(titleError)}>Upload</Button>
        <Button type="button" variant="secondary" className="min-h-[44px]" onClick={() => { setPicked(null); setTitle(""); }}>Cancel</Button>
      </div>
    </form>}
  </div>;
}
