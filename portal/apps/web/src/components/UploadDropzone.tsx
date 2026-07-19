import { useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { isAcceptedPhotoFilename } from "@quincy/shared";
import { apiPost } from "../lib/api";

type PresignResponse = {
  assetId?: string;
  key: string;
  uploadId?: string;
  partUrls?: string[];
  partBytes?: number;
  /** Reserved for the development uploader response. */
  devDirect?: boolean;
};

type UploadProgress = { name: string; percent: number; state: "waiting" | "uploading" | "complete" | "failed"; error?: string };

interface UploadDropzoneProps {
  projectId: string;
  onComplete: () => Promise<void> | void;
  onToast: (message: string, tone?: "error" | "success") => void;
}

async function putMultipart(file: File, presign: PresignResponse): Promise<void> {
  if (presign.devDirect) {
    const response = await fetch(`/api/uploads/direct?key=${encodeURIComponent(presign.key)}`, { method: "PUT", credentials: "include", headers: { "content-type": "image/jpeg" }, body: file });
    if (!response.ok) throw new Error("Direct upload failed.");
    return;
  }
  if (!presign.partUrls?.length || !presign.uploadId || !presign.partBytes) throw new Error("Upload service returned an incomplete multipart session.");
  const parts: { partNumber: number; etag: string }[] = [];
  for (let index = 0; index < presign.partUrls.length; index += 1) {
    const start = index * presign.partBytes;
    const response = await fetch(presign.partUrls[index]!, { method: "PUT", body: file.slice(start, start + presign.partBytes) });
    if (!response.ok) throw new Error(`Part ${index + 1} could not be uploaded.`);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error(`Part ${index + 1} returned no ETag.`);
    parts.push({ partNumber: index + 1, etag });
  }
  await apiPost("/api/uploads/complete", { projectId: presign.key.split("/")[1], key: presign.key, uploadId: presign.uploadId, parts, originalFilename: file.name });
}

export function UploadDropzone({ projectId, onComplete, onToast }: UploadDropzoneProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  function update(filename: string, patch: Partial<UploadProgress>) {
    setProgress((items) => items.map((item) => item.name === filename ? { ...item, ...patch } : item));
  }

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
      await apiPost<{ manifestId: string }, { filenames: string[] }>(`/api/projects/${projectId}/upload-manifest`, { filenames: accepted.map((file) => file.name) });
      let next = 0;
      const worker = async () => {
        while (next < accepted.length) {
          const file = accepted[next++];
          if (!file) return;
          update(file.name, { state: "uploading", percent: 8 });
          try {
            const presign = await apiPost<PresignResponse, { projectId: string; filename: string; bytes: number }>("/api/uploads/presign", { projectId, filename: file.name, bytes: file.size });
            update(file.name, { percent: 35 });
            await putMultipart(file, presign);
            update(file.name, { state: "complete", percent: 100 });
          } catch (error) {
            update(file.name, { state: "failed", error: error instanceof Error ? error.message : "Upload failed." });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, accepted.length) }, worker));
      await onComplete();
      onToast("Upload processing is complete.");
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

  return (
    <section className={`upload-zone ${isDragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={onDrop}>
      <input ref={fileInput} className="sr-only" type="file" accept=".jpg,.jpeg,image/jpeg" multiple onChange={onChange} />
      <div className="ey">RAW capture upload</div>
      <div className="upload-zone__title serif">Drop JPEG frames here</div>
      <p>JPEG only. The upload manifest verifies the expected capture count before ingest.</p>
      <button className="button button--secondary" type="button" disabled={isUploading} onClick={() => fileInput.current?.click()}>{isUploading ? "Uploading…" : "Choose files"}</button>
      {progress.length > 0 && <div className="upload-progress" aria-live="polite"><div className="meter"><i style={{ width: `${overall}%` }} /></div><span className="ey">{overall}% uploaded</span>{progress.map((item) => <div className="upload-file" key={item.name}><span>{item.name}</span><span>{item.state === "failed" ? item.error : `${item.percent}%`}</span></div>)}</div>}
      {rejected.length > 0 && <div className="upload-rejected" role="status"><strong>Not uploaded — JPEG only:</strong> {rejected.join(", ")}</div>}
    </section>
  );
}
