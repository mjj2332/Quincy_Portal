import { useCallback, useEffect, useState } from "react";
import type { AdminAttentionResponse, EditorFolderAttentionKind } from "@quincy/shared";
import { apiGet } from "../lib/api";
import { InternalLink } from "./InternalLink";
import { Button } from "@/components/reui/button";
import { EmptyState } from "@/components/quincy/EmptyState";
import { Notice } from "@/components/quincy/Notice";
import { SectionHead } from "@/components/quincy/SectionHead";
import { StatusPill, type StatusTone } from "@/components/quincy/StatusPill";
import { TableWrap, Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from "@/components/quincy/Table";

const KIND_LABELS: Record<EditorFolderAttentionKind, { label: string; tone: StatusTone }> = {
  editor_folder_move_stuck: { label: "Pipeline paused", tone: "critical" },
  editor_folder_move_overdue: { label: "Pipeline paused", tone: "critical" },
  editor_folder_needs_review: { label: "Needs review", tone: "caution" },
  editor_folder_move_blocked: { label: "Move blocked", tone: "caution" },
};

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

/**
 * "Which projects are stuck, and why" (#163): read-only. Every latch listed here is cleared where it
 * is owned — the provisioning freeze from Admin → Users (#161), Editor folder mappings by an operator.
 */
export function AdminAttention() {
  const [data, setData] = useState<AdminAttentionResponse>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try { setData(await apiGet<AdminAttentionResponse>("/api/admin/attention")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Items needing attention could not be loaded."); }
    finally { setIsLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const freeze = data?.provisioningFreeze ?? null;
  const items = data?.items ?? [];
  return <div className="mb-[var(--space-7)]" data-testid="admin-attention">
    <SectionHead eyebrow="Latched states" actions={<Button type="button" variant="outline" onClick={() => void load()} disabled={isLoading}>Refresh</Button>}>Needs attention</SectionHead>
    {isLoading && !data && <EmptyState role="status" title="Loading.">Checking for stuck projects.</EmptyState>}
    {/* A failed load must never read as "nothing needs attention". */}
    {error && <EmptyState role="alert" tone="error" title="Could not check for stuck projects.">{error}</EmptyState>}
    {!error && data && <>
      {freeze && <Notice role="alert" className="mb-[var(--space-4)]" data-testid="admin-attention-freeze">
        <strong>External Editor provisioning is frozen</strong> since {formatTimestamp(freeze.frozenAt)}: the cache purge after a role change did not complete
        {freeze.attempts !== null ? ` after ${freeze.attempts} attempts` : ""}{freeze.jobId ? ` (job ${freeze.jobId})` : ""}. Confirm a Cloudflare zone purge has completed, then release it from Admin → Users.
      </Notice>}
      {!freeze && items.length === 0 && <EmptyState title="Nothing needs attention.">No project is stuck, and External Editor provisioning is open.</EmptyState>}
      {items.length > 0 && <TableWrap><Table>
        <TableHead><TableRow><TableHeader>Project</TableHeader><TableHeader>State</TableHeader><TableHeader>What happened</TableHeader><TableHeader>Last updated</TableHeader></TableRow></TableHead>
        <TableBody>{items.map((item) => <TableRow key={item.projectId} data-testid="admin-attention-item">
          <TableCell data-label="Project"><InternalLink to={`/projects/${encodeURIComponent(item.projectId)}`}>{item.projectLabel}</InternalLink></TableCell>
          <TableCell data-label="State"><StatusPill tone={KIND_LABELS[item.kind].tone}>{KIND_LABELS[item.kind].label}</StatusPill></TableCell>
          <TableCell data-label="What happened">{item.headline}{item.detail && <><br /><small className="text-foreground-secondary"><code>{item.code}</code> {item.detail}</small></>}</TableCell>
          <TableCell data-label="Last updated">{formatTimestamp(item.updatedAt)}</TableCell>
        </TableRow>)}</TableBody>
      </Table></TableWrap>}
      {data.truncated && <Notice tone="caution" role="status" className="mt-[var(--space-4)]">Showing the first {items.length} projects; more are stuck.</Notice>}
    </>}
  </div>;
}
