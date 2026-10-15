import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { GuestLoadFailure } from "./GuestLoadFailure";
import { reopenWithToken, takeLinkToken } from "./link-fragment";

type GuestAppModule = { GuestApp: ComponentType<{ token: string | null; initialVideoId?: string | null; pageSlug?: string | null }> };

/**
 * Boots the guest page (#741 12b). The `#t=<token>` fragment is read and scrubbed here, synchronously, BEFORE the lazy chunk is requested, so a chunk that fails to load never leaves the credential
 * in the address bar or history. The token then lives only in this closure and is handed to `GuestApp` as a prop. If the chunk fails, `GuestLoadFailure` offers a Reload that puts the
 * address back as the visitor opened it and reloads (`reopenWithToken`): only a full reload recovers a chunk a deploy replaced.
 */
export function mountGuest(root: HTMLElement, importer: () => Promise<GuestAppModule> = () => import("./GuestApp"), reopen: (token: string | null, videoId: string | null, pageSlug: string | null) => void = reopenWithToken): void {
  const { token, videoId, pageSlug } = takeLinkToken();
  const reactRoot = createRoot(root);
  const load = (): void => {
    void importer().then(({ GuestApp }) => {
      reactRoot.render(<StrictMode><GuestApp token={token} initialVideoId={videoId} pageSlug={pageSlug} /></StrictMode>);
    }, () => {
      reactRoot.render(<GuestLoadFailure reload={() => { reopen(token, videoId, pageSlug); }} />);
    });
  };
  load();
}

type GuestUnsubscribeModule = { GuestUnsubscribe: ComponentType<{ token: string | null }> };

/**
 * Boots the unsubscribe page (#741 15b). Same order as `mountGuest`: the `#t=<token>` fragment is read and scrubbed synchronously BEFORE the lazy chunk is requested, and so before the
 * page's POST. The token then lives only in this closure and in the component's props.
 */
export function mountGuestUnsubscribe(root: HTMLElement, importer: () => Promise<GuestUnsubscribeModule> = () => import("./GuestUnsubscribe"), reopen: (token: string | null, videoId: string | null, pageSlug: string | null) => void = reopenWithToken): void {
  const { token, videoId, pageSlug } = takeLinkToken();
  const reactRoot = createRoot(root);
  void importer().then(({ GuestUnsubscribe }) => {
    reactRoot.render(<StrictMode><GuestUnsubscribe token={token} /></StrictMode>);
  }, () => {
    reactRoot.render(<GuestLoadFailure reload={() => { reopen(token, videoId, pageSlug); }} />);
  });
}
