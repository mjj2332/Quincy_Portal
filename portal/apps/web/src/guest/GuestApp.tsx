import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { createGuestApi, type GuestApi } from "./guest-api";
import { readLinkId, takeLinkToken } from "./link-fragment";
import { GuestVideoScreen } from "./GuestVideoScreen";
import { PasscodeScreen, UnavailableScreen, VideoListScreen } from "./GuestScreens";

type Screen =
  | { name: "boot" }
  | { name: "passcode"; error: string | null; retryAfterSeconds: number | null; pending: boolean }
  | { name: "unavailable" }
  | { name: "list" }
  | { name: "video"; index: number };

/**
 * The guest review page (#741 12b), read-only, mounted by `main.tsx` on `/d/review` instead of the staff `App`. It talks to `/d/api/links/<linkId>/...` through `guest-api` and to
 * nothing else; `guest-boundary.guard.test.ts` keeps the staff router, auth and API out of this tree. The state is in memory and the URL never changes after the fragment scrub:
 * boot (scrub, then exchange the token, or resume the session on a reload) -> passcode | unavailable | list -> video(index). A single-Video link skips the list.
 */
export function GuestApp() {
  const [screen, setScreen] = useState<Screen>({ name: "boot" });
  const [session, setSession] = useState<GuestSessionResponse | null>(null);
  const [videos, setVideos] = useState<GuestVideoDto[]>([]);
  const api = useMemo<GuestApi | null>(() => { const id = readLinkId(); return id === null ? null : createGuestApi(id); }, []);
  // The token lives here once the fragment is scrubbed, so a wrong passcode can retry. Never in the URL, storage or a log.
  const token = useRef<string | null>(null);
  const started = useRef(false);

  const enter = useCallback(async (opened: GuestApi, next: GuestSessionResponse) => {
    setSession(next);
    const list = await opened.videos();
    if (list === null) { setScreen({ name: "unavailable" }); return; }
    setVideos(list);
    setScreen(list.length === 1 ? { name: "video", index: 0 } : { name: "list" });
  }, []);

  const exchange = useCallback(async (opened: GuestApi, tokenValue: string, passcode?: string) => {
    const result = await opened.exchange(tokenValue, passcode);
    if (result.ok) { token.current = null; await enter(opened, result.session); return; }
    if (result.reason === "passcode_required") setScreen({ name: "passcode", error: null, retryAfterSeconds: null, pending: false });
    else if (result.reason === "passcode_incorrect") setScreen({ name: "passcode", error: "That passcode isn't right. Check it and try again.", retryAfterSeconds: null, pending: false });
    else if (result.reason === "limited") setScreen({ name: "passcode", error: null, retryAfterSeconds: result.retryAfterSeconds, pending: false });
    else setScreen({ name: "unavailable" });
  }, [enter]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The scrub comes first and is synchronous: no request below can be made while the token is still in the address bar.
    const scrubbed = takeLinkToken();
    if (api === null) { setScreen({ name: "unavailable" }); return; }
    if (scrubbed !== null) { token.current = scrubbed; void exchange(api, scrubbed); return; }
    void api.session().then((existing) => { if (existing === null) setScreen({ name: "unavailable" }); else return enter(api, existing); });
  }, [api, exchange, enter]);

  const submitPasscode = (passcode: string) => {
    if (api === null || token.current === null) { setScreen({ name: "unavailable" }); return; }
    setScreen((current) => (current.name === "passcode" ? { ...current, pending: true } : current));
    void exchange(api, token.current, passcode);
  };
  const unavailable = useCallback(() => { setScreen({ name: "unavailable" }); }, []);

  if (api === null || screen.name === "unavailable") return <UnavailableScreen />;
  if (screen.name === "boot") return <main className="min-h-dvh bg-background" aria-busy="true" />;
  if (screen.name === "passcode") return <PasscodeScreen error={screen.error} retryAfterSeconds={screen.retryAfterSeconds} pending={screen.pending} onSubmit={submitPasscode} />;
  if (screen.name === "list") return <VideoListScreen title={session?.link.label ?? null} videos={videos} onOpen={(index) => { setScreen({ name: "video", index }); }} />;
  return <GuestVideoScreen api={api} videos={videos} index={screen.index} onIndex={(index) => { setScreen({ name: "video", index }); }} onBack={videos.length > 1 ? () => { setScreen({ name: "list" }); } : null} onUnavailable={unavailable} />;
}
