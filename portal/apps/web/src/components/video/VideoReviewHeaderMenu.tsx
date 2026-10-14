import { useRef } from "react";
import { IconButton } from "../quincy/icon-button";
import { MENU_ITEM, Menu, MenuPrimitive } from "../quincy/menu";
import { copyText } from "../../lib/clipboard";

/**
 * The review viewer's top-bar actions on a phone (#877 S2): Copy link, Download and Create Review link in one ⋯ menu so the bar stays a single line. Each item exists only
 * when the viewer would have offered its inline button, and the trigger is not rendered when none is. Same pieces as the card's "⋯" (`VideoCard`): `quincy/menu.tsx` with
 * `MenuPrimitive.Item` / `LinkItem` and `MENU_ITEM`. Download is a real anchor, as there, so the browser's own download runs on it.
 */
export function VideoReviewHeaderMenu({ copyHref, downloadHref, downloadLabel, onCreateReviewLink }: {
  copyHref?: string | undefined;
  downloadHref?: string | undefined;
  /** Accessible name of the Download item (it names the Version). */
  downloadLabel?: string | undefined;
  onCreateReviewLink?: (() => void) | undefined;
}) {
  // Create Review link opens a dialog that takes focus: the menu must not hand focus back to its trigger on that path (Base UI `finalFocus`, #862).
  const handOff = useRef(false);
  if (!copyHref && !downloadHref && !onCreateReviewLink) return null;
  return <Menu
    triggerLabel="Video actions" label="Video menu" triggerTestId="video-header-menu"
    triggerRender={<IconButton />}
    triggerClassName="text-foreground"
    trigger={<span aria-hidden="true">⋯</span>}
    finalFocus={() => (handOff.current ? false : undefined)}
    onOpenChange={(isOpen) => { if (isOpen) handOff.current = false; }}
  >
    {copyHref && <MenuPrimitive.Item className={MENU_ITEM} data-testid="video-menu-copy-link" onClick={() => { copyText(copyHref); }}>Copy link</MenuPrimitive.Item>}
    {downloadHref && <MenuPrimitive.LinkItem closeOnClick className={MENU_ITEM} data-testid="video-download" href={downloadHref} download {...(downloadLabel ? { "aria-label": downloadLabel } : {})}>Download</MenuPrimitive.LinkItem>}
    {onCreateReviewLink && <MenuPrimitive.Item className={MENU_ITEM} data-testid="video-create-review-link" onClick={() => { handOff.current = true; onCreateReviewLink(); }}>Create Review link</MenuPrimitive.Item>}
  </Menu>;
}
