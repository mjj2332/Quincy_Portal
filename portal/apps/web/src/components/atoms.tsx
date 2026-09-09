import { type ProjectStageKey, useStages } from "../lib/stages";

const stageColors: Record<ProjectStageKey, string> = {
  awaiting_raw: "var(--greige-400)",
  raw_review: "var(--signal-caution)",
  editing_autohdr: "var(--signal-info)",
  editing: "var(--signal-info)",
  edited_review: "var(--signal-caution)",
  delivered: "var(--signal-positive)",
};

export function StatusBadge({ stageKey }: { stageKey: ProjectStageKey }) {
  const { presentationStageKey, stages } = useStages();
  const visibleStageKey = presentationStageKey(stageKey);
  const stage = stages.find(({ key }) => key === visibleStageKey);

  return (
    <span className="row gap2">
      <span className="sdot" style={{ background: stageColors[visibleStageKey] }} />
      <span className="ey">{stage?.label ?? visibleStageKey}</span>
    </span>
  );
}

export function Stars({ value = 0, size = 14 }: { value?: number; size?: number }) {
  // Deliberate: an unrated Asset renders nothing at all, rather than a "0 out of 5" row. (#90)
  if (value <= 0) return null;

  return (
    // `role="img"` is load-bearing: an `aria-label` on a roleless <span> maps to `generic`, which
    // does not support naming, so every major screen reader drops it (#90). Every glyph inside
    // stays `aria-hidden` — the role and label are the sole accessible surface.
    <span role="img" className="tstars" aria-label={`${value} out of 5 stars`}>
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
