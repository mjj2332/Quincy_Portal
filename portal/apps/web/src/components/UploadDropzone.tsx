import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { isAcceptedPhotoFilename } from "@quincy/shared";
import { ApiError, apiPost } from "../lib/api";
import { uploadMultipartFile, type MultipartPresign } from "../lib/multipart-upload";
import { useProjectAccessTermination } from "../lib/project-data";
import { useSession } from "../lib/auth";
import { ExternalEditedUpload } from "./ExternalEditedUpload";
import { buttonClasses } from "./quincy/Button";

type PresignResponse = MultipartPresign & {
  assetId?: string;
  key: string;
  uploadId?: string;
  partUrls?: string[];
  partBytes?: number;
  /** Reserved for the development uploader response. */
  devDirect?: boolean;
};

type CompleteResponse = { assetId: string; jobId?: string; publishStatus?: "pending" | "ready" | "failed"; error?: string };
type JobStatus = "queued" | "running" | "done" | "failed" | "stuck";
type Job = { id: string; status: JobStatus; error: string | null };
type UploadProgress = { name: string; percent: number; state: "waiting" | "uploading" | "publishing" | "complete" | "failed"; jobId?: string; error?: string };

interface UploadDropzoneProps {
  projectId: string;
  collection?: "raw" | "edited";
  onComplete: () => Promise<void> | void;
  onToast: (message: string, tone?: "error" | "success") => void;
}

export function UploadDropzone({ projectId, collection = "raw", onComplete, onToast }: UploadDropzoneProps) {
  const session = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const terminateOnUnauthorized = useProjectAccessTermination();
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  function update(filename: string, patch: Partial<UploadProgress>) {
    setProgress((items) => items.map((item) => item.name === filename ? { ...item, ...patch } : item));
  }

  const publishingJobIds = progress
    .filter((item) => item.state === "publishing" && item.jobId)
    .map((item) => item.jobId!);
  const isExternalEditor = collection === "edited" && session.data?.user.role === "external_editor";

  useEffect(() => {
    if (isExternalEditor || !publishingJobIds.length) return;
    let cancelled = false;
    const refreshPublishing = async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/manual-upload-jobs`, { credentials: "same-origin" });
        if (response.status === 401) {
          terminateOnUnauthorized(new ApiError("Your session is no longer available.", 401));
          return;
        }
        if (!response.ok) return;
        const body = await response.json() as { jobs?: Job[] };
        if (cancelled) return;
        const statuses = new Map((body.jobs ?? []).map((job) => [job.id, job]));
        let completed = false;
        setProgress((items) => items.map((item) => {
          if (item.state !== "publishing" || !item.jobId) return item;
          const job = statuses.get(item.jobId);
          if (job?.status === "done") { completed = true; return { ...item, state: "complete", percent: 100, error: undefined }; }
          if (job?.status === "failed" || job?.status === "stuck") return { ...item, state: "failed", error: job.error ?? "Dropbox publishing failed. An administrator can retry it from the jobs panel." };
          return item;
        }));
        if (completed) await onCompleteRef.current();
      } catch {
        // Keep the durable job visible as publishing; the next poll can recover a transient error.
      }
    };
    void refreshPublishing();
    const interval = window.setInterval(() => void refreshPublishing(), 5_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [isExternalEditor, projectId, publishingJobIds.join(","), terminateOnUnauthorized]);

  async function upload(files: File[]) {
    const accepted = files.filter((file) => isAcceptedPhotoFilename(file.name));
    const refused = files.filter((file) => !isAcceptedPhotoFilename(file.name)).map((file) => file.name);
    setRejected(refused);
    if (!accepted.length) {
      if (refused.length) onToast("Only JPEG files can be uploaded.", "error");
      return;
    }

    setIsUploading(true);
    setProgress(accepted.map((file) => ({ name: file.name, percent: 0, state: "waiting" })));
    try {
      const manifestId = collection === "raw"
        ? (await apiPost<{ manifestId: string }, { filenames: string[] }>(`/api/projects/${projectId}/upload-manifest`, { filenames: accepted.map((file) => file.name) })).manifestId
        : undefined;
      let next = 0;
      let succeeded = 0;
      let failed = 0;
      const worker = async () => {
        while (next < accepted.length) {
          const file = accepted[next++];
          if (!file) return;
          update(file.name, { state: "uploading", percent: 8 });
          try {
            const presign = await apiPost<PresignResponse, { projectId: string; filename: string; bytes: number; collection: "raw" | "edited" }>("/api/uploads/presign", { projectId, filename: file.name, bytes: file.size, collection });
            update(file.name, { percent: 35 });
            const completed = await uploadMultipartFile(file, presign, `/api/uploads/direct?key=${encodeURIComponent(presign.key)}`);
            const result = await apiPost<CompleteResponse, { projectId: string; key: string; uploadId?: string; parts?: { partNumber: number; etag: string }[]; originalFilename: string; collection: "raw" | "edited"; manifestId?: string }>("/api/uploads/complete", { projectId, key: presign.key, uploadId: completed.uploadId, parts: completed.parts, originalFilename: file.name, collection, manifestId });
            if (result.publishStatus === "failed") { failed += 1; update(file.name, { state: "failed", percent: 100, jobId: result.jobId, error: result.error ?? "Dropbox publishing failed. An administrator can retry it from the jobs panel." }); }
            else if (result.publishStatus === "pending") { succeeded += 1; update(file.name, { state: "publishing", percent: 100, jobId: result.jobId }); }
            else { succeeded += 1; update(file.name, { state: "complete", percent: 100 }); }
          } catch (error) {
            failed += 1;
            update(file.name, { state: "failed", error: error instanceof Error ? error.message : "Upload failed." });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, accepted.length) }, worker));
      await onComplete();
      if (collection === "edited") {
        if (succeeded && failed) onToast(`${succeeded} edited upload${succeeded === 1 ? " is" : "s are"} publishing to Dropbox; ${failed} failed.`);
        else if (succeeded) onToast("Edited uploads are publishing to Dropbox. They will appear here when ready.");
        else onToast("Edited uploads could not be queued for Dropbox publishing.", "error");
      } else {
        onToast("Upload processing is complete.");
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : "The upload could not be started.", "error");
    } finally {
      setIsUploading(false);
    }
  }

  function receive(files: FileList | File[]) { void upload(Array.from(files)); }
  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setIsDragging(false); receive(event.dataTransfer.files); }
  function onChange(event: ChangeEvent<HTMLInputElement>) { if (event.target.files) receive(event.target.files); event.target.value = ""; }
  const overall = progress.length ? Math.round(progress.reduce((sum, item) => sum + item.percent, 0) / progress.length) : 0;
  if (isExternalEditor) return <ExternalEditedUpload projectId={projectId} onComplete={onComplete} onToast={onToast} />;

  return (
    <section className={`upload-zone ${isDragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={onDrop}>
      <input ref={fileInput} className="sr-only" type="file" accept=".jpg,.jpeg,image/jpeg" multiple onChange={onChange} />
      <div className="ey">{collection === "raw" ? "RAW capture upload" : "Edited image upload"}</div>
      <div className="upload-zone__title serif">Drop JPEG frames here</div>
      <p>{collection === "raw" ? "JPEG only. The upload manifest verifies the expected capture count before ingest." : "JPEG only. Each upload is published to Dropbox before it appears in the Edited collection."}</p>
      <button className={buttonClasses("secondary")} type="button" disabled={isUploading} onClick={() => fileInput.current?.click()}>{isUploading ? "Uploading…" : "Choose files"}</button>
      {progress.length > 0 && <div className="upload-progress" aria-live="polite"><div className="meter"><i style={{ width: `${overall}%` }} /></div><span className="ey">{overall}% uploaded</span>{progress.map((item) => <div className="upload-file" key={item.name}><span>{item.name}</span><span>{item.state === "failed" ? item.error : item.state === "publishing" ? "Publishing to Dropbox…" : `${item.percent}%`}</span></div>)}</div>}
      {rejected.length > 0 && <div className="upload-rejected" role="status"><strong>Not uploaded — JPEG only:</strong> {rejected.join(", ")}</div>}
    </section>
  );
}
