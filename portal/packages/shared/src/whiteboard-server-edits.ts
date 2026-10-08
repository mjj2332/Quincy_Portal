import { z } from "zod";
import { whiteboardMediaRef } from "./whiteboard-media";
import type { StoredElement } from "./whiteboard-index";

/**
 * #708: the simplified view of a Project whiteboard that the Portal MCP server reads, and the strict command set it edits with.
 * An AI client never sends (or sees) a raw Excalidraw element: it sends an edit, and `expandServerEdits` -- pure, shared by the
 * route's validation, the Durable Object and the tests -- turns each one into the complete elements the board stores. The
 * Durable Object assigns each new element's fractional index through `reconcileRows`, the one index generator the board has.
 *
 * Text sizes are APPROXIMATIONS (the worker has no font metrics): Excalidraw does not re-measure a stored element on load, so
 * a client that edits the text re-measures it.
 */

export const WHITEBOARD_SERVER_EDITS_MAX = 50;
export const WHITEBOARD_SERVER_TEXT_MAX = 5000;

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const extent = z.number().finite().min(1).max(10_000);
const elementId = z.string().min(1).max(64);
const text = z.string().min(1).max(WHITEBOARD_SERVER_TEXT_MAX);

export const WHITEBOARD_STICKY_COLORS = {
  yellow: "#ffec99",
  green: "#b2f2bb",
  blue: "#a5d8ff",
  pink: "#ffc9c9",
  orange: "#ffd8a8",
  purple: "#d0bfff",
} as const;
const stickyColor = z.union([z.enum(Object.keys(WHITEBOARD_STICKY_COLORS) as [keyof typeof WHITEBOARD_STICKY_COLORS, ...Array<keyof typeof WHITEBOARD_STICKY_COLORS>]), z.string().regex(/^#[0-9a-fA-F]{6}$/)]);

const point = z.object({ x: coordinate, y: coordinate }).strict();
const arrowEnd = z.union([elementId, point]);

export const whiteboardServerEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_text"), x: coordinate, y: coordinate, text }).strict(),
  z.object({ op: z.literal("add_sticky"), x: coordinate, y: coordinate, text, color: stickyColor }).strict(),
  z.object({ op: z.literal("add_shape"), shapeKind: z.enum(["rectangle", "ellipse", "diamond"]), x: coordinate, y: coordinate, w: extent, h: extent }).strict(),
  z.object({ op: z.literal("add_arrow"), from: arrowEnd, to: arrowEnd }).strict(),
  z.object({ op: z.literal("place_media"), embeddedMediaId: z.string().uuid(), x: coordinate, y: coordinate }).strict(),
  z.object({ op: z.literal("edit"), id: elementId, text: text.optional(), x: coordinate.optional(), y: coordinate.optional() }).strict(),
  z.object({ op: z.literal("delete"), id: elementId }).strict(),
]).refine((edit) => edit.op !== "edit" || edit.text !== undefined || edit.x !== undefined || edit.y !== undefined, { message: "an edit must change text, x or y" });
export type WhiteboardServerEdit = z.infer<typeof whiteboardServerEditSchema>;

export const whiteboardServerEditsRequestSchema = z.object({
  /** Caller-stable: a retry of the same call carries the same id and is answered from the stored result. */
  requestId: z.string().uuid().optional(),
  expectedGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  edits: z.array(whiteboardServerEditSchema).min(1).max(WHITEBOARD_SERVER_EDITS_MAX),
}).strict();
export type WhiteboardServerEditsRequest = z.infer<typeof whiteboardServerEditsRequestSchema>;

/** The Embedded media a `place_media` edit may name: resolved by the caller, scoped to the Project. */
export type WhiteboardMediaInfo = { kind: "image" | "video"; width: number | null; height: number | null };
export type ExpandDeps = {
  newId: () => string;
  /** A fresh integer in [0, 2^31). */
  random31: () => number;
  now: () => number;
  media: ReadonlyMap<string, WhiteboardMediaInfo>;
};
export type ExpandResult =
  | { ok: true; elements: StoredElement[]; results: Array<{ op: WhiteboardServerEdit["op"]; id: string }> }
  | { ok: false; code: "unknown_element" | "invalid_edit" | "media_unavailable"; message: string; editIndex: number };

type Row = StoredElement & Record<string, unknown>;
const FONT_SIZE = 20;
const STICKY_FONT_SIZE = 16;
const LINE_HEIGHT = 1.25;
const EXCALIFONT = 5;
const BOUND_PADDING = 5;
const STICKY_W = 200;
const STICKY_H = 160;
const MEDIA_MAX_SIDE = 480;
const ARROW_GAP = 1;
const DEFAULT_IMAGE: [number, number] = [400, 300];
const DEFAULT_VIDEO: [number, number] = [480, 270];
const BINDABLE = new Set(["rectangle", "ellipse", "diamond", "text", "image"]);
const CONTAINERS = new Set(["rectangle", "ellipse", "diamond"]);

/** Approximate advance of one character, in ems: East Asian text is full-width. */
const em = (char: string) => { const code = char.codePointAt(0)!; return code >= 0x2e80 ? 1 : 0.55; };
const lineWidth = (line: string, fontSize: number) => Math.ceil([...line].reduce((sum, char) => sum + em(char) * fontSize, 0));
export function measureText(value: string, fontSize: number): { width: number; height: number } {
  const lines = value.split("\n");
  return { width: Math.max(1, ...lines.map((line) => lineWidth(line, fontSize))), height: Math.ceil(lines.length * fontSize * LINE_HEIGHT) };
}
/** Greedy word wrap to `maxWidth`, breaking a word longer than a line. */
function wrap(value: string, fontSize: number, maxWidth: number): string {
  const out: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (lineWidth(candidate, fontSize) <= maxWidth) { line = candidate; continue; }
      if (line !== "") out.push(line);
      line = "";
      for (const char of word) {
        if (line !== "" && lineWidth(line + char, fontSize) > maxWidth) { out.push(line); line = ""; }
        line += char;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

// ---- reading the board --------------------------------------------------------------------------------------------

export type SimpleKind = "text" | "sticky" | "shape" | "arrow" | "media" | "other";
export type SimpleElement = {
  id: string; kind: SimpleKind; x: number; y: number; w: number; h: number;
  text?: string; color?: string; shapeKind?: "rectangle" | "ellipse" | "diamond";
  from?: string | { x: number; y: number }; to?: string | { x: number; y: number };
  embeddedMediaId?: string;
};
const num = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const round = (value: number) => Math.round(value * 100) / 100;
const str = (value: unknown) => typeof value === "string" ? value : undefined;

function boundTextOf(container: Row, byId: ReadonlyMap<string, Row>): Row | undefined {
  const bound = Array.isArray(container.boundElements) ? container.boundElements as Array<{ id?: unknown; type?: unknown }> : [];
  for (const entry of bound) {
    if (entry.type !== "text" || typeof entry.id !== "string") continue;
    const candidate = byId.get(entry.id);
    if (candidate && candidate.type === "text" && !candidate.isDeleted && candidate.containerId === container.id) return candidate;
  }
  return undefined;
}

/**
 * One entry per live element, back to front. A text element bound inside a container is folded into it (it cannot be edited on
 * its own): a rectangle that holds text is a `sticky`, any other container that holds text is a `shape` carrying `text`.
 */
export function simplifyScene(rows: readonly StoredElement[]): SimpleElement[] {
  const byId = new Map<string, Row>(rows.map((row) => [row.id, row as Row]));
  const out: SimpleElement[] = [];
  for (const row of rows as Row[]) {
    if (row.isDeleted) continue;
    if (row.type === "text" && typeof row.containerId === "string" && byId.get(row.containerId)?.isDeleted === false) continue;
    const base = { id: row.id, x: round(num(row.x)), y: round(num(row.y)), w: round(num(row.width)), h: round(num(row.height)) };
    const background = str(row.backgroundColor);
    const stroke = str(row.strokeColor);
    const fill = background && background !== "transparent" ? background : stroke;
    if (row.type === "text") { out.push({ ...base, kind: "text", text: str(row.originalText) ?? str(row.text) ?? "", ...(stroke ? { color: stroke } : {}) }); continue; }
    if (row.type === "rectangle" || row.type === "ellipse" || row.type === "diamond") {
      const inner = boundTextOf(row, byId);
      const body = inner ? (str(inner.originalText) ?? str(inner.text) ?? "") : undefined;
      if (row.type === "rectangle" && body !== undefined) { out.push({ ...base, kind: "sticky", text: body, ...(fill ? { color: fill } : {}) }); continue; }
      out.push({ ...base, kind: "shape", shapeKind: row.type, ...(body !== undefined ? { text: body } : {}), ...(fill ? { color: fill } : {}) });
      continue;
    }
    if (row.type === "arrow") {
      const points = Array.isArray(row.points) ? row.points as Array<[number, number]> : [];
      const first = points[0] ?? [0, 0]; const last = points.at(-1) ?? [0, 0];
      const end = (binding: unknown, at: [number, number]): string | { x: number; y: number } => {
        const bound = binding && typeof binding === "object" ? str((binding as { elementId?: unknown }).elementId) : undefined;
        return bound ?? { x: round(num(row.x) + num(at[0])), y: round(num(row.y) + num(at[1])) };
      };
      out.push({ ...base, kind: "arrow", from: end(row.startBinding, first), to: end(row.endBinding, last), ...(stroke ? { color: stroke } : {}) });
      continue;
    }
    const media = whiteboardMediaRef(row);
    if (media) { out.push({ ...base, kind: "media", embeddedMediaId: media.id }); continue; }
    out.push({ ...base, kind: "other" });
  }
  return out;
}

// ---- editing the board --------------------------------------------------------------------------------------------

/**
 * Expands `edits` against the current rows into the elements to store. Atomic: the first edit that cannot be applied fails the
 * whole call, and nothing is returned. Edits apply in order, so a later edit sees an earlier one's result; ids of new elements are
 * returned in `results` (an edit cannot name one, since the server chooses them). A changed or deleted element's `version` is
 * bumped and its nonce redrawn, exactly what the browser does; a delete is Excalidraw's `isDeleted` tombstone. The result holds
 * each touched element once, in its final form, and carries no `index` for a new element (the store assigns it).
 */
export function expandServerEdits(edits: readonly WhiteboardServerEdit[], stored: readonly StoredElement[], deps: ExpandDeps): ExpandResult {
  const working = new Map<string, Row>(stored.map((row) => [row.id, row as Row]));
  const touched = new Set<string>();
  const results: Array<{ op: WhiteboardServerEdit["op"]; id: string }> = [];
  const fail = (editIndex: number, code: Extract<ExpandResult, { ok: false }>["code"], message: string): ExpandResult => ({ ok: false, code, message, editIndex });

  const fresh = (type: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}): Row => ({
    id: ((id) => { created.add(id); return id; })(deps.newId()), type, x, y, width, height, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2,
    strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, boundElements: null, link: null, locked: false,
    seed: deps.random31(), version: 1, versionNonce: deps.random31(), isDeleted: false, updated: deps.now(), ...extra,
  }) as Row;
  const created = new Set<string>();
  /** Elements already bumped by the edit being applied: one edit is one revision however many fields it changes. */
  let bumped = new Set<string>();
  const put = (row: Row) => { working.set(row.id, row); touched.add(row.id); return row; };
  /** An element this call created stays at version 1 however often a later edit of the same call touches it. */
  const bump = (row: Row, patch: Record<string, unknown>) => {
    if (created.has(row.id) || bumped.has(row.id)) return put({ ...row, ...patch } as Row);
    bumped.add(row.id);
    return put({ ...row, ...patch, version: row.version + 1, versionNonce: deps.random31(), updated: deps.now() } as Row);
  };
  const live = (id: string): Row | undefined => { const row = working.get(id); return row && !row.isDeleted ? row : undefined; };
  const innerText = (container: Row): Row | undefined => boundTextOf(container, working);

  /** Lays `value` out inside `container`; returns the (possibly taller) container height and the text element's geometry. */
  const layout = (container: Row, value: string, fontSize: number) => {
    const maxWidth = Math.max(10, num(container.width) - BOUND_PADDING * 2);
    const wrapped = wrap(value, fontSize, maxWidth);
    const size = measureText(wrapped, fontSize);
    const height = Math.max(num(container.height), size.height + BOUND_PADDING * 2);
    const x = num(container.x) + (num(container.width) - size.width) / 2;
    const y = num(container.y) + (height - size.height) / 2;
    return { wrapped, size, height, x, y };
  };
  const textFields = (value: string, fontSize: number, wrapped: string, size: { width: number; height: number }) => ({ text: wrapped, originalText: value, fontSize, fontFamily: EXCALIFONT, lineHeight: LINE_HEIGHT, width: size.width, height: size.height });

  /** Gives `container` bound text `value`, creating the text element or updating the existing one. */
  const setBoundText = (container: Row, value: string, fontSize: number): void => {
    const placed = layout(container, value, fontSize);
    let box = container;
    if (placed.height !== num(container.height)) box = bump(container, { height: placed.height });
    const existing = innerText(box);
    if (existing) {
      bump(existing, { ...textFields(value, num(existing.fontSize, fontSize), placed.wrapped, placed.size), x: placed.x, y: placed.y });
      return;
    }
    const created = put(fresh("text", placed.x, placed.y, placed.size.width, placed.size.height, {
      ...textFields(value, fontSize, placed.wrapped, placed.size), textAlign: "center", verticalAlign: "middle", containerId: box.id, autoResize: true,
    }));
    bump(box, { boundElements: [...(Array.isArray(box.boundElements) ? box.boundElements : []), { id: created.id, type: "text" }] });
  };

  /** The element an edit or delete targets: a bound text element stands for its container. */
  const target = (id: string): Row | undefined => {
    const row = live(id);
    if (row && row.type === "text" && typeof row.containerId === "string") return live(row.containerId) ?? row;
    return row;
  };

  const move = (row: Row, x: number | undefined, y: number | undefined): void => {
    const dx = x === undefined ? 0 : x - num(row.x);
    const dy = y === undefined ? 0 : y - num(row.y);
    if (dx === 0 && dy === 0) return;
    if (row.type === "arrow") {
      // Dragging a whole arrow detaches it, as the editor does.
      for (const end of [row.startBinding, row.endBinding]) {
        const target = end && typeof end === "object" ? live(String((end as { elementId?: unknown }).elementId)) : undefined;
        if (target) bump(target, { boundElements: withoutBound(target, row.id) });
      }
      bump(row, { x: num(row.x) + dx, y: num(row.y) + dy, startBinding: null, endBinding: null });
      return;
    }
    const moved = bump(row, { x: num(row.x) + dx, y: num(row.y) + dy });
    const inner = CONTAINERS.has(String(row.type)) ? innerText(row) : undefined;
    if (inner) bump(inner, { x: num(inner.x) + dx, y: num(inner.y) + dy });
    for (const arrow of arrowsBoundTo(moved.id)) bump(arrow, routeArrow(arrow));
  };

  const centre = (box: Row) => ({ x: num(box.x) + num(box.width) / 2, y: num(box.y) + num(box.height) / 2 });
  /**
   * Where the ray from `box`'s centre toward `toward` leaves the element's real outline (a diamond's edges, an ellipse's curve, a
   * rectangle's sides), in the element's own turned frame, then `ARROW_GAP` further out. The outline is the unit ball of a norm in
   * the element's local axes: L1 for a diamond, L2 for an ellipse, max for a box.
   */
  const outline = (box: Row, toward: { x: number; y: number }): { x: number; y: number } => {
    const c = centre(box);
    const dx = toward.x - c.x; const dy = toward.y - c.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return c;
    const angle = num(box.angle);
    const lx = dx * Math.cos(-angle) - dy * Math.sin(-angle);
    const ly = dx * Math.sin(-angle) + dy * Math.cos(-angle);
    const nx = Math.abs(lx) / Math.max(num(box.width) / 2, 1e-9); const ny = Math.abs(ly) / Math.max(num(box.height) / 2, 1e-9);
    const norm = box.type === "diamond" ? nx + ny : box.type === "ellipse" ? Math.hypot(nx, ny) : Math.max(nx, ny);
    const t = norm === 0 ? 0 : 1 / norm;
    return { x: c.x + dx * t + (dx / length) * ARROW_GAP, y: c.y + dy * t + (dy / length) * ARROW_GAP };
  };

  const pointsOf = (arrow: Row): Array<{ x: number; y: number }> =>
    (Array.isArray(arrow.points) ? arrow.points as number[][] : [[0, 0], [0, 0]]).map((p) => ({ x: num(arrow.x) + num(p[0]), y: num(arrow.y) + num(p[1]) }));
  /** The arrow's geometry with each bound end on its element's outline; an unbound end stays where it is. Interior points are kept. */
  const routeArrow = (arrow: Row): Record<string, unknown> => {
    const abs = pointsOf(arrow);
    const binding = (end: unknown) => end && typeof end === "object" ? live(String((end as { elementId?: unknown }).elementId)) : undefined;
    const first = binding(arrow.startBinding); const last = binding(arrow.endBinding);
    const startTarget = first ? centre(first) : abs[0]!; const endTarget = last ? centre(last) : abs.at(-1)!;
    if (first) abs[0] = outline(first, abs.length > 2 ? abs[1]! : endTarget);
    if (last) abs[abs.length - 1] = outline(last, abs.length > 2 ? abs.at(-2)! : startTarget);
    const xs = abs.map((p) => p.x); const ys = abs.map((p) => p.y);
    return { x: abs[0]!.x, y: abs[0]!.y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points: abs.map((p) => [p.x - abs[0]!.x, p.y - abs[0]!.y]) };
  };
  const arrowsBoundTo = (id: string): Row[] => [...working.values()].filter((row) => row.type === "arrow" && !row.isDeleted
    && [row.startBinding, row.endBinding].some((end) => end && typeof end === "object" && (end as { elementId?: unknown }).elementId === id));
  const withoutBound = (row: Row, boundId: string) => (Array.isArray(row.boundElements) ? row.boundElements as Array<{ id?: unknown }> : []).filter((entry) => entry.id !== boundId);

  for (const [editIndex, edit] of edits.entries()) {
    bumped = new Set();
    switch (edit.op) {
      case "add_text": {
        const size = measureText(edit.text, FONT_SIZE);
        const row = put(fresh("text", edit.x, edit.y, size.width, size.height, {
          ...textFields(edit.text, FONT_SIZE, edit.text, size), textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true,
        }));
        results.push({ op: edit.op, id: row.id });
        break;
      }
      case "add_sticky": {
        const background = edit.color in WHITEBOARD_STICKY_COLORS ? WHITEBOARD_STICKY_COLORS[edit.color as keyof typeof WHITEBOARD_STICKY_COLORS] : edit.color;
        const box = put(fresh("rectangle", edit.x, edit.y, STICKY_W, STICKY_H, { backgroundColor: background, roundness: { type: 3 } }));
        setBoundText(box, edit.text, STICKY_FONT_SIZE);
        results.push({ op: edit.op, id: box.id });
        break;
      }
      case "add_shape": {
        const row = put(fresh(edit.shapeKind, edit.x, edit.y, edit.w, edit.h, { roundness: edit.shapeKind === "rectangle" ? { type: 3 } : edit.shapeKind === "diamond" ? { type: 2 } : null }));
        results.push({ op: edit.op, id: row.id });
        break;
      }
      case "add_arrow": {
        const resolve = (end: string | { x: number; y: number }): { box: Row | null; point: { x: number; y: number } } | string => {
          if (typeof end !== "string") return { box: null, point: end };
          const row = target(end);
          if (!row) return `The element "${end}" is not on the board.`;
          if (!BINDABLE.has(String(row.type))) return `An arrow cannot attach to a ${String(row.type)}; use a point instead.`;
          return { box: row, point: centre(row) };
        };
        const from = resolve(edit.from); const to = resolve(edit.to);
        if (typeof from === "string") return fail(editIndex, "unknown_element", from);
        if (typeof to === "string") return fail(editIndex, "unknown_element", to);
        if (from.box && to.box && from.box.id === to.box.id) return fail(editIndex, "invalid_edit", "An arrow cannot start and end on the same element.");
        const start = from.box ? outline(from.box, to.point) : from.point;
        const end = to.box ? outline(to.box, from.point) : to.point;
        if (start.x === end.x && start.y === end.y) return fail(editIndex, "invalid_edit", "An arrow needs two different end points.");
        const arrow = put(fresh("arrow", start.x, start.y, Math.abs(end.x - start.x), Math.abs(end.y - start.y), {
          points: [[0, 0], [end.x - start.x, end.y - start.y]], lastCommittedPoint: null, startArrowhead: null, endArrowhead: "arrow", elbowed: false, roundness: { type: 2 },
          startBinding: from.box ? { elementId: from.box.id, focus: 0, gap: 1 } : null, endBinding: to.box ? { elementId: to.box.id, focus: 0, gap: 1 } : null,
        }));
        for (const bound of [from.box, to.box]) {
          if (bound) bump(working.get(bound.id)!, { boundElements: [...(Array.isArray(working.get(bound.id)!.boundElements) ? working.get(bound.id)!.boundElements as unknown[] : []), { id: arrow.id, type: "arrow" }] });
        }
        results.push({ op: edit.op, id: arrow.id });
        break;
      }
      case "place_media": {
        const info = deps.media.get(edit.embeddedMediaId);
        if (!info) return fail(editIndex, "media_unavailable", "That Embedded media is not on this Project's whiteboard media. Only media already on this Project can be placed.");
        const [naturalW, naturalH] = info.width && info.height ? [info.width, info.height] : info.kind === "video" ? DEFAULT_VIDEO : DEFAULT_IMAGE;
        const scale = Math.min(1, MEDIA_MAX_SIDE / Math.max(naturalW, naturalH));
        const row = put(fresh("image", edit.x, edit.y, Math.max(1, Math.round(naturalW * scale)), Math.max(1, Math.round(naturalH * scale)), {
          fileId: edit.embeddedMediaId, status: "saved", scale: [1, 1], crop: null, customData: { quincyMedia: { kind: info.kind } },
        }));
        results.push({ op: edit.op, id: row.id });
        break;
      }
      case "edit": {
        const row = target(edit.id);
        if (!row) return fail(editIndex, "unknown_element", `The element "${edit.id}" is not on the board.`);
        if (edit.text !== undefined) {
          if (row.type === "text") bump(row, { ...textFields(edit.text, num(row.fontSize, FONT_SIZE), edit.text, measureText(edit.text, num(row.fontSize, FONT_SIZE))) });
          else if (CONTAINERS.has(String(row.type))) setBoundText(row, edit.text, STICKY_FONT_SIZE);
          else return fail(editIndex, "invalid_edit", `A ${String(row.type)} holds no text.`);
        }
        if (edit.x !== undefined || edit.y !== undefined) move(working.get(row.id)!, edit.x, edit.y);
        results.push({ op: edit.op, id: row.id });
        break;
      }
      case "delete": {
        const row = target(edit.id);
        if (!row) return fail(editIndex, "unknown_element", `The element "${edit.id}" is not on the board.`);
        const inner = CONTAINERS.has(String(row.type)) ? innerText(row) : undefined;
        for (const arrow of arrowsBoundTo(row.id)) {
          bump(arrow, {
            ...(((arrow.startBinding as { elementId?: unknown } | null)?.elementId === row.id) ? { startBinding: null } : {}),
            ...(((arrow.endBinding as { elementId?: unknown } | null)?.elementId === row.id) ? { endBinding: null } : {}),
          });
        }
        if (row.type === "arrow") {
          for (const end of [row.startBinding, row.endBinding]) {
            const target = end && typeof end === "object" ? live(String((end as { elementId?: unknown }).elementId)) : undefined;
            if (target) bump(target, { boundElements: withoutBound(target, row.id) });
          }
        }
        bump(row, { isDeleted: true });
        if (inner) bump(inner, { isDeleted: true });
        results.push({ op: edit.op, id: row.id });
        break;
      }
    }
  }
  return { ok: true, elements: [...touched].map((id) => working.get(id)!), results };
}
