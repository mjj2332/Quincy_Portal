/**
 * The phone pill's rest placeholder (#879 PR 3a): a text too wide for its line loses whole words from the end and ends in one "…", so it never reads as a word cut in half
 * ("Add a note with…", not "Add a note wi…"). `fits` measures a candidate; the widest is asked first. When not even the first word fits with its ellipsis, the first word is kept
 * anyway (the field's CSS ellipsis clips what is left); a text with no word break is returned as it is.
 */
export function fitAtWord(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const base = text.endsWith("…") ? text.slice(0, -1) : text;
  const breaks = [...base.matchAll(/\s+/g)].map((match) => match.index).filter((index) => index > 0 && base.slice(0, index).trim() !== "");
  if (breaks.length === 0) return text;
  const candidates = breaks.reverse().map((index) => `${base.slice(0, index).trimEnd()}…`);
  return candidates.find(fits) ?? candidates[candidates.length - 1]!;
}
