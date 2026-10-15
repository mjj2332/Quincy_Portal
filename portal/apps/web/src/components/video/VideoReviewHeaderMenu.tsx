import { DownloadIcon, FileDown, Link2, Smartphone, Trash2 } from "lucide-react";
import { copyText } from "../../lib/clipboard";
import { Item, ItemContent, ItemMedia, ItemTitle } from "../reui/item";
import { Button } from "../reui/button";
import { ActionRow, ActionSeparator, ReviewActionSheet } from "../quincy/ReviewActionSheet";
import { EXPORT_PANEL_WIDTH, MarkerExportMenuItems, type MarkerExport } from "./VideoMarkerExportMenu";
import { Menu } from "../quincy/menu";

/**
 * The staff review viewer's ⋯ on a phone (#879, D5, P9/P10): a bottom action sheet of Social preview, Download, Marker export, Copy link, Create Review link and, below a rule,
 * Remove version…. Each row exists only when the viewer would have offered its desktop control, and the trigger is not rendered when none does. "Open in iPhone player" is #880's: add its row
 * between Create Review link and the rule. Same pieces as before, re-homed: Download is a real anchor; Marker export opens the notes ⋯ menu's own export options (`MarkerExportMenuItems`) as a menu from its row.
 * Reuse: `quincy/ReviewActionSheet` (`reui/sheet` + `reui/item`), `quincy/menu` for the export options.
 */
export function VideoReviewHeaderMenu({ container, social, copyHref, downloadHref, downloadLabel, markerExport, onCreateReviewLink, onRemoveVersion, removeDisabled = false }: {
  /** The viewer's overlay slot: the sheet portals into it. */
  container: HTMLElement | null;
  /** Social preview: its state and toggle. Absent where the Project offers none. */
  social?: { on: boolean; toggle: () => void } | undefined;
  copyHref?: string | undefined;
  downloadHref?: string | undefined;
  /** Accessible name of the Download row (it names the Version). */
  downloadLabel?: string | undefined;
  /** The notes host's marker export, lifted so the header can reach it. Absent when the `export` part is off or the notes are not loaded. */
  markerExport?: MarkerExport | undefined;
  onCreateReviewLink?: (() => void) | undefined;
  /** Opens the Version removal confirmation. */
  onRemoveVersion?: (() => void) | undefined;
  removeDisabled?: boolean;
}) {
  const exportOn = markerExport?.enabled === true;
  if (!social && !copyHref && !downloadHref && !exportOn && !onCreateReviewLink && !onRemoveVersion) return null;
  return <ReviewActionSheet container={container}>
    {(close) => <>
      {social && <ActionRow testId="video-social-toggle" icon={<Smartphone aria-hidden="true" />} pressed={social.on} onSelect={() => { social.toggle(); close(); }}>Social preview</ActionRow>}
      {downloadHref && <ActionRow testId="video-download" icon={<DownloadIcon aria-hidden="true" />} href={downloadHref} download label={downloadLabel} onSelect={() => { close(); }}>Download</ActionRow>}
      {markerExport && exportOn && <Menu
        triggerLabel="Marker export" label="Export markers" triggerTestId="video-marker-export-row" side="top" align="start" panelClassName={EXPORT_PANEL_WIDTH}
        triggerRender={<Item size="sm" render={<Button type="button" variant="ghost" className="h-auto min-h-11 w-full cursor-pointer justify-start text-start font-normal" />} />}
        trigger={<><ItemMedia variant="icon"><FileDown aria-hidden="true" /></ItemMedia><ItemContent><ItemTitle>Marker export…</ItemTitle></ItemContent></>}
      >
        <MarkerExportMenuItems exp={{ ...markerExport, start: (format, options) => { close(); return markerExport.start(format, options); } }} />
      </Menu>}
      {copyHref && <ActionRow testId="video-menu-copy-link" icon={<Link2 aria-hidden="true" />} onSelect={() => { copyText(copyHref); close(); }}>Copy link</ActionRow>}
      {onCreateReviewLink && <ActionRow testId="video-create-review-link" icon={<Link2 aria-hidden="true" />} onSelect={() => { close(true); onCreateReviewLink(); }}>Create Review link</ActionRow>}
      {onRemoveVersion && <>
        {(social || copyHref || downloadHref || exportOn || onCreateReviewLink) && <ActionSeparator />}
        <ActionRow testId="video-header-remove-version" icon={<Trash2 aria-hidden="true" />} danger disabled={removeDisabled} onSelect={() => { close(true); onRemoveVersion(); }}>Remove version…</ActionRow>
      </>}
    </>}
  </ReviewActionSheet>;
}
