import { useCallback, useEffect, useState } from "react";
import { editorFolderAttentionPausesPipeline, type AdminAttentionResponse, type EditorFolderAttentionKind } from "@quincy/shared";
import { apiGet, apiPost } from "../lib/api";
import { InternalLink } from "./InternalLink";
import { Button } from "@/components/reui/button";
import { EmptyState } from "@/components/quincy/EmptyState";
import { Notice } from "@/components/quincy/Notice";
import { SectionHead } from "@/components/quincy/SectionHead";
import { StatusPill } from "@/components/quincy/StatusPill";
import { TableWrap, Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from "@/components/quincy/Table";

const KIND_LABELS: Record<EditorFolderAttentionKind, string> = {
  editor_folder_move_stuck: "Pipeline paused",
  editor_folder_move_overdue: "Pipeline paused",
  editor_folder_needs_review: "Needs review",
  editor_folder_move_blocked: "Move blocked",
  editor_folder_orphan_upload: "Files left behind",
};

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

/**
 * "Which projects are stuck, and why" (#163). Every latch listed here is cleared where it is owned —
 * the provisioning freeze from Admin → Users (#161), Editor folder mappings by an operator — except
 * an orphan upload (#195), which has no other owner and is acknowledged here once its files are dealt with.
 */
export function AdminAttention() {
  const [data, setData] = useState<AdminAttentionResponse>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [acknowledging, setAcknowledging] = useState<string>();
  const [ackError, setAckError] = useState<string>();

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try { setData(await apiGet<AdminAttentionResponse>("/api/admin/attention")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Items needing attention could not be loaded."); }
    finally { setIsLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const acknowledge = useCallback(async (watchId: string) => {
    setAcknowledging(watchId);
    setAckError(undefined);
    try {
      await apiPost(`/api/admin/attention/orphan-uploads/${encodeURIComponent(watchId)}/acknowledge`, {});
      await load();
    } catch (reason) {
      setAckError(reason instanceof Error ? reason.message : "The report could not be acknowledged.");
    } finally {
      setAcknowledging(undefined);
    }
  }, [load]);

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
        {/* A project can have both a mapping latch and orphan uploads, so the project alone is not a key. */}
        <TableBody>{items.map((item) => <TableRow key={`${item.projectId}:${item.kind}:${item.orphanWatchId ?? ""}`} data-testid="admin-attention-item">
          <TableCell data-label="Project"><InternalLink to={`/projects/${encodeURIComponent(item.projectId)}`}>{item.projectLabel}</InternalLink></TableCell>
          <TableCell data-label="State"><StatusPill tone={editorFolderAttentionPausesPipeline(item.kind) ? "critical" : "caution"}>{KIND_LABELS[item.kind]}</StatusPill></TableCell>
          <TableCell data-label="What happened">{item.headline}{item.detail && <><br /><small className="text-foreground-secondary"><code>{item.code}</code> {item.detail}</small></>}
            {item.orphanWatchId && <><br /><Button type="button" variant="outline" className="mt-[var(--space-2)]" disabled={acknowledging !== undefined} onClick={() => void acknowledge(item.orphanWatchId!)}>Acknowledge</Button></>}
          </TableCell>
          <TableCell data-label="Last updated">{formatTimestamp(item.updatedAt)}</TableCell>
        </TableRow>)}</TableBody>
      </Table></TableWrap>}
      {ackError && <Notice tone="critical" role="alert" className="mt-[var(--space-4)]" data-testid="admin-attention-ack-error">Could not acknowledge the report: {ackError}</Notice>}
      {data.truncated && <Notice tone="caution" role="status" className="mt-[var(--space-4)]">Showing the first {items.length} items; more need attention.</Notice>}
    </>}
  </div>;
}
