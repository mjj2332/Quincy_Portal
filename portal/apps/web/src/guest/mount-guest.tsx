import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { GuestLoadFailure } from "./GuestLoadFailure";
import { takeLinkToken } from "./link-fragment";

type GuestAppModule = { GuestApp: ComponentType<{ token: string | null }> };

/**
 * Boots the guest page (#741 12b). The `#t=<token>` fragment is read and scrubbed here, synchronously, BEFORE the lazy chunk is requested, so a chunk that fails to load never leaves the credential
 * in the address bar or history. The token then lives only in this closure and is handed to `GuestApp` as a prop. If the chunk fails, `GuestLoadFailure` offers a Reload that retries the import
 * in place with the same in-memory token (a `location.reload()` would lose it, the fragment being gone).
 */
export function mountGuest(root: HTMLElement, importer: () => Promise<GuestAppModule> = () => import("./GuestApp")): void {
  const token = takeLinkToken();
  const reactRoot = createRoot(root);
  const load = (): void => {
    void importer().then(({ GuestApp }) => {
      reactRoot.render(<StrictMode><GuestApp token={token} /></StrictMode>);
    }, () => {
      reactRoot.render(<GuestLoadFailure reload={load} />);
    });
  };
  load();
}
