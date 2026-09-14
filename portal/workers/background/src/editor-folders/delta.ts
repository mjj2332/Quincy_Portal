import type { DropboxEntry } from "../dropbox/client";
import { pathEqualsOrIsBelow, dropboxPathKey } from "../dropbox/paths";

type EditorRoute = { projectId: string; inputRoots: readonly { path: string }[]; outputRoots: readonly { path: string }[] };

/** Route only the explicitly mapped I/O trees; notes and Portal mirror echoes are excluded. */
export function changedEditorProjectIds(entries: readonly DropboxEntry[], mappings: readonly EditorRoute[]): string[] {
  const matched = new Set<string>();
  for (const entry of entries) {
    if (entry[".tag"] !== "file" || !/\.(?:dng|jpe?g)$/i.test(entry.name)) continue;
    for (const mapping of mappings) {
      const roots = /\.dng$/i.test(entry.name) ? mapping.inputRoots : [...mapping.inputRoots, ...mapping.outputRoots];
      if (roots.some(({ path }) => {
        if (!pathEqualsOrIsBelow(entry.path_lower, path)) return false;
        const relative = dropboxPathKey(entry.path_lower).slice(dropboxPathKey(path).length + 1);
        return !relative.split("/").includes("manual-uploads");
      })) matched.add(mapping.projectId);
    }
  }
  return [...matched];
}
