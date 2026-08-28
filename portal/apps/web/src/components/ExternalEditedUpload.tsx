import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { isAcceptedPhotoFilename } from "@quincy/shared";
import { apiPost } from "../lib/api";
import { decodeExternalResponse } from "../lib/external-api-response";

type UploadPart = { partNumber: number; uploadUrl: string; expectedBytes: number };
type UploadPlan = { sessionToken: string; parts: UploadPart[]; completeUrl: string; abortUrl: string };

export function ExternalEditedUpload({ projectId, onComplete, onToast }: { projectId: string; onComplete: () => Promise<void> | void; onToast: (message: string, tone?: "error" | "success") => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Record<string, number>>({});

  async function uploadFile(file: File) {
    const raw = await apiPost<unknown, { projectId: string; collection: "edited"; filename: string; bytes: number }>("/api/external-uploads", { projectId, collection: "edited", filename: file.name, bytes: file.size });
    const plan = decodeExternalResponse("external-upload", raw) as UploadPlan;
    try {
      for (const part of plan.parts) {
        const partSize = plan.parts.length > 1 ? plan.parts[0]!.expectedBytes : part.expectedBytes;
        const start = (part.partNumber - 1) * partSize;
        const response = await fetch(part.uploadUrl, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(part.expectedBytes), "X-Content-Type-Options": "nosniff" }, body: file.slice(start, start + part.expectedBytes) });
        if (!response.ok) throw new Error(`Part ${part.partNumber} could not be uploaded.`);
        setProgress((current) => ({ ...current, [file.name]: Math.round((part.partNumber / plan.parts.length) * 100) }));
      }
      const completed = await apiPost<unknown, Record<string, never>>(plan.completeUrl, {});
      decodeExternalResponse("external-upload-complete", completed);
      await onComplete();
    } catch (error) {
      try { await fetch(plan.abortUrl, { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } }); } catch { /* the server sweep owns recovery */ }
      throw error;
    }
  }

  async function receive(files: File[]) {
    const accepted = files.filter((file) => isAcceptedPhotoFilename(file.name));
    const rejected = files.filter((file) => !isAcceptedPhotoFilename(file.name)).map((file) => file.name);
    if (rejected.length) onToast(`Not uploaded — JPEG only: ${rejected.join(", ")}`, "error");
    if (!accepted.length) return;
    setBusy(true);
    try {
      for (const file of accepted) {
        setProgress((current) => ({ ...current, [file.name]: 0 }));
        await uploadFile(file);
      }
      onToast("Edited uploads are processing. They will appear here when ready.");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "The edited upload could not be completed.", "error");
    } finally { setBusy(false); }
  }

  function drop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setDragging(false); void receive(Array.from(event.dataTransfer.files)); }
  function change(event: ChangeEvent<HTMLInputElement>) { if (event.target.files) void receive(Array.from(event.target.files)); event.target.value = ""; }

  return <section className={`upload-zone ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
    <input ref={inputRef} className="sr-only" type="file" accept=".jpg,.jpeg,image/jpeg" multiple onChange={change} />
    <div className="ey">Edited image upload</div>
    <div className="upload-zone__title serif">Drop JPEG frames here</div>
    <p>Uploads stay inside Quincy Portal and are published to the Edited collection after integrity and rendition checks.</p>
    <button className="button button--secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>{busy ? "Uploading…" : "Choose files"}</button>
    {Object.keys(progress).length > 0 && <div className="upload-progress" aria-live="polite">{Object.entries(progress).map(([name, value]) => <div className="upload-file" key={name}><span>{name}</span><span>{value}%</span></div>)}</div>}
  </section>;
}
