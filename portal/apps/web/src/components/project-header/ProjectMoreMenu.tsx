import { CalendarDaysIcon, ChartGanttIcon, LinkIcon, MoreHorizontalIcon, PencilIcon } from "lucide-react";
import type { WorkspaceTab } from "@quincy/shared";
import { Button } from "@/components/reui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/reui/tooltip";
import { Menu, MenuPrimitive, MENU_ITEM } from "../quincy/menu";
import { InternalLink } from "../InternalLink";
import { useCopyProjectLink } from "../quincy/CopyProjectLinkButton";
import { useShowInDestinations } from "../quincy/ProjectShowIn";
import type { ShowInDestination } from "../../lib/project-show-in";
import type { ProjectDetail } from "../../lib/project-data";
import { cn } from "../../lib/utils";
import { HEADER_ICON_CHIP } from "./header-styles";
import { passEscape } from "./HeaderTooltip";

const ITEM = cn(MENU_ITEM, "gap-[var(--space-2)] no-underline [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-foreground-secondary");
const REASON = "block [font:var(--type-eyebrow)] text-foreground-secondary";

/**
 * Where "Edit project details" leads, or null when it is not offered. #455: an archived Project's details are read-only, so an Admin
 * with backend access is offered "Restore or delete" there instead, and nobody else is offered the link.
 */
export function projectDetailsAction(project: Pick<ProjectDetail, "id">, { canEdit, archived, canAdminBackend }: { canEdit: boolean; archived: boolean; canAdminBackend: boolean }): { href: string; label: string } | null {
  if (!canEdit || (archived && !canAdminBackend)) return null;
  return { href: `/projects/${encodeURIComponent(project.id)}/edit`, label: archived ? "Restore or delete" : "Edit project details" };
}

function ShowInItem({ label, icon, destination }: { label: string; icon: React.ReactNode; destination: ShowInDestination }) {
  if (!destination.available) {
    return <MenuPrimitive.Item disabled className={cn(ITEM, "items-start")} data-testid={`project-more-${label === "Show in Calendar" ? "calendar" : "timeline"}`}>
      {icon}<span><span className="block">{label}</span><span className={REASON}>{destination.reason}</span></span>
    </MenuPrimitive.Item>;
  }
  return <MenuPrimitive.LinkItem closeOnClick label={label} className={ITEM} data-testid={`project-more-${label === "Show in Calendar" ? "calendar" : "timeline"}`} render={<InternalLink to={destination.href} />}>
    {icon}{label}
  </MenuPrimitive.LinkItem>;
}

/**
 * #914 D5 — the header's ⋯: the actions people use less often. Edit project details (or Restore or delete), Copy link to the tab
 * being shown, then Show in Calendar and Show in Timeline (hidden for roles without `viewProductionCalendar`; an unavailable one is
 * a disabled item with its reason). Links are `InternalLink`s, so a plain click is an SPA push and modifier-click opens a tab.
 */
export function ProjectMoreMenu({ project, activeTab, canEdit, archived, canAdminBackend }: { project: ProjectDetail; activeTab: WorkspaceTab; canEdit: boolean; archived: boolean; canAdminBackend: boolean }) {
  const { copy } = useCopyProjectLink(project.id, activeTab);
  const destinations = useShowInDestinations(project);
  const details = projectDetailsAction(project, { canEdit, archived, canAdminBackend });
  // Story 23: the ⋯ names itself in a tooltip too (the menu's trigger is the tooltip's trigger, `HeaderTooltip`'s composition).
  return <Tooltip onOpenChange={passEscape}><Menu
    triggerLabel="More actions"
    label="More actions"
    triggerTestId="project-more-actions"
    triggerRender={<TooltipTrigger render={<Button type="button" variant="outline" size="icon-header" className={HEADER_ICON_CHIP} />} />}
    trigger={<MoreHorizontalIcon aria-hidden="true" className="size-[18px]" />}
    panelClassName="w-60 p-[var(--space-1)]"
    sideOffset={6}
  >
    {details && <MenuPrimitive.LinkItem closeOnClick label={details.label} className={ITEM} data-testid="project-more-details" render={<InternalLink to={details.href} />}>
      <PencilIcon aria-hidden="true" />{details.label}
    </MenuPrimitive.LinkItem>}
    <MenuPrimitive.Item className={ITEM} data-testid="project-more-copy-link" onClick={copy}><LinkIcon aria-hidden="true" />Copy link</MenuPrimitive.Item>
    {destinations && <>
      <MenuPrimitive.Separator className="my-[var(--space-1)] h-px bg-border" />
      <ShowInItem label="Show in Calendar" icon={<CalendarDaysIcon aria-hidden="true" />} destination={destinations.calendar} />
      <ShowInItem label="Show in Timeline" icon={<ChartGanttIcon aria-hidden="true" />} destination={destinations.timeline} />
    </>}
  </Menu><TooltipContent side="bottom" data-testid="header-tooltip">More actions</TooltipContent></Tooltip>;
}
