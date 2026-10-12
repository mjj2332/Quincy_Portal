import type { DeliveryItemDto } from "@quincy/shared";
import { FileTextIcon } from "lucide-react";
import { buttonVariants } from "../components/reui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../components/reui/item";
import { unlockOf, type DeliveryHrefs, type UnlockStates } from "./delivery-model";
import { PremiumBadge, TOUCH, UnlockControl } from "./UnlockControl";

const NOUN: Record<string, string> = { floorplan: "Floorplan", copy: "Copywriting" };

/**
 * The PDFs (Floorplan, Copywriting): one row each. View opens the document in a new tab (`noopener noreferrer`); Download saves the original (same-origin `download` anchor), and is absent in Preview.
 * A locked row has no URL, so no View and no Download: a Premium badge and Request unlock.
 */
export function DocRows({ items, hrefs, unlock, onRequestUnlock, label }: { items: DeliveryItemDto[]; hrefs: DeliveryHrefs | null; unlock: UnlockStates; onRequestUnlock: (handle: string) => void; label: string }) {
  const link = buttonVariants({ variant: "outline", size: "sm", className: `w-fit ${TOUCH}` });
  return <ItemGroup aria-label={label} data-testid="delivery-docs" className="gap-[var(--space-2)]">
    {items.map((item) => <Item key={item.handle} variant="outline" data-testid="delivery-doc" data-handle={item.handle} role="listitem">
      <ItemMedia variant="icon"><FileTextIcon aria-hidden /></ItemMedia>
      <ItemContent>
        <ItemTitle>{item.label}{item.locked && <PremiumBadge />}</ItemTitle>
        <ItemDescription>{`${NOUN[item.kind] ?? "Copywriting"} · PDF`}</ItemDescription>
      </ItemContent>
      <ItemActions className="flex-wrap">
        {item.locked
          ? <UnlockControl label={item.label} state={unlockOf(unlock, item.handle)} onRequest={() => { onRequestUnlock(item.handle); }} />
          : <>
            {item.url !== null && <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`View ${item.label}`} className={link}>View</a>}
            {hrefs && <a href={hrefs.download(item.handle)} download aria-label={`Download ${item.label}`} className={link}>Download</a>}
          </>}
      </ItemActions>
    </Item>)}
  </ItemGroup>;
}
