import { z } from "zod";
import { EMBEDDED_MEDIA_RETENTION_MS } from "./embedded-media";

/**
 * Attachments (#945, tracer #952): any file shared on a post and downloaded, never shown inline. The limits, the name rules and the
 * blocklist live here so the composer and the API agree on them; the browser's checks are a convenience and the server re-checks
 * every one. There is no malware scan in v1 (docs/Guides/Attachments.md): the blocklist, a forced download as octet-stream, `nosniff`
 * and a sandbox CSP are the mitigation.
 */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
export const ATTACHMENT_GUEST_MAX_BYTES = 25 * 1024 * 1024;
/** Counted separately from Embedded media: a post may hold 10 photos or videos and 10 Attachments. */
export const ATTACHMENT_MAX_PER_POST = 10;
export const ATTACHMENT_GUEST_MAX_PER_NOTE = 5;
/** An unposted or removed Attachment is kept this long (re-adding it while editing works), then reclaimed by the sweep (#953). */
export const ATTACHMENT_RETENTION_MS = EMBEDDED_MEDIA_RETENTION_MS;
export const ATTACHMENT_NAME_MAX_BYTES = 255;
/** Every Attachment object is stored, and served, as this type, whatever the file is. */
export const ATTACHMENT_STORED_CONTENT_TYPE = "application/octet-stream";
/** The owners an Attachment row may have. #952 writes `project_comment` only; the rest are for #954-#956. */
export const ATTACHMENT_OWNER_KINDS = ["project_comment", "notice_post", "video_note"] as const;
export type AttachmentOwnerKind = (typeof ATTACHMENT_OWNER_KINDS)[number];

/** A Project's Attachments sit under the Project's own storage prefix, which the Project hard delete purges. Never a user-supplied name. */
export function attachmentObjectKey(projectId: string, attachmentId: string): string {
  return `projects/${projectId}/attachments/${attachmentId}/original`;
}

/** A Notice board post's Attachments (#954), outside `projects/`. */
export function noticeAttachmentObjectKey(attachmentId: string): string {
  return `notice-board/attachments/${attachmentId}/original`;
}

const encoder = new TextEncoder();
// C0 and C1 controls, DEL, and the bidi and zero-width controls (the right-to-left override trick hides a real extension).
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const RESERVED = /[:*?"<>|]/g;

function cutToBytes(value: string, max: number): string {
  let out = "";
  let used = 0;
  for (const char of value) {
    const size = encoder.encode(char).byteLength;
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * The name an Attachment is stored and downloaded under, or null when nothing usable is left. NFC; the last path segment; controls,
 * bidi and zero-width characters removed; `:*?"<>|` read as spaces; whitespace collapsed; leading and trailing whitespace and trailing
 * dots stripped (Windows drops them, so `evil.exe.` is `evil.exe`); cut to 255 UTF-8 bytes keeping the extension.
 */
export function normalizeAttachmentName(raw: string): string | null {
  const segment = raw.normalize("NFC").split(/[/\\]/).pop() ?? "";
  const name = segment.replace(/[\t\n\r]/g, " ").replace(INVISIBLE, "").replace(RESERVED, " ").replace(/\s+/g, " ").replace(/[\s.]+$/, "").trim();
  if (!name) return null;
  if (encoder.encode(name).byteLength <= ATTACHMENT_NAME_MAX_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  const stem = cutToBytes(name.slice(0, name.length - extension.length), ATTACHMENT_NAME_MAX_BYTES - encoder.encode(extension).byteLength).trim();
  return stem ? `${stem}${extension}` : null;
}

/** The lower-cased text after the last dot, or null when the name has none. */
export function attachmentExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** A declared type, lower-cased and without parameters; anything empty or malformed is `application/octet-stream`. Never used to serve. */
export function normalizeDeclaredContentType(raw: string): string {
  const value = raw.split(";")[0]!.trim().toLowerCase();
  return value.length <= 127 && MEDIA_TYPE.test(value) ? value : ATTACHMENT_STORED_CONTENT_TYPE;
}

/** Extensions an Attachment may not have. Checked on the final extension of the normalised name. */
export const ATTACHMENT_BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows executables, libraries and installers
  "exe", "com", "scr", "pif", "cpl", "dll", "ocx", "sys", "drv", "msi", "msix", "msixbundle", "msp", "mst", "appx", "appxbundle", "application", "xbap", "gadget", "msc",
  // Windows scripts, shortcuts and shell-integration files
  "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "wsc", "sct", "hta", "ps1", "psm1", "psd1", "ps1xml", "psc1", "pssc", "reg", "inf", "lnk", "url", "scf", "iqy", "slk",
  "settingcontent-ms", "library-ms", "search-ms",
  // macOS and Linux executables, installers and launchers
  "app", "dmg", "pkg", "mpkg", "command", "tool", "workflow", "action", "applescript", "scpt", "scptd", "sh", "bash", "zsh", "csh", "ksh", "fish", "run", "appimage", "deb", "rpm",
  "snap", "flatpak", "desktop",
  // Mobile and other installers
  "apk", "aab", "xapk", "ipa",
  // Interpreted scripts and runtimes
  "jar", "jnlp", "py", "pyw", "pyc", "pyo", "pl", "pm", "rb", "php", "phtml", "php3", "php4", "php5", "php7", "phar", "cgi", "lua", "tcl", "mjs", "cjs",
  // Browser and extension packages
  "crx", "xpi", "vsix",
  // Active web content
  "html", "htm", "xhtml", "xht", "shtml", "mht", "mhtml", "svg", "svgz", "xsl", "xslt", "swf", "spl",
  // Compiled help
  "chm", "hlp",
  // Disk images that auto-mount and slip past Mark-of-the-Web
  "iso", "img", "vhd", "vhdx",
  // Office macro-enabled formats (owner decision A2)
  "docm", "dotm", "xlsm", "xltm", "xlam", "xla", "pptm", "potm", "ppam", "ppsm", "sldm",
]);

/** Declared types an Attachment may not have, after `normalizeDeclaredContentType`. */
export const ATTACHMENT_BLOCKED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/x-msdownload", "application/x-msdos-program", "application/x-ms-installer", "application/x-msi", "application/x-ms-shortcut",
  "application/x-mswinurl", "application/vnd.microsoft.portable-executable", "application/x-dosexec", "application/x-executable",
  "application/x-mach-binary", "application/x-elf", "application/x-sharedlib", "application/x-apple-diskimage", "application/x-iso9660-image",
  "application/vnd.android.package-archive", "application/java-archive", "application/x-java-archive", "application/x-java-jnlp-file",
  "application/x-sh", "application/x-shellscript", "application/x-csh", "text/x-shellscript", "text/x-sh", "application/x-bat", "application/x-msbatch",
  "application/javascript", "application/x-javascript", "application/ecmascript", "text/javascript", "text/ecmascript", "text/vbscript", "application/hta",
  "text/x-python", "application/x-python-code", "text/x-perl", "application/x-perl", "application/x-php", "application/x-httpd-php", "text/x-php",
  "application/x-desktop", "text/html", "application/xhtml+xml", "image/svg+xml", "application/xslt+xml", "text/xsl", "application/x-shockwave-flash",
  "application/vnd.ms-htmlhelp", "multipart/related", "application/x-mimearchive", "message/rfc822",
]);
const MACRO_ENABLED_TYPE = /^application\/vnd\.ms-[a-z0-9.-]+\.macroenabled\.12$/;

export type AttachmentRefusal = { reason: "extension" | "content_type"; value: string };

/** Why a file may not be attached, or null when it may. `name` is the normalised name; both the composer and the server call this. */
export function attachmentRefusal(name: string, contentType: string): AttachmentRefusal | null {
  const extension = attachmentExtension(name);
  if (extension && ATTACHMENT_BLOCKED_EXTENSIONS.has(extension)) return { reason: "extension", value: extension };
  const type = normalizeDeclaredContentType(contentType);
  if (ATTACHMENT_BLOCKED_CONTENT_TYPES.has(type) || MACRO_ENABLED_TYPE.test(type)) return { reason: "content_type", value: type };
  return null;
}

/** The sentence the composer and the API both show for a refused file. */
export function attachmentRefusalMessage(name: string, refusal: AttachmentRefusal): string {
  return refusal.reason === "extension"
    ? `${name} can't be attached: .${refusal.value} files are blocked.`
    : `${name} can't be attached: ${refusal.value} files are blocked.`;
}

/** The body of `POST /api/projects/:projectId/attachments`. */
export const attachmentPresignInput = z.object({
  name: z.string().min(1).max(1024),
  contentType: z.string().max(255),
  bytes: z.number().int().min(0),
  /** What the file is for (#955): the Project's discussion (the default) or a staff Video note, which takes the note-writing gate instead of the Collaboration tab's. */
  owner: z.enum(["discussion", "video_note"]).optional(),
}).strict();
export type AttachmentPresignInput = z.infer<typeof attachmentPresignInput>;

export const attachmentPresignResponseSchema = z.object({
  attachmentId: z.string().uuid(),
  uploadId: z.string().optional(),
  partUrls: z.array(z.string()).optional(),
  partBytes: z.number().int().positive().optional(),
  devDirect: z.literal(true).optional(),
}).strict();
export type AttachmentPresignResponse = z.infer<typeof attachmentPresignResponseSchema>;

export const attachmentCompleteResponseSchema = z.object({ attachmentId: z.string().uuid(), state: z.literal("pending") }).strict();
export type AttachmentCompleteResponse = z.infer<typeof attachmentCompleteResponseSchema>;
