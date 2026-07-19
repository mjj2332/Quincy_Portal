import { DEFAULT_STAGES, type StageKey } from "@quincy/shared";

const stageColors: Record<StageKey, string> = {
  awaiting_raw: "var(--greige-400)",
  raw_review: "var(--signal-caution)",
  editing_autohdr: "var(--signal-info)",
  edited_review: "var(--signal-caution)",
  delivered: "var(--signal-positive)",
};

export function StatusBadge({ stageKey }: { stageKey: StageKey }) {
  const stage = DEFAULT_STAGES.find(({ key }) => key === stageKey);

  return (
    <span className="row gap2">
      <span className="sdot" style={{ background: stageColors[stageKey] }} />
      <span className="ey">{stage?.label ?? stageKey}</span>
    </span>
  );
}

export function Stars({ value = 0, size = 14 }: { value?: number; size?: number }) {
  if (value <= 0) return null;

  return (
    <span className="tstars" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <span key={star} className={star <= value ? "on" : "off"} style={{ fontSize: size }} aria-hidden="true">
          ★
        </span>
      ))}
    </span>
  );
}

export function LabelDot({ color, name, size = 9 }: { color: string; name: string; size?: number }) {
  return <span className="ldot" title={name} style={{ background: color, width: size, height: size }} />;
}
