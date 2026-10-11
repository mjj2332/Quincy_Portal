import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { deliverySlugOfPath } from "@quincy/shared";
import { GuestLoadFailure } from "../guest/GuestLoadFailure";

type DeliveryAppModule = { DeliveryApp: ComponentType<{ slug: string }> };

/** The page is public by address and carries a client's property: keep it out of search and send no Referer from it (the server's headers say the same; the tags cover a cached shell). */
function ensureMeta(name: string, content: string): void {
  if (document.head.querySelector(`meta[name="${name}"]`)) return;
  const meta = document.createElement("meta");
  meta.name = name; meta.content = content; meta.setAttribute("data-delivery", "");
  document.head.appendChild(meta);
}

/**
 * Boots the public Client Delivery page (#787 slice 9) on `/d/<address>-<suffix>` instead of the staff `App`. `main.tsx` chooses it before any staff boot work, because `captureBootLanding`, the
 * preload and `<App />` all reach the staff `/api`. The metas go in synchronously, before the lazy chunk is requested, so they are there even if the chunk never loads. There is no token or fragment to scrub: the address is the page.
 * If the chunk fails, `GuestLoadFailure` offers a full reload, the only thing that recovers a chunk a deploy replaced (docs/lessons.md "A stale lazy chunk after a deploy").
 */
export function mountDelivery(root: HTMLElement, importer: () => Promise<DeliveryAppModule> = () => import("./DeliveryApp"), pathname: string = window.location.pathname, reload: () => void = () => { window.location.reload(); }): void {
  const slug = deliverySlugOfPath(pathname);
  if (slug === null) return;
  ensureMeta("robots", "noindex, nofollow");
  ensureMeta("referrer", "no-referrer");
  const reactRoot = createRoot(root);
  void importer().then(({ DeliveryApp }) => {
    reactRoot.render(<StrictMode><DeliveryApp slug={slug} /></StrictMode>);
  }, () => {
    reactRoot.render(<GuestLoadFailure reload={reload} />);
  });
}
