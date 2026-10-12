import { useCallback, useEffect, useState } from "react";
import type { DeliveryPageDto } from "@quincy/shared";
import { SheetCloseButton } from "../quincy/SheetCloseButton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../reui/dialog";
import { DIALOG_TITLE, ReviewLinkDialogFrame } from "../video/ReviewLinkDialogFrame";
import { DeliveryPage } from "../../delivery/DeliveryPage";
import type { UnlockStates } from "../../delivery/delivery-model";

/**
 * Preview (#787 slices 9 and 10): the page DTO the server rendered for an unpublished selection, shown by the very presentation the client gets (`delivery/DeliveryPage`), so what staff check is what is delivered.
 * Nothing is created. The frame is `ReviewLinkDialogFrame` (header and footer fixed, body scrolls). The DTO's own `url`s are the staff preview-media addresses, so photos open in the lightbox, films play and a PDF's View opens a
 * new tab. Two things differ from the public page: `hrefs` is null, so there is no download of any kind, and "Request unlock" is answered locally ("Requested") without any request, because the real one notifies Admins and Editors.
 */
export function DeliveryPreviewDialog({ dto, onClose }: { dto: DeliveryPageDto | null; onClose: () => void }) {
  const [unlock, setUnlock] = useState<UnlockStates>({});
  useEffect(() => { if (dto === null) setUnlock({}); }, [dto]);
  const requestUnlock = useCallback((handle: string) => { setUnlock((current) => ({ ...current, [handle]: { kind: "requested" } })); }, []);
  return <Dialog open={dto !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent data-testid="delivery-preview-dialog" showCloseButton={false} className="flex max-h-[calc(100dvh-var(--space-5))] flex-col gap-[var(--space-4)] sm:max-w-[720px]">
      {dto && <ReviewLinkDialogFrame
        header={<DialogHeader>
          <DialogTitle className={DIALOG_TITLE}>Preview</DialogTitle>
          <DialogDescription className="text-foreground-secondary">{`${dto.property.street}: how the client page will look as set ${dto.setNumber}. Nothing is published.`}</DialogDescription>
        </DialogHeader>}>
        <DeliveryPage dto={dto} hrefs={null} unlockState={unlock} onRequestUnlock={requestUnlock} />
      </ReviewLinkDialogFrame>}
      <SheetCloseButton label="Close" data-testid="delivery-preview-close" />
    </DialogContent>
  </Dialog>;
}
