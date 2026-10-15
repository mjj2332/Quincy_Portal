import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { GUEST_PASSCODE_MAX, type GuestSessionResponse, type GuestVideoDto } from "@quincy/shared";
import { Button } from "../components/reui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "../components/reui/field";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "../components/reui/frame";
import { Input } from "../components/reui/input";
import { EmptyState } from "../components/quincy/EmptyState";
import { VideoTile } from "../components/quincy/VideoTile";
import type { GuestApi } from "./guest-api";
import { GuestDownloadAll } from "./GuestDownloadAll";
import type { GuestVerify } from "./use-guest-verify";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/** The one calm message for every no-access outcome (unknown, expired, revoked, out of pilot, a lost session): it gives no oracle. */
export function UnavailableScreen() {
  return <main className="flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]">
    <EmptyState data-testid="guest-unavailable" title="This link isn't available.">Open the link from your email again, or ask the studio for a new one.</EmptyState>
  </main>;
}

/** After "Not you? Sign out" when this page holds no token to start a fresh session with (it was reloaded after the fragment scrub, #854). The guest chose this, so it says so plainly. */
export function SignedOutScreen() {
  return <main className="flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]">
    <EmptyState data-testid="guest-signed-out" title="You're signed out.">Open the review link again to keep watching.</EmptyState>
  </main>;
}

/** Seconds left on a rate-limit wait: 0 when there is none. `key` restarts it when the same wait arrives again. */
export function useCountdown(retryAfterSeconds: number | null, key: unknown): number {
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (retryAfterSeconds !== null) { setUntil(Date.now() + retryAfterSeconds * 1000); setNow(Date.now()); } }, [retryAfterSeconds, key]);
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => { const current = Date.now(); setNow(current); if (current >= until) setUntil(null); }, 1000);
    return () => { clearInterval(timer); };
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}
const TOO_MANY = "Too many attempts.";
const waitHint = (seconds: number) => `Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
const waitText = (seconds: number) => `${TOO_MANY} ${waitHint(seconds)}`;

/** A network error or a 5xx: it says nothing about the link, so it is calm, leaks nothing, and offers to repeat the step that failed. */
export function UnreachableScreen({ onRetry }: { onRetry: () => void }) {
  return <main className="flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]">
    <EmptyState data-testid="guest-unreachable" title="Couldn't reach Quincy.">
      <p className="m-0 mb-[var(--space-3)]">Check your connection and try again.</p>
      <Button type="button" className={TOUCH} onClick={onRetry}>Try again</Button>
    </EmptyState>
  </main>;
}

/** An exchange rate limit on a link with no passcode: a countdown and a token-only retry. Mount it fresh for each wait. */
export function LimitedScreen({ retryAfterSeconds, onRetry }: { retryAfterSeconds: number; onRetry: () => void }) {
  const secondsLeft = useCountdown(retryAfterSeconds, null);
  return <main className="flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]">
    <EmptyState data-testid="guest-limited" title={secondsLeft > 0 ? TOO_MANY : "You can try again now."}>
      {secondsLeft > 0 && <p className="m-0 mb-[var(--space-3)]">{waitHint(secondsLeft)}</p>}
      <Button type="button" className={TOUCH} disabled={secondsLeft > 0} onClick={onRetry}>Try again</Button>
    </EmptyState>
  </main>;
}

/** The passcode step. The token stays in the caller's memory, so a wrong passcode retries without the fragment. `retryAfterSeconds` starts a countdown that disables the form. */
export function PasscodeScreen({ error, retryAfterSeconds, pending, onSubmit }: { error: string | null; retryAfterSeconds: number | null; pending: boolean; onSubmit: (passcode: string) => void }) {
  const [value, setValue] = useState("");
  const secondsLeft = useCountdown(retryAfterSeconds, error);
  const submit = (event: FormEvent) => { event.preventDefault(); if (value !== "" && secondsLeft === 0 && !pending) onSubmit(value); };
  return <main className="flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]">
    <Frame data-testid="guest-passcode" className="w-full max-w-sm">
      <FrameHeader><FrameTitle data-testid="guest-passcode-title" className="[font:var(--type-h3)]">Enter the passcode</FrameTitle><FrameDescription>This review link is protected. The studio will have sent you the passcode separately.</FrameDescription></FrameHeader>
      <FramePanel>
        <form onSubmit={submit} noValidate>
          <FieldGroup>
            <Field data-invalid={error !== null}>
              <FieldLabel htmlFor="guest-passcode-input">Passcode</FieldLabel>
              <Input id="guest-passcode-input" type="password" autoComplete="off" aria-invalid={error !== null} maxLength={GUEST_PASSCODE_MAX} value={value} className={`${TOUCH} text-foreground`} onChange={(event) => { setValue(event.target.value); }} />
              <FieldError>{secondsLeft > 0 ? waitText(secondsLeft) : error}</FieldError>
            </Field>
            <Button type="submit" className={TOUCH} disabled={value === "" || secondsLeft > 0 || pending}>Continue</Button>
          </FieldGroup>
        </form>
      </FramePanel>
    </Frame>
  </main>;
}

/**
 * The Video list (69a, tiles #884): the staff collection's poster-first tile, with only what a guest may see (D21): the latest granted Version, duration, title, Premium and the open public-note
 * count (`publicNoteCount`, the open public root threads of that Version). No tick, menu, status, decision or Release chip; those stay on the video screen. A tap opens the film. When the link allows
 * downloads and has several Videos, Download all sits beside the title.
 */
export function VideoListScreen({ api, verify, title, videos, session, onSession, onOpen, onUnavailable, identity }: { api: GuestApi; verify: GuestVerify; title: string | null; videos: readonly GuestVideoDto[]; session: GuestSessionResponse; onSession: (next: GuestSessionResponse) => void; onOpen: (index: number) => void; onUnavailable: () => void; /** The "Reviewing as … / Not you? Sign out" row (#854), under the title row. */ identity: ReactNode }) {
  return <main data-testid="guest-list" className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-[var(--space-4)] bg-background px-[var(--space-4)] py-[var(--space-6)] text-foreground">
    <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
      <h1 className="m-0 min-w-0 text-[length:var(--text-xl)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{title ?? "Review"}</h1>
      {videos.length > 1 && <GuestDownloadAll api={api} verify={verify} session={session} onSession={onSession} onUnavailable={onUnavailable} />}
    </div>
    {identity}
    {videos.length === 0
      ? <EmptyState title="Nothing to review yet.">The studio hasn't shared any videos on this link.</EmptyState>
      : <div className="grid gap-[var(--space-4)] [grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr))] max-[721px]:grid-cols-1" data-testid="guest-video-grid">
        {videos.map((video, index) => {
          const latest = video.versions[0]!;
          return <VideoTile
            key={video.id} testId="guest-video-row" openTestId="guest-row-title"
            title={video.title} posterUrl={latest.posterUrl} version={latest.version} durationMs={latest.durationMs} openNotes={latest.publicNoteCount}
            {...(video.premium ? { premium: true } : {})}
            onOpen={() => { onOpen(index); }}
          />;
        })}
      </div>}
  </main>;
}
