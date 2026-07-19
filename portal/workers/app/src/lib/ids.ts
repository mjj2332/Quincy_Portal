export const newId = () => crypto.randomUUID();

/** Keeps a filename in one R2 path segment while preserving the original display name. */
export function safeFilename(filename: string): string {
  return filename.replace(/[\\/\u0000]/g, "_");
}
