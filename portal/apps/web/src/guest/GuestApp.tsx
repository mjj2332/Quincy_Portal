import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GuestDecision, GuestSessionResponse, GuestVideoDto } from "@quincy/shared";
import { createGuestApi, type GuestApi } from "./guest-api";
import { readLinkId } from "./link-fragment";
import { GuestVideoScreen } from "./GuestVideoScreen";
import { createGuestWriter } from "./use-guest-writer";
import { createGuestDrafts } from "./guest-drafts";
import { createGuestSubscription } from "./guest-subscription";
import { GuestVerifyDialog } from "./GuestVerifyDialog";
import { useGuestVerify } from "./use-guest-verify";
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
 * The guest review page (#741 12b), read-only, mounted by `mount-guest.tsx` (called from `main.tsx`) on `/d/review` instead of the staff `App`. It talks to `/d/api/links/<linkId>/...` through `guest-api` and to
 * nothing else; `guest-boundary.guard.test.ts` keeps the staff router, auth and API out of this tree. The state is in memory and the URL never changes after the fragment scrub:
 * boot (exchange the token handed in as a prop, or resume the session on a reload) -> passcode | limited | unreachable | unavailable | list -> video(index). A single-Video link skips the list.
 * A 404 or a lost 401 is `unavailable` (no oracle); a network error or 5xx is `unreachable`, a calm retry of the step that failed.
 */
export function GuestApp({ token: initialToken, initialVideoId = null }: { token: string | null; initialVideoId?: string | null }) {
  const [screen, setScreen] = useState<Screen>({ name: "boot" });
  const [session, setSession] = useState<GuestSessionResponse | null>(null);
  const [videos, setVideos] = useState<GuestVideoDto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // The latest list and screen for async completions; `commitVideos` is the only writer of the list, so the ref is never behind a queued update.
  const videosRef = useRef<GuestVideoDto[]>([]);
  const screenRef = useRef<Screen>({ name: "boot" });
  screenRef.current = screen;
  const commitVideos = useCallback((next: GuestVideoDto[]) => { videosRef.current = next; setVideos(next); }, []);
  // A write found the Project archived: notes are read-only for the rest of this visit.
  const [archived, setArchived] = useState(false);
  // Owns the pending writes for the life of the link's session, so leaving the video screen mid-write and coming back cannot send the same note twice.
  const [writer] = useState(createGuestWriter);
  // Owns the inline reply and reply-edit drafts for the link, so closing the phone drawer or re-verifying (which unmount the notes list) keeps what the guest typed.
  const [drafts] = useState(createGuestDrafts);
  // Owns the email-updates switch's choice for the link, so a toggle pending while the phone drawer closes is neither lost nor sent twice.
  const [subscription] = useState(createGuestSubscription);
  // A fresh session body (boot, verify) is newer than the guest's last local choice.
  useEffect(() => { subscription.reseed(); }, [session, subscription]);
  const api = useMemo<GuestApi | null>(() => { const id = readLinkId(); return id === null ? null : createGuestApi(id); }, []);
  // The token lives here once the fragment is scrubbed, so a wrong passcode can retry. Never in the URL, storage or a log.
  const token = useRef<string | null>(initialToken);
  const started = useRef(false);
  // Whether this link has asked for a passcode: an initial rate limit on a link that has not is a token-only retry, not a passcode form.
  const asked = useRef(false);
  // The step that failed transiently; the Try again button repeats it.
  const retry = useRef<() => void>(() => undefined);

  const unavailable = useCallback(() => { setScreen({ name: "unavailable" }); }, []);
  // The one verify dialog for the page and its one continuation slot: Download all, a decision and the single Download all all ask it, so two of them can never each open their own.
  const { verify, dialog: verifyDialog } = useGuestVerify(setSession, unavailable);
  // The film a Delivery page's "Review & feedback" link names (#847); consumed by the first `enter`.
  const wantedVideo = useRef<string | null>(initialVideoId);

  const fail = useCallback((step: () => void) => {
    retry.current = () => { setScreen({ name: "boot" }); step(); };
    setScreen({ name: "unreachable" });
  }, []);

  const enter = useCallback(async (opened: GuestApi, next: GuestSessionResponse) => {
    setSession(next);
    const list = await opened.videos();
    if (list.kind === "gone") { setScreen({ name: "unavailable" }); return; }
    if (list.kind === "transient") { fail(() => { void enter(opened, next); }); return; }
    commitVideos(list.value);
    const wanted = wantedVideo.current;
    wantedVideo.current = null;
    if (wanted !== null) {
      const index = list.value.findIndex((video) => video.id === wanted);
      if (index >= 0) {
        // The video screen opens a film on its newest granted Version. An unverified guest gets the existing verify dialog, once.
        setScreen({ name: "video", index });
        if (!next.verified) verify.request();
        return;
      }
      setNotice("That video is no longer available on this link. Here is what is.");
    }
    setScreen(list.value.length === 1 ? { name: "video", index: 0 } : { name: "list" });
  }, [fail, commitVideos, verify]);

  const exchange = useCallback(async (opened: GuestApi, tokenValue: string, passcode?: string) => {
    const result = await opened.exchange(tokenValue, passcode);
    if (result.ok) { token.current = null; await enter(opened, result.session); return; }
    if (result.reason === "passcode_required") { asked.current = true; setScreen({ name: "passcode", error: null, retryAfterSeconds: null, pending: false }); }
    else if (result.reason === "passcode_incorrect") { asked.current = true; setScreen({ name: "passcode", error: "That passcode isn't right. Check it and try again.", retryAfterSeconds: null, pending: false }); }
    else if (result.reason === "invalid_input") setScreen({ name: "passcode", error: "That passcode isn't valid. Check it and try again.", retryAfterSeconds: null, pending: false });
    else if (result.reason === "limited") {
      if (asked.current || passcode !== undefined) setScreen({ name: "passcode", error: null, retryAfterSeconds: result.retryAfterSeconds, pending: false });
      else { retry.current = () => { setScreen({ name: "boot" }); void exchange(opened, tokenValue); }; setScreen({ name: "limited", retryAfterSeconds: result.retryAfterSeconds }); }
    }
    else if (result.reason === "unreachable") fail(() => { void exchange(opened, tokenValue, passcode); });
    else setScreen({ name: "unavailable" });
  }, [enter, fail]);

  const resume = useCallback(async (opened: GuestApi, exchangeIfGone?: string) => {
    const existing = await opened.session();
    if (existing.kind === "gone") { if (exchangeIfGone !== undefined) await exchange(opened, exchangeIfGone); else setScreen({ name: "unavailable" }); }
    else if (existing.kind === "transient") fail(() => { void resume(opened, exchangeIfGone); });
    else { if (exchangeIfGone !== undefined) token.current = null; await enter(opened, existing.value); }
  }, [enter, exchange, fail]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // `main.tsx` already scrubbed the fragment and passed the token in; this page never reads the address.
    if (api === null) { setScreen({ name: "unavailable" }); return; }
    // Resume first whenever there is a token: the visitor may already hold this link's session (a verified Delivery guest for up to 400 days), and an exchange would mint an unverified one over it.
    // If the session is gone, `resume` falls back to the exchange, passcode flow included.
    if (token.current !== null) { void resume(api, token.current); return; }
    void resume(api);
  }, [api, resume]);

  const submitPasscode = (passcode: string) => {
    if (api === null || token.current === null) { setScreen({ name: "unavailable" }); return; }
    setScreen((current) => (current.name === "passcode" ? { ...current, pending: true } : current));
    void exchange(api, token.current, passcode);
  };
  // Staff took the displayed Video or Version off the link while it was open: show what is still granted, calmly, or nothing if nothing is.
  const grantsChanged = useCallback((fresh: GuestVideoDto[]) => {
    if (fresh.length === 0) { setScreen({ name: "unavailable" }); return; }
    commitVideos(fresh);
    setNotice("That video was updated by the studio. Here is what's available now.");
    setScreen(fresh.length === 1 ? { name: "video", index: 0 } : { name: "list" });
  }, [commitVideos]);

  // A decision lands on the Version it was sent for, by id: whichever Version the guest is looking at now is untouched.
  // A response older than what the page already holds (a refresh showed a newer revision first) is dropped: revisions only move forward.
  const decided = useCallback((assetId: string, decision: GuestDecision) => {
    commitVideos(videosRef.current.map((video) => (video.versions.some((version) => version.assetId === assetId)
      ? { ...video, versions: video.versions.map((version) => (version.assetId === assetId && decision.revision >= (version.decision?.revision ?? 0) ? { ...version, decision } : version)) } : video)));
  }, [commitVideos]);
  // The Version the video screen shows now, published by that screen. Read at apply time, never captured when a request starts.
  const shownVersion = useRef<string | null>(null);
  const onShownVersion = useCallback((assetId: string | null) => { shownVersion.current = assetId; }, []);
  // A decision that may or may not have landed: read the list again. Only the newest re-read applies. The fresh list is authoritative for which Videos and Versions exist and their delivery fields; a local decision
  // survives only where its revision is newer than the fresh one's. The screen is then reconciled against the screen as it is when the answer arrives.
  const rereadSeq = useRef(0);
  const resyncDelivery = useCallback(() => {
    if (api === null) return;
    rereadSeq.current += 1;
    const mine = rereadSeq.current;
    void api.videos().then((fresh) => {
      if (rereadSeq.current !== mine) return;
      if (fresh.kind === "gone") { setScreen({ name: "unavailable" }); return; }
      if (fresh.kind !== "ok") return;
      if (fresh.value.length === 0) { setScreen({ name: "unavailable" }); return; }
      const local = new Map(videosRef.current.flatMap((video) => video.versions).map((version) => [version.assetId, version] as const));
      const merged = fresh.value.map((video) => ({ ...video, versions: video.versions.map((version) => {
        const kept = local.get(version.assetId)?.decision;
        return kept && kept.revision > (version.decision?.revision ?? 0) ? { ...version, decision: kept } : version;
      }) }));
      const now = screenRef.current;
      if (now.name !== "list" && now.name !== "video") return;
      const onScreen = now.name === "video" ? videosRef.current[now.index] : undefined;
      const index = onScreen ? merged.findIndex((video) => video.id === onScreen.id) : -1;
      if (now.name === "video" && (index < 0 || (shownVersion.current !== null && !merged[index]!.versions.some((version) => version.assetId === shownVersion.current)))) { grantsChanged(merged); return; }
      commitVideos(merged);
      if (now.name === "video") setScreen({ name: "video", index });
    });
  }, [api, commitVideos, grantsChanged]);
  if (api === null || screen.name === "unavailable") return <UnavailableScreen />;
  if (screen.name === "unreachable") return <UnreachableScreen onRetry={() => { retry.current(); }} />;
  if (screen.name === "limited") return <LimitedScreen retryAfterSeconds={screen.retryAfterSeconds} onRetry={() => { retry.current(); }} />;
  if (screen.name === "boot") return <main className="min-h-dvh bg-background" aria-busy="true" />;
  if (screen.name === "passcode") return <PasscodeScreen error={screen.error} retryAfterSeconds={screen.retryAfterSeconds} pending={screen.pending} onSubmit={submitPasscode} />;
  if (session === null) return <UnavailableScreen />;
  // Invariant: the video screen never renders without its Video. Reconciling keeps the index valid; this is the net under it.
  if (screen.name === "video" && videos[screen.index] === undefined) return <UnavailableScreen />;
  const shown = screen.name === "list"
    ? <VideoListScreen api={api} title={session?.link.label ?? null} videos={videos} session={session} onSession={setSession} verify={verify} onOpen={(index) => { setNotice(null); setScreen({ name: "video", index }); }} onUnavailable={unavailable} />
    : <GuestVideoScreen api={api} verify={verify} writer={writer} drafts={drafts} subscription={subscription} session={session} onSession={setSession} archived={archived} onArchived={() => { setArchived(true); }} videos={videos} index={screen.index} onIndex={(index) => { setScreen({ name: "video", index }); }} onBack={videos.length > 1 ? () => { setNotice(null); setScreen({ name: "list" }); } : null} onUnavailable={unavailable} onGrantsChanged={grantsChanged} onDecided={decided} onResyncDelivery={resyncDelivery} onShownVersion={onShownVersion} />;
  return <>{archived && <p role="status" data-testid="guest-archived-notice" className="m-0 bg-card px-[var(--space-5)] py-[var(--space-3)] text-center text-card-foreground [font:var(--type-label)]">This project was archived, so notes are read-only.</p>}{notice !== null && <p role="status" data-testid="guest-notice" className="m-0 bg-card px-[var(--space-5)] py-[var(--space-3)] text-center text-card-foreground [font:var(--type-label)]">{notice}</p>}{shown}<GuestVerifyDialog api={api} {...verifyDialog} /></>;
}
