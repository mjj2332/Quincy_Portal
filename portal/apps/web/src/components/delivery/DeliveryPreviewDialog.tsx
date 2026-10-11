import type { DeliveryItemDto, DeliveryPageDto } from "@quincy/shared";
import { FileTextIcon, FilmIcon } from "lucide-react";
import { LazyImage } from "../LazyImage";
import { SheetCloseButton } from "../quincy/SheetCloseButton";
import { Badge } from "../reui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../reui/dialog";
import { DIALOG_TITLE, ReviewLinkDialogFrame } from "../video/ReviewLinkDialogFrame";

const KIND_NOUN: Record<DeliveryItemDto["kind"], string> = { photo: "Photo", floorplan: "Floorplan", copy: "Copy document", video: "Video" };

/**
 * Preview (#787 slice 10): the page DTO the server rendered for an unpublished selection, shown with the staff preview-media URLs it carries. Nothing is created. The frame is
 * `ReviewLinkDialogFrame` (header and footer fixed, body scrolls), as the Review links dialog. "Request unlock" is public-page only, so a locked item is shown as a locked tile here.
 */
export function DeliveryPreviewDialog({ dto, onClose }: { dto: DeliveryPageDto | null; onClose: () => void }) {
  return <Dialog open={dto !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent data-testid="delivery-preview-dialog" showCloseButton={false} className="flex max-h-[calc(100dvh-var(--space-5))] flex-col gap-[var(--space-4)] sm:max-w-[720px]">
      {dto && <ReviewLinkDialogFrame
        header={<DialogHeader>
          <DialogTitle className={DIALOG_TITLE}>{`Preview · ${dto.property.street}`}</DialogTitle>
          <DialogDescription className="text-foreground-secondary">{`How the client page will look as set ${dto.setNumber}. Nothing is published.`}</DialogDescription>
        </DialogHeader>}>
        <ul className="m-0 grid list-none grid-cols-2 gap-[var(--space-3)] p-0 min-[721px]:grid-cols-3" aria-label="Items on the page">
          {dto.items.map((item) => <li key={item.handle} data-testid="delivery-preview-item" className="grid gap-[var(--space-2)]">
            <div className="grid aspect-[4/3] place-items-center overflow-hidden border border-solid border-[var(--border-hairline)] bg-surface-sunken text-foreground-secondary">
              {item.thumbUrl && !item.locked ? <LazyImage src={item.thumbUrl} alt={item.label} className="size-full object-cover" /> : item.kind === "video" ? <FilmIcon aria-hidden className="size-6" /> : <FileTextIcon aria-hidden className="size-6" />}
            </div>
            <div className="flex flex-wrap items-center gap-[var(--space-2)] [font:var(--type-label)]">
              <span>{item.label}</span>
              {item.handle === dto.coverHandle && <Badge variant="info-light">Cover</Badge>}
              {item.locked && <Badge variant="warning-light">Locked</Badge>}
              <span className="sr-only">{KIND_NOUN[item.kind]}</span>
            </div>
          </li>)}
        </ul>
      </ReviewLinkDialogFrame>}
      <SheetCloseButton label="Close" data-testid="delivery-preview-close" />
    </DialogContent>
  </Dialog>;
}
