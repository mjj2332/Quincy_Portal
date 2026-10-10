import type { ReviewLinkDto } from "@quincy/shared";
import { formatCivilDay, formatRelativeTime, sydneyDayKey } from "../../lib/date-format";
import { useNow } from "../../lib/use-now";
import { Button } from "../quincy/Button";
import { EmptyState } from "../quincy/EmptyState";
import { Notice } from "../quincy/Notice";
import { DialogDescription, DialogHeader, DialogTitle } from "../reui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";
import { Spinner } from "../reui/spinner";
import { ReviewLinkStatusBadge } from "./ReviewLinkStatusBadge";
import type { ReviewLinksUi } from "./use-review-links-ui";

export const linkName = (link: Pick<ReviewLinkDto, "label">) => link.label ?? "Untitled link";
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "Last opened 2h ago · 2 open now", or "Not opened yet". `openSessions` is how many guest sessions are live, not a count of opens. */
export function activityLine(link: ReviewLinkDto, now: number): string {
  const { lastOpenedAt, openSessions } = link.activity;
  if (!lastOpenedAt) return "Not opened yet";
  return `Last opened ${formatRelativeTime(lastOpenedAt, now)}${openSessions > 0 ? ` · ${openSessions} open now` : ""}`;
}
export const expiryLine = (link: ReviewLinkDto) => `${link.status === "expired" ? "Expired" : "Expires"} ${formatCivilDay(sydneyDayKey(link.expiresAt))}`;

/** The list step of the Review links dialog (#741 11b): one `reui/item` row per link. */
export function ReviewLinkList({ ui }: { ui: ReviewLinksUi }) {
  const { links, store } = ui;
  const now = useNow();
  return <>
    <DialogHeader>
      <DialogTitle>Review links</DialogTitle>
      <DialogDescription>Private links that let a client watch chosen Versions of chosen films.</DialogDescription>
    </DialogHeader>
    {links.isPending && <p role="status" className="flex items-center gap-[var(--space-2)] text-foreground-secondary"><Spinner aria-hidden="true" role="presentation" className="size-3.5" />Loading Review links…</p>}
    {links.isError && !links.data && <Notice tone="critical" role="alert" className="flex flex-wrap items-center justify-between gap-[var(--space-2)]"><span>{links.error.message || "Review links could not be loaded."}</span><Button type="button" variant="text" className="min-h-11" onClick={() => void links.refetch()}>Retry</Button></Notice>}
    {links.data && links.data.length === 0 && <EmptyState title="No Review links yet.">Tick films on the page, then choose Create Review link.</EmptyState>}
    {links.data && links.data.length > 0 && <ItemGroup className="gap-[var(--space-2)]">
      {links.data.map((link) => <Item key={link.id} variant="outline" data-testid="review-link-row" className="max-[721px]:flex-wrap">
        <ItemContent>
          <ItemTitle>{linkName(link)}<ReviewLinkStatusBadge status={link.status} /></ItemTitle>
          <ItemDescription>{`${expiryLine(link)} · ${plural(link.videos.length, "Video")} · ${activityLine(link, now)}`}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button type="button" variant="secondary" className="min-h-11" aria-label={`Manage ${linkName(link)}`} onClick={() => store.openDetail(link.id)}>Manage</Button>
        </ItemActions>
      </Item>)}
    </ItemGroup>}
  </>;
}
