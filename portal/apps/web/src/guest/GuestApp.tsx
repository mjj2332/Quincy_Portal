import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { createGuestApi, type GuestApi } from "./guest-api";
import { readLinkId, takeLinkToken } from "./link-fragment";
import { GuestVideoScreen } from "./GuestVideoScreen";
import { LimitedScreen, PasscodeScreen, UnavailableScreen, UnreachableScreen, VideoListScreen } from "./GuestScreens";

type Screen =
  | { name: "boot" }
  | { name: "passcode"; error: string | null; retryAfterSeconds: number | null; pending: boolean }
  | { name: "limited"; retryAfterSeconds: number }
  | { name: "unreachable" }
  | { name: "unavailable" }
  | { name: "list" }
  | { name: "video"; index: number };

/**
 * The guest review page (#741 12b), read-only, mounted by `main.tsx` on `/d/review` instead of the staff `App`. It talks to `/d/api/links/<linkId>/...` through `guest-api` and to
 * nothing else; `guest-boundary.guard.test.ts` keeps the staff router, auth and API out of this tree. The state is in memory and the URL never changes after the fragment scrub:
 * boot (scrub, then exchange the token, or resume the session on a reload) -> passcode | limited | unreachable | unavailable | list -> video(index). A single-Video link skips the list.
 * A 404 or a lost 401 is `unavailable` (no oracle); a network error or 5xx is `unreachable`, a calm retry of the step that failed.
 */
export function GuestApp() {
  const [screen, setScreen] = useState<Screen>({ name: "boot" });
  const [session, setSession] = useState<GuestSessionResponse | null>(null);
  const [videos, setVideos] = useState<GuestVideoDto[]>([]);
  const api = useMemo<GuestApi | null>(() => { const id = readLinkId(); return id === null ? null : createGuestApi(id); }, []);
  // The token lives here once the fragment is scrubbed, so a wrong passcode can retry. Never in the URL, storage or a log.
  const token = useRef<string | null>(null);
  const started = useRef(false);
  // Whether this link has asked for a passcode: an initial rate limit on a link that has not is a token-only retry, not a passcode form.
  const asked = useRef(false);
  // The step that failed transiently; the Try again button repeats it.
  const retry = useRef<() => void>(() => undefined);

  const fail = useCallback((step: () => void) => {
    retry.current = () => { setScreen({ name: "boot" }); step(); };
    setScreen({ name: "unreachable" });
  }, []);

  const enter = useCallback(async (opened: GuestApi, next: GuestSessionResponse) => {
    setSession(next);
    const list = await opened.videos();
    if (list.kind === "gone") { setScreen({ name: "unavailable" }); return; }
    if (list.kind === "transient") { fail(() => { void enter(opened, next); }); return; }
    setVideos(list.value);
    setScreen(list.value.length === 1 ? { name: "video", index: 0 } : { name: "list" });
  }, [fail]);

  const exchange = useCallback(async (opened: GuestApi, tokenValue: string, passcode?: string) => {
    const result = await opened.exchange(tokenValue, passcode);
    if (result.ok) { token.current = null; await enter(opened, result.session); return; }
    if (result.reason === "passcode_required") { asked.current = true; setScreen({ name: "passcode", error: null, retryAfterSeconds: null, pending: false }); }
    else if (result.reason === "passcode_incorrect") { asked.current = true; setScreen({ name: "passcode", error: "That passcode isn't right. Check it and try again.", retryAfterSeconds: null, pending: false }); }
    else if (result.reason === "limited") {
      if (asked.current || passcode !== undefined) setScreen({ name: "passcode", error: null, retryAfterSeconds: result.retryAfterSeconds, pending: false });
      else { retry.current = () => { setScreen({ name: "boot" }); void exchange(opened, tokenValue); }; setScreen({ name: "limited", retryAfterSeconds: result.retryAfterSeconds }); }
    }
    else if (result.reason === "unreachable") fail(() => { void exchange(opened, tokenValue, passcode); });
    else setScreen({ name: "unavailable" });
  }, [enter, fail]);

  const resume = useCallback(async (opened: GuestApi) => {
    const existing = await opened.session();
    if (existing.kind === "gone") setScreen({ name: "unavailable" });
    else if (existing.kind === "transient") fail(() => { void resume(opened); });
    else await enter(opened, existing.value);
  }, [enter, fail]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The scrub comes first and is synchronous: no request below can be made while the token is still in the address bar.
    const scrubbed = takeLinkToken();
    if (api === null) { setScreen({ name: "unavailable" }); return; }
    if (scrubbed !== null) { token.current = scrubbed; void exchange(api, scrubbed); return; }
    void resume(api);
  }, [api, exchange, resume]);

  const submitPasscode = (passcode: string) => {
    if (api === null || token.current === null) { setScreen({ name: "unavailable" }); return; }
    setScreen((current) => (current.name === "passcode" ? { ...current, pending: true } : current));
    void exchange(api, token.current, passcode);
  };
  const unavailable = useCallback(() => { setScreen({ name: "unavailable" }); }, []);

  if (api === null || screen.name === "unavailable") return <UnavailableScreen />;
  if (screen.name === "unreachable") return <UnreachableScreen onRetry={() => { retry.current(); }} />;
  if (screen.name === "limited") return <LimitedScreen retryAfterSeconds={screen.retryAfterSeconds} onRetry={() => { retry.current(); }} />;
  if (screen.name === "boot") return <main className="min-h-dvh bg-background" aria-busy="true" />;
  if (screen.name === "passcode") return <PasscodeScreen error={screen.error} retryAfterSeconds={screen.retryAfterSeconds} pending={screen.pending} onSubmit={submitPasscode} />;
  if (screen.name === "list") return <VideoListScreen title={session?.link.label ?? null} videos={videos} onOpen={(index) => { setScreen({ name: "video", index }); }} />;
  return <GuestVideoScreen api={api} videos={videos} index={screen.index} onIndex={(index) => { setScreen({ name: "video", index }); }} onBack={videos.length > 1 ? () => { setScreen({ name: "list" }); } : null} onUnavailable={unavailable} />;
}
