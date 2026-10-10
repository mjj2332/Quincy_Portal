import { z } from "zod";

/**
 * The freehand stroke contract shared by every surface that draws over a picture (#741 slice 6a).
 * Coordinates are fractions (0 to 1) of the picture; width is in CSS pixels. This is the LOOSE form the photo
 * annotation route has always used: an unknown key is stripped, not refused. A strict variant (the MCP tool, and
 * the video-note envelope in 6b) is built from these pieces at its own call site, never by editing them here.
 */
export const STROKE_LIMITS = { points: 2000, strokes: 200, color: 32, width: 100 } as const;

export const strokePointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

export const strokeSchema = z.object({
  points: z.array(strokePointSchema).min(1).max(STROKE_LIMITS.points),
  color: z.string().trim().min(1).max(STROKE_LIMITS.color),
  width: z.number().positive().max(STROKE_LIMITS.width),
});

export const strokesSchema = z.array(strokeSchema).max(STROKE_LIMITS.strokes);

export type FreehandPoint = { x: number; y: number };
export type FreehandStroke = { points: FreehandPoint[]; color: string; width: number };

/** The UTF-8 byte length of a stroke list as JSON, the unit every storage cap is written in. */
export function strokesJsonBytes(strokes: readonly FreehandStroke[]): number {
  return new TextEncoder().encode(JSON.stringify(strokes)).length;
}
