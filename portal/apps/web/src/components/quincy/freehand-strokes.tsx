import type { FreehandPoint, FreehandStroke } from "@quincy/shared";

/**
 * The SVG renderers for freehand strokes (#741 slice 6a: moved out of the photo Lightbox, markup unchanged).
 * Render inside an `<svg viewBox="0 0 1 1" preserveAspectRatio="none">`: points are fractions of the picture, the line
 * width is CSS pixels (`vector-effect: non-scaling-stroke`), and a one-point stroke is a dot of radius width/600.
 * Presentational only: data in, markup out. The pen colours are ink applied to a photograph, not interface chrome.
 */
function pointsString(points: FreehandPoint[]) { return points.map((point) => `${point.x},${point.y}`).join(" "); }

export function StrokeVisible({ stroke, opacity, testId = "lightbox-stroke" }: { stroke: FreehandStroke; opacity: number; testId?: string }) {
  return stroke.points.length < 2
    ? <circle cx={stroke.points[0]?.x} cy={stroke.points[0]?.y} r={stroke.width / 600} fill={stroke.color} opacity={opacity} className="stroke-vis" data-testid={testId} />
    : <polyline points={pointsString(stroke.points)} fill="none" stroke={stroke.color} strokeWidth={stroke.width} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" opacity={opacity} className="stroke-vis" data-testid={testId} />;
}

/** An invisible, wider copy of a stroke so a thin line is easy to click or tap. */
export function StrokeHitTarget({ stroke }: { stroke: FreehandStroke }) {
  return stroke.points.length < 2
    ? <circle cx={stroke.points[0]?.x} cy={stroke.points[0]?.y} r={(stroke.width + 12) / 600} fill="transparent" style={{ pointerEvents: "fill" }} />
    : <polyline points={pointsString(stroke.points)} fill="none" stroke="transparent" strokeWidth={stroke.width + 12} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "stroke" }} />;
}
