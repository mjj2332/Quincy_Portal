/**
 * Pipeline stages (Implementation-Plan §2 A4).
 * Stable machine KEYS — code and transitions reference keys only.
 * Admin-editable labels/display order live in the pipeline_stages D1 table,
 * seeded from DEFAULT_STAGES. `client_review` is reserved (D-03) but not shipped.
 */

export const STAGE_KEYS = [
  "awaiting_raw",
  "raw_review",
  "editing_autohdr",
  "edited_review",
  "delivered",
] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/** Stages a photographer's assigned project remains visible in. Beyond this, they lose all
 * access to that project — not just Edited-media visibility (see D-02), the project itself. */
export const PHOTOGRAPHER_VISIBLE_STAGES: readonly StageKey[] = ["awaiting_raw", "raw_review"];

export interface StageDefinition {
  key: StageKey;
  label: string;
  displayOrder: number;
}

export const DEFAULT_STAGES: readonly StageDefinition[] = [
  { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1 },
  { key: "raw_review", label: "RAW review", displayOrder: 2 },
  { key: "editing_autohdr", label: "Editing · autoHDR", displayOrder: 3 },
  { key: "edited_review", label: "Edited review", displayOrder: 4 },
  { key: "delivered", label: "Delivered", displayOrder: 5 },
];

/** Forward transitions the pipeline supports; admin can also set any stage directly. */
export const STAGE_TRANSITIONS: Record<StageKey, readonly StageKey[]> = {
  awaiting_raw: ["raw_review"],
  raw_review: ["editing_autohdr"],
  editing_autohdr: ["edited_review"],
  edited_review: ["delivered"],
  delivered: [],
};

export function isStageKey(value: string): value is StageKey {
  return (STAGE_KEYS as readonly string[]).includes(value);
}
