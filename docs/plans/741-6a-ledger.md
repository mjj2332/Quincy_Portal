# #741 slice 6a: reuse ledger

6a is a pure extraction. It adds **no new UI element**: no button, input, widget role, token or visible change.

| Element | Line |
|---|---|
| Stroke SVG renderers (`components/quincy/freehand-strokes.tsx`: `StrokeVisible`, `StrokeHitTarget`) | Moved verbatim from `Lightbox.tsx`, which already drew these `<circle>`/`<polyline>` nodes. Quincy-owned, not a ReUI candidate: ReUI `signature-pad` was searched in the 741-6 plan and fails (pixel coordinates, variable ink, its own undo). Not a widget role, so `ui-primitive-ratchet.guard.test.ts` is untouched. |
| `useFreehandMarkup` (`lib/use-freehand-markup.ts`) | Logic only, moved from `Lightbox.tsx`. No markup. |
| Stroke schema (`packages/shared/src/freehand-strokes.ts`) | Moved from `routes/annotations.ts` (loose form kept) and `mcp/tools/collab-writes.ts` (strict variant now built at that call site). |
| Lightbox toolbar and pen/width pickers | Unchanged and not touched; still the allowlisted legacy raw buttons. |
