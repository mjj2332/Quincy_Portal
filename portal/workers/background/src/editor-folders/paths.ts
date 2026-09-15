import { normalisePath } from "@quincy/shared";

/** The root already owned by the studio's Dropbox Editor workspace. */
export const EDITOR_ROOT = "/Editor/01_ACTIVE EDITS" as const;
/** Descriptive alias used by callers that distinguish the active workspace from `/Editor`. */
export const EDITOR_ACTIVE_ROOT = EDITOR_ROOT;
export const EDITOR_INPUT_FOLDER = "0. Input" as const;
export const EDITOR_OUTPUT_FOLDER = "1. Output" as const;
export const EDITOR_NOTES_FOLDER = "Editing Notes" as const;
export const EDITOR_CHILD_FOLDERS = [EDITOR_INPUT_FOLDER, EDITOR_OUTPUT_FOLDER, EDITOR_NOTES_FOLDER] as const;

/**
 * How an Input or Output child is recognised by name, whether during reviewed linking or when
 * the scaffold resumes a tree it already started: the plain spelling the studio's hand-made
 * folders use and the numbered spelling `EDITOR_INPUT_FOLDER`/`EDITOR_OUTPUT_FOLDER` create.
 * A mapping keeps whichever spelling it was established with; nothing is renamed to match.
 */
export const EDITOR_INPUT_NAME_PATTERN = /^(?:0\. )?input$/iu;
export const EDITOR_OUTPUT_NAME_PATTERN = /^(?:1\. )?output$/iu;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export type ShootDateParts = {
  year: number;
  month: number;
  day: number;
  yearText: string;
  monthText: string;
  dayText: string;
};

/**
 * Dropbox path components may contain most punctuation, but separators, controls and traversal
 * names are never valid project-folder components.  Reject surrounding whitespace too: silently
 * trimming it would no longer be the exact Tonomo folder name that the mapping is meant to keep.
 */
export function isSafeEditorPathSegment(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value !== "."
    && value !== ".."
    && !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function invalidShootDate(value: unknown): never {
  throw new Error(`Invalid shoot date; expected a real YYYY-MM-DD civil date: ${String(value)}`);
}

/** Validates, but does not reinterpret, the literal civil date supplied by Tonomo. */
export function parseShootDate(value: unknown): ShootDateParts {
  if (typeof value !== "string") return invalidShootDate(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return invalidShootDate(value);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return invalidShootDate(value);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]!) return invalidShootDate(value);
  return {
    year,
    month,
    day,
    yearText: match[1]!,
    monthText: match[2]!,
    dayText: match[3]!,
  };
}

export function validateShootDate(value: unknown): string {
  parseShootDate(value);
  return value as string;
}

export function isValidShootDate(value: unknown): value is string {
  try {
    parseShootDate(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * September 2026 is the one established month folder and deliberately keeps its old name.
 * Every other month carries the year so the convention remains unambiguous in 2027 and later.
 */
export function editorMonthFolderName(shootDate: string): string {
  const parts = parseShootDate(shootDate);
  const monthName = MONTH_NAMES[parts.month - 1]!;
  if (parts.year === 2026 && parts.month === 9) return `09. ${monthName}`;
  return `${parts.yearText}-${parts.monthText} ${monthName}`;
}

export const editorMonthFolder = editorMonthFolderName;

export function editorDayFolderName(shootDate: string): string {
  return parseShootDate(shootDate).dayText;
}

export const editorDayFolder = editorDayFolderName;

function assertSafePath(path: string): string {
  const normalised = normalisePath(path);
  const segments = normalised.split("/").filter(Boolean);
  if (!normalised || segments.some((segment) => !isSafeEditorPathSegment(segment))) {
    throw new Error(`Invalid Editor Dropbox path: ${path}`);
  }
  return normalised;
}

/** Returns the exact project-folder leaf represented by a canonical Tonomo RAW path. */
export function deriveEditorProjectFolderName(rawFolderPath: string): string {
  const normalised = assertSafePath(rawFolderPath);
  const segments = normalised.split("/").filter(Boolean);
  const leaf = segments.at(-1);
  if (!leaf) throw new Error(`Cannot derive Editor project folder name from RAW folder path: ${rawFolderPath}`);
  if (leaf.toLowerCase() === "listing images") {
    const parent = segments.at(-2);
    if (!parent || !isSafeEditorPathSegment(parent)) {
      throw new Error(`Cannot derive Editor project folder name from RAW folder path: ${rawFolderPath}`);
    }
    return parent;
  }
  return leaf;
}

export type EditorFolderPathInput = {
  shootDate: string;
  projectFolderName: string;
};

/** Builds a new mapping path. Existing mappings must never call this with a rescheduled date. */
export function editorFolderPath(input: EditorFolderPathInput): string {
  const shootDate = validateShootDate(input.shootDate);
  if (!isSafeEditorPathSegment(input.projectFolderName)) throw new Error("Invalid Editor project folder name");
  return `${EDITOR_ROOT}/${editorMonthFolderName(shootDate)}/${editorDayFolderName(shootDate)}/${input.projectFolderName}`;
}

export function editorFolderChildPath(rootPath: string, child: typeof EDITOR_CHILD_FOLDERS[number]): string {
  const root = assertSafePath(rootPath);
  if (!isEditorProjectFolderPath(root)) throw new Error(`Invalid Editor project root path: ${rootPath}`);
  return `${root}/${child}`;
}

/** Lower-cased NFC key used for all connection-scoped uniqueness and exact comparisons. */
export function editorFolderPathKey(path: string): string {
  return assertSafePath(path).normalize("NFC").toLowerCase();
}

export function isEditorProjectFolderPath(path: string): boolean {
  try {
    const normalised = assertSafePath(path);
    const prefix = `${EDITOR_ROOT.toLowerCase()}/`;
    const segments = normalised.split("/").filter(Boolean);
    return normalised.toLowerCase().startsWith(prefix)
      && segments.length === EDITOR_ROOT.split("/").filter(Boolean).length + 3;
  } catch {
    return false;
  }
}

export function isEditorWorkspacePath(path: string): boolean {
  try {
    const normalised = assertSafePath(path);
    const rootKey = editorFolderPathKey(EDITOR_ROOT);
    const key = editorFolderPathKey(normalised);
    return key === rootKey || key.startsWith(`${rootKey}/`);
  } catch {
    return false;
  }
}

export type FallbackEditorProjectFolderName = { name: string; source: "tonomo_formatted_address" | "project_address" };

/**
 * Editor project folder name when the Tonomo RAW folder no longer exists, so no path_display is
 * available. Tonomo's stored path is path_lower (casing lost); Tonomo derives the folder leaf from
 * the order's formatted address with "/" replaced by "-" and sometimes appends a numeric suffix
 * (" 2", "(1)"). When the formatted address reproduces the stored leaf apart from that suffix, the
 * original-cased address plus the stored suffix is exact. Otherwise the project's own address is
 * the last resort.
 */
export function fallbackEditorProjectFolderName(input: {
  storedRawFolderPath: string | null;
  formattedAddress: string | null;
  street: string;
  suburb: string | null;
}): FallbackEditorProjectFolderName {
  const segments = input.storedRawFolderPath?.split("/").filter(Boolean) ?? [];
  // Same convention as deriveEditorProjectFolderName: a "Listing Images" leaf names the tree after its parent.
  const storedLeaf = (segments.at(-1)?.toLowerCase() === "listing images" ? segments.at(-2) : segments.at(-1)) ?? null;
  const formatted = input.formattedAddress?.trim().replace(/\//gu, "-") ?? null;
  if (formatted && isSafeEditorPathSegment(formatted)) {
    if (!storedLeaf) return { name: formatted, source: "tonomo_formatted_address" };
    const lower = formatted.toLowerCase();
    if (storedLeaf.toLowerCase().startsWith(lower)) {
      const suffix = storedLeaf.slice(lower.length);
      const name = `${formatted}${suffix}`;
      if (isSafeEditorPathSegment(name)) return { name, source: "tonomo_formatted_address" };
    }
  }
  const address = [input.street.trim(), input.suburb?.trim()].filter(Boolean).join(", ").replace(/\//gu, "-");
  if (!isSafeEditorPathSegment(address)) throw new Error(`Cannot derive an Editor project folder name for ${input.street}`);
  return { name: address, source: "project_address" };
}

