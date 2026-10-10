import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { GuestLoadFailure } from "./GuestLoadFailure";
import { reopenWithToken, takeLinkToken } from "./link-fragment";

type GuestAppModule = { GuestApp: ComponentType<{ token: string | null }> };

/**
 * Boots the guest page (#741 12b). The `#t=<token>` fragment is read and scrubbed here, synchronously, BEFORE the lazy chunk is requested, so a chunk that fails to load never leaves the credential
 * in the address bar or history. The token then lives only in this closure and is handed to `GuestApp` as a prop. If the chunk fails, `GuestLoadFailure` offers a Reload that puts the
 * address back as the visitor opened it and reloads (`reopenWithToken`): only a full reload recovers a chunk a deploy replaced.
 */
export function mountGuest(root: HTMLElement, importer: () => Promise<GuestAppModule> = () => import("./GuestApp"), reopen: (token: string | null) => void = reopenWithToken): void {
  const token = takeLinkToken();
  const reactRoot = createRoot(root);
  const load = (): void => {
    void importer().then(({ GuestApp }) => {
      reactRoot.render(<StrictMode><GuestApp token={token} /></StrictMode>);
    }, () => {
      reactRoot.render(<GuestLoadFailure reload={() => { reopen(token); }} />);
    });
  };
  load();
}
