import { z } from "zod";

/**
 * The freehand stroke contract shared by every surface that draws over a picture (#741 slice 6a).
 * Coordinates are fractions (0 to 1) of the picture; width is in CSS pixels. This is the LOOSE form the photo
 * annotation route has always used: an unknown key is stripped, not refused. A strict variant (the MCP tool, and
 * the video-note envelope in 6b) is built from these pieces at its own call site, never by editing them here.
 */
export const STROKE_LIMITS = { points: 2000, strokes: 200, color: 32, width: 100 } as const;

export const strokePointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

const strokeColorSchema = z.string().trim().min(1).max(STROKE_LIMITS.color);
const strokeWidthSchema = z.number().positive().max(STROKE_LIMITS.width);

export const strokeSchema = z.object({
  points: z.array(strokePointSchema).min(1).max(STROKE_LIMITS.points),
  color: strokeColorSchema,
  width: strokeWidthSchema,
});

/**
 * #741 slice 6s-api: markup is a union of a freehand stroke and a shape. A freehand stroke stays TYPELESS on the wire, so every
 * annotation already saved reads back and re-saves bit for bit; `type` may only ever be absent on it. A shape carries
 * `type` and exactly two points, [start, end] as dragged (an arrow's direction needs the order; a rectangle is
 * normalised when drawn, so either corner order renders the same).
 */
export const MARKUP_SHAPES = ["arrow", "line", "rectangle"] as const;
export type MarkupShapeKind = (typeof MARKUP_SHAPES)[number];

/** `z.never().optional()` makes an unknown `type` fail this branch too, so the loose route answers 400 instead of stripping it. */
export const freehandStrokeSchema = strokeSchema.extend({ type: z.never().optional() });

export const shapeSchema = z.object({
  type: z.enum(MARKUP_SHAPES),
  points: z.tuple([strokePointSchema, strokePointSchema]),
  color: strokeColorSchema,
  width: strokeWidthSchema,
});

/** The shape schema comes FIRST: the loose freehand object strips unknown keys and would otherwise swallow a 2-point shape as freehand. */
export const markupItemSchema = z.union([shapeSchema, freehandStrokeSchema]);

export const strokesSchema = z.array(markupItemSchema).max(STROKE_LIMITS.strokes);

export type FreehandPoint = { x: number; y: number };
export type FreehandStroke = { points: FreehandPoint[]; color: string; width: number; type?: undefined };
export type MarkupShape = { type: MarkupShapeKind; points: [FreehandPoint, FreehandPoint]; color: string; width: number };
export type MarkupItem = FreehandStroke | MarkupShape;

export function markupKind(item: MarkupItem): "freehand" | MarkupShapeKind { return item.type ?? "freehand"; }

/** The UTF-8 byte length of a stroke list as JSON, the unit every storage cap is written in. */
export function strokesJsonBytes(strokes: readonly MarkupItem[]): number {
  return new TextEncoder().encode(JSON.stringify(strokes)).length;
}
