import { createContext, forwardRef, useContext, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ForwardedRef } from "react";
import { markupKind, type FreehandPoint, type MarkupItem, type MarkupShape } from "@quincy/shared";
import { arrowGeometry, normaliseRect, type MeasuredBox } from "../../lib/markup-geometry";

/**
 * The SVG renderers for markup (#741 slice 6a moved them out of the photo Lightbox; 6s-api adds line, arrow and rectangle).
 * Render inside an `<svg viewBox="0 0 1 1" preserveAspectRatio="none">`: points are fractions of the picture, the line
 * width is CSS pixels (`vector-effect: non-scaling-stroke`), and a one-point stroke is a dot of radius width/600.
 * A typeless item (freehand) renders exactly as it always has. An arrowhead is a polygon computed in measured pixels, so
 * the layer's size comes from `MarkupLayer` through context; with no measured size an arrow is a plain line.
 * An item of a type this build does not know renders nothing (the reader flags it so the Lightbox can say so).
 * Presentational only: data in, markup out. The pen colours are ink applied to a photograph, not interface chrome.
 */
const UNMEASURED: MeasuredBox = { width: 0, height: 0 };
export const MarkupBoxContext = createContext<MeasuredBox>(UNMEASURED);

/**
 * The markup `<svg>`: passes every attribute through and publishes its laid-out size (before any CSS zoom transform,
 * which scales the whole layer, heads included) for arrowheads. ResizeObserver, falling back to the layout size.
 */
export const MarkupLayer = forwardRef(function MarkupLayer({ children, ...svgProps }: ComponentPropsWithoutRef<"svg">, forwarded: ForwardedRef<SVGSVGElement>) {
  const own = useRef<SVGSVGElement | null>(null);
  const [box, setBox] = useState<MeasuredBox>(UNMEASURED);
  useLayoutEffect(() => {
    const el = own.current; if (!el) return;
    const apply = (width: number, height: number) => setBox((current) => (current.width === width && current.height === height ? current : { width, height }));
    const fallback = () => apply((el as unknown as HTMLElement).clientWidth || el.getBoundingClientRect().width || 0, (el as unknown as HTMLElement).clientHeight || el.getBoundingClientRect().height || 0);
    if (typeof ResizeObserver === "undefined") { fallback(); return; }
    const observer = new ResizeObserver((entries) => { const rect = entries[entries.length - 1]?.contentRect; if (rect) apply(rect.width, rect.height); });
    observer.observe(el); fallback();
    return () => observer.disconnect();
  }, []);
  return <svg {...svgProps} ref={(node) => { own.current = node; if (typeof forwarded === "function") forwarded(node); else if (forwarded) forwarded.current = node; }}><MarkupBoxContext.Provider value={box}>{children}</MarkupBoxContext.Provider></svg>;
});

function pointsString(points: FreehandPoint[]) { return points.map((point) => `${point.x},${point.y}`).join(" "); }
const isShape = (item: MarkupItem): item is MarkupShape => item.type !== undefined;
const KNOWN_SHAPES = ["arrow", "line", "rectangle"];
const isRenderable = (item: MarkupItem) => !isShape(item) || (KNOWN_SHAPES.includes(item.type) && Array.isArray(item.points) && item.points.length === 2);

/**
 * `pixelDots` (the video overlay) draws a one-point stroke as a zero-length round-capped path with a non-scaling stroke, so a dot is `width` CSS pixels across whatever the picture's
 * shape or size, like every line. The default (photos) keeps the normalised circle.
 */
export function StrokeVisible({ stroke, opacity, testId = "lightbox-stroke", pixelDots = false }: { stroke: MarkupItem; opacity: number; testId?: string; pixelDots?: boolean }) {
  const box = useContext(MarkupBoxContext);
  if (!isRenderable(stroke)) return null;
  if (!isShape(stroke)) {
    if (stroke.points.length < 2 && pixelDots && stroke.points[0]) {
      return <path d={`M${stroke.points[0].x} ${stroke.points[0].y}h0`} fill="none" stroke={stroke.color} strokeWidth={stroke.width} vectorEffect="non-scaling-stroke" strokeLinecap="round" opacity={opacity} className="stroke-vis" data-testid={testId} />;
    }
    return stroke.points.length < 2
      ? <circle cx={stroke.points[0]?.x} cy={stroke.points[0]?.y} r={stroke.width / 600} fill={stroke.color} opacity={opacity} className="stroke-vis" data-testid={testId} />
      : <polyline points={pointsString(stroke.points)} fill="none" stroke={stroke.color} strokeWidth={stroke.width} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" opacity={opacity} className="stroke-vis" data-testid={testId} />;
  }
  const [a, b] = stroke.points;
  const common = { stroke: stroke.color, strokeWidth: stroke.width, vectorEffect: "non-scaling-stroke" as const, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (markupKind(stroke)) {
    case "line":
      return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common} opacity={opacity} className="stroke-vis" data-testid={testId} />;
    case "rectangle": {
      const rect = normaliseRect(a, b);
      return <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill="none" {...common} opacity={opacity} className="stroke-vis" data-testid={testId} />;
    }
    default: {
      const geometry = arrowGeometry(a, b, stroke.width, box);
      const shaftEnd = geometry?.shaftEnd ?? b;
      return <g opacity={opacity} className="stroke-vis" data-testid={testId}>
        <line x1={a.x} y1={a.y} x2={shaftEnd.x} y2={shaftEnd.y} {...common} />
        {geometry && <polygon points={pointsString(geometry.head)} fill={stroke.color} />}
      </g>;
    }
  }
}

/** An invisible, wider copy of a stroke so a thin line is easy to click or tap. */
export function StrokeHitTarget({ stroke }: { stroke: MarkupItem }) {
  const box = useContext(MarkupBoxContext);
  if (!isRenderable(stroke)) return null;
  if (!isShape(stroke)) {
    return stroke.points.length < 2
      ? <circle cx={stroke.points[0]?.x} cy={stroke.points[0]?.y} r={(stroke.width + 12) / 600} fill="transparent" style={{ pointerEvents: "fill" }} />
      : <polyline points={pointsString(stroke.points)} fill="none" stroke="transparent" strokeWidth={stroke.width + 12} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "stroke" }} />;
  }
  const [a, b] = stroke.points;
  const wide = { fill: "none", stroke: "transparent", strokeWidth: stroke.width + 12, vectorEffect: "non-scaling-stroke" as const, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, style: { pointerEvents: "stroke" as const } };
  if (stroke.type === "rectangle") { const rect = normaliseRect(a, b); return <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} {...wide} />; }
  const geometry = stroke.type === "arrow" ? arrowGeometry(a, b, stroke.width, box) : null;
  return <>
    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...wide} />
    {geometry && <polygon points={pointsString(geometry.head)} fill="transparent" style={{ pointerEvents: "fill" }} />}
  </>;
}
