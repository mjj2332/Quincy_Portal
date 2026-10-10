import { useEffect, useState, type FormEvent } from "react";
import type { GuestVideoDto } from "@quincy/shared";
import { LazyImage } from "../components/LazyImage";
import { Badge } from "../components/reui/badge";
import { Button } from "../components/reui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "../components/reui/field";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "../components/reui/frame";
import { Input } from "../components/reui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "../components/reui/item";
import { EmptyState } from "../components/quincy/EmptyState";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";

/** The one calm message for every no-access outcome (unknown, expired, revoked, out of pilot, a lost session): it gives no oracle. */
export function UnavailableScreen() {
  return <main className="flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]">
    <EmptyState data-testid="guest-unavailable" title="This link isn't available.">Open the link from your email again, or ask the studio for a new one.</EmptyState>
  </main>;
}

/** The passcode step. The token stays in the caller's memory, so a wrong passcode retries without the fragment. `retryAfterSeconds` starts a countdown that disables the form. */
export function PasscodeScreen({ error, retryAfterSeconds, pending, onSubmit }: { error: string | null; retryAfterSeconds: number | null; pending: boolean; onSubmit: (passcode: string) => void }) {
  const [value, setValue] = useState("");
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (retryAfterSeconds !== null) { setUntil(Date.now() + retryAfterSeconds * 1000); setNow(Date.now()); } }, [retryAfterSeconds, error]);
  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => { const current = Date.now(); setNow(current); if (current >= until) setUntil(null); }, 1000);
    return () => { clearInterval(timer); };
  }, [until]);
  const secondsLeft = until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
  const submit = (event: FormEvent) => { event.preventDefault(); if (value !== "" && secondsLeft === 0 && !pending) onSubmit(value); };
  return <main className="flex min-h-dvh items-center justify-center bg-background p-[var(--space-4)]">
    <Frame data-testid="guest-passcode" className="w-full max-w-sm">
      <FrameHeader><FrameTitle>Enter the passcode</FrameTitle><FrameDescription>This review link is protected. The studio will have sent you the passcode separately.</FrameDescription></FrameHeader>
      <FramePanel>
        <form onSubmit={submit} noValidate>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="guest-passcode-input">Passcode</FieldLabel>
              <Input id="guest-passcode-input" type="password" autoComplete="off" value={value} className={TOUCH} onChange={(event) => { setValue(event.target.value); }} />
              <FieldError>{secondsLeft > 0 ? `Too many attempts. Try again in ${secondsLeft} ${secondsLeft === 1 ? "second" : "seconds"}.` : error}</FieldError>
            </Field>
            <Button type="submit" className={TOUCH} disabled={value === "" || secondsLeft > 0 || pending}>Continue</Button>
          </FieldGroup>
        </form>
      </FramePanel>
    </Frame>
  </main>;
}

const noteCount = (count: number) => (count === 0 ? "No notes" : `${count} ${count === 1 ? "note" : "notes"}`);

/**
 * The Video list (69a). Each row: poster, title, the latest granted Version, a premium badge and the public note count. `guest-row-slot` is where the decision and released state land
 * with 14; it is empty until then.
 */
export function VideoListScreen({ title, videos, onOpen }: { title: string | null; videos: readonly GuestVideoDto[]; onOpen: (index: number) => void }) {
  return <main data-testid="guest-list" className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-[var(--space-4)] bg-background px-[var(--space-4)] py-[var(--space-6)] text-foreground">
    <h1 className="m-0 text-[length:var(--text-xl)] leading-[var(--leading-snug)] font-normal font-[family-name:var(--font-display)]">{title ?? "Review"}</h1>
    {videos.length === 0
      ? <EmptyState title="Nothing to review yet.">The studio hasn't shared any videos on this link.</EmptyState>
      : <Frame><FramePanel><ItemGroup className="gap-[var(--space-2)]">
        {videos.map((video, index) => {
          const latest = video.versions[0]!;
          return <Item key={video.id} variant="outline" data-testid="guest-video-row">
            {latest.posterUrl !== null && <ItemMedia variant="image"><LazyImage src={latest.posterUrl} alt={`${video.title} poster`} /></ItemMedia>}
            <ItemContent>
              <ItemTitle><span data-testid="guest-row-title">{video.title}</span>{video.premium && <Badge variant="secondary" size="xs">Premium</Badge>}</ItemTitle>
              <ItemDescription>{`Version ${latest.version} · ${noteCount(latest.publicNoteCount)}`}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <span data-testid="guest-row-slot" />
              <Button type="button" variant="outline" aria-label={`Open ${video.title}`} className={TOUCH} onClick={() => { onOpen(index); }}>Open</Button>
            </ItemActions>
          </Item>;
        })}
      </ItemGroup></FramePanel></Frame>}
  </main>;
}
