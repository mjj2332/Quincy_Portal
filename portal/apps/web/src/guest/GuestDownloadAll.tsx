import { DownloadIcon } from "lucide-react";
import type { GuestSessionResponse } from "@quincy/shared";
import { Button } from "../components/reui/button";
import type { GuestApi } from "./guest-api";
import type { GuestVerify } from "./use-guest-verify";
import { useGuestDownloadAll, type GuestDownloadAllController } from "./use-guest-download-all";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/** Download all as a button with its own dialog (the video list, #741 14-ui-guest). The behaviour is `useGuestDownloadAll`'s; a phone film screen draws it as a ⋯ row instead (#879 PR 3b). */
export function GuestDownloadAll(props: { api: GuestApi; verify: GuestVerify; session: GuestSessionResponse; onSession: (next: GuestSessionResponse) => void; onUnavailable: () => void }) {
  const controller = useGuestDownloadAll(props);
  return <><GuestDownloadAllButton controller={controller} />{controller.dialog}</>;
}

/** The desktop control: the button, or the turned-off notice in its place. */
export function GuestDownloadAllButton({ controller }: { controller: GuestDownloadAllController }) {
  if (controller.state === "off") return controller.notice;
  if (controller.state === "hidden") return null;
  return <Button type="button" variant="outline" data-testid="guest-download-all" className={TOUCH} onClick={controller.start}><DownloadIcon aria-hidden="true" />Download all</Button>;
}
