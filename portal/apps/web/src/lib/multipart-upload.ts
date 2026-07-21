export type MultipartPresign = {
  key: string;
  uploadId?: string;
  partUrls?: string[];
  partBytes?: number;
  devDirect?: boolean;
};

export type CompletedMultipart = { uploadId?: string; parts?: { partNumber: number; etag: string }[] };

/** Exported to test exact boundaries with tiny parts; production passes the R2 reservation size. */
export function multipartSlices(bytes: number, partBytes: number) {
  if (!Number.isInteger(bytes) || bytes <= 0 || !Number.isInteger(partBytes) || partBytes <= 0) throw new Error("Multipart bytes and part size must be positive integers.");
  return Array.from({ length: Math.ceil(bytes / partBytes) }, (_, index) => ({ start: index * partBytes, end: Math.min(bytes, (index + 1) * partBytes) }));
}

/** Upload bytes directly to R2. The API only receives the small completion payload. */
export async function uploadMultipartFile(file: File, presign: MultipartPresign, devDirectUrl: string, onProgress?: (percent: number) => void): Promise<CompletedMultipart> {
  if (presign.devDirect) {
    const response = await fetch(devDirectUrl, { method: "PUT", credentials: "include", headers: { "content-type": file.type }, body: file });
    if (!response.ok) throw new Error("Direct upload failed.");
    onProgress?.(100);
    return {};
  }
  if (!presign.partUrls?.length || !presign.uploadId || !presign.partBytes) throw new Error("Upload service returned an incomplete multipart session.");
  const parts: { partNumber: number; etag: string }[] = [];
  const slices = multipartSlices(file.size, presign.partBytes);
  if (slices.length !== presign.partUrls.length) throw new Error("Upload service returned an invalid multipart part count.");
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index]!;
    const response = await fetch(presign.partUrls[index]!, { method: "PUT", body: file.slice(slice.start, slice.end) });
    if (!response.ok) throw new Error(`Part ${index + 1} could not be uploaded.`);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error(`Part ${index + 1} returned no ETag.`);
    parts.push({ partNumber: index + 1, etag });
    onProgress?.(Math.round(((index + 1) / presign.partUrls.length) * 100));
  }
  return { uploadId: presign.uploadId, parts };
}
