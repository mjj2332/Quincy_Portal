// TB8-09 slice 4, K-3: this colour-label palette was declared identically in
// Lightbox.tsx and PhotoGrid.tsx (`review-labels.ts` §5.5). It is presentation, not a
// pipeline contract, so it does not belong in `@quincy/shared` — one owner here instead,
// imported by both call sites.
export type ReviewColorLabel = "hero" | "select" | "maybe" | "cut";

export const REVIEW_LABELS: { value: ReviewColorLabel; name: string; color: string }[] = [
  { value: "hero", name: "Hero", color: "#9a6a1f" },
  { value: "select", name: "Select", color: "#3f5b3a" },
  { value: "maybe", name: "Maybe", color: "#2f3b4d" },
  { value: "cut", name: "Cut", color: "#7a2420" },
];
