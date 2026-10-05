import type { MediaRenderer, RenderedMedia } from "./whiteboard-media-files";

/**
 * #501: the browser's canvas drawing for board media (the resolver's default `MediaRenderer`). Every bitmap is a data URL, drawn at most
 * `MAX_EDGE` px on its long edge, so a 24 MP photo is decoded once per viewer and held at a bounded size. A video is ONE bitmap: its
 * poster (already at most 1280 px, #494) with the play badge baked in, so the badge zooms, rotates, crops and exports with the element.
 * Colours come from the Quincy tokens at draw time (never a literal), so a token change reaches the board on the next load.
 */
export const MAX_EDGE = 2048;
const NEUTRAL_TILE = { width: 1280, height: 720 };
const UNAVAILABLE_TILE = { width: 640, height: 360 };

/** A CSS custom property's current value, or a system colour keyword when the page does not define it (a test environment). */
function token(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

function newCanvas(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw the board's media.");
  return { canvas, context };
}

const fitWithin = (width: number, height: number, edge: number) => {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

/** The play badge: a scrim disc (radius ~11% of the short edge, at least 24 px) with a triangle, centred. */
function drawBadge(context: CanvasRenderingContext2D, width: number, height: number) {
  const radius = Math.max(24, Math.min(width, height) * 0.11);
  const x = width / 2; const y = height / 2;
  context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = token("--scrim-overlay", "GrayText"); context.fill();
  context.beginPath();
  const side = radius * 0.9;
  context.moveTo(x - side * 0.3, y - side * 0.5);
  context.lineTo(x + side * 0.6, y);
  context.lineTo(x - side * 0.3, y + side * 0.5);
  context.closePath();
  context.fillStyle = token("--text-on-inverse", "Canvas"); context.fill();
}

const finish = (canvas: HTMLCanvasElement, mimeType: "image/jpeg" | "image/png"): RenderedMedia =>
  ({ dataURL: canvas.toDataURL(mimeType, 0.9), mimeType, width: canvas.width, height: canvas.height });

async function drawBlob(blob: Blob): Promise<{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
    const drawn = newCanvas(size.width, size.height);
    drawn.context.drawImage(bitmap, 0, 0, drawn.canvas.width, drawn.canvas.height);
    return drawn;
  } finally {
    bitmap.close();
  }
}

export const canvasMediaRenderer: MediaRenderer = {
  async image(blob) {
    const { canvas } = await drawBlob(blob);
    // JPEG sources stay JPEG; PNG and WebP keep their alpha as PNG.
    return finish(canvas, blob.type === "image/jpeg" ? "image/jpeg" : "image/png");
  },
  async video(poster) {
    const { canvas, context } = poster ? await drawBlob(poster) : (() => {
      const tile = newCanvas(NEUTRAL_TILE.width, NEUTRAL_TILE.height);
      tile.context.fillStyle = token("--surface-sunken", "Canvas"); tile.context.fillRect(0, 0, tile.canvas.width, tile.canvas.height);
      return tile;
    })();
    drawBadge(context, canvas.width, canvas.height);
    return finish(canvas, "image/jpeg");     // a poster is a photograph: JPEG keeps the data URL small
  },
  async unavailable() {
    const { canvas, context } = newCanvas(UNAVAILABLE_TILE.width, UNAVAILABLE_TILE.height);
    context.fillStyle = token("--surface-sunken", "Canvas"); context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = token("--foreground-secondary", "GrayText");
    context.font = `${token("--weight-regular", "400")} 28px ${token("--font-sans", "sans-serif")}`;
    context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText("Media unavailable", canvas.width / 2, canvas.height / 2);
    return finish(canvas, "image/png");
  },
};
