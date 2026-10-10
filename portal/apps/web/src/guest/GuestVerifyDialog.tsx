import { useState, type FormEvent } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { GUEST_NAME_MAX, guestEmailCodeInputSchema, type GuestSessionResponse } from "@quincy/shared";
import { Button } from "../components/reui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/reui/dialog";
import { Field, FieldGroup, FieldLabel } from "../components/reui/field";
import { Input } from "../components/reui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "../components/reui/input-otp";
import type { GuestApi } from "./guest-api";
import { useCountdown } from "./GuestScreens";

const TOUCH = "pointer-coarse:min-h-11 max-[721px]:min-h-11";
const ERROR = "m-0 text-destructive [font:var(--type-body-sm)]";

/** "90 seconds" up to 90, else whole minutes: a rate limit's wait, said the way the guest will count it. */
export const waitPhrase = (seconds: number): string => (seconds <= 90 ? `${seconds} ${seconds === 1 ? "second" : "seconds"}` : `${Math.ceil(seconds / 60)} minutes`);

type Step = "identity" | "code";

/**
 * The email-code flow (#741 13c): the guest gives an email and a display name, gets a six-digit code, and enters it. The 200 of the verify route IS the new session (its cookie rotated server
 * side), so `onVerified` receives it and nothing is refetched, except when the code is reported expired or the session already verified: a double submit has two correct codes racing, one
 * wins, and the loser must find out by reading the session. State lives in the inner flow, so closing and reopening starts clean.
 */
export function GuestVerifyDialog({ api, open, onOpenChange, onVerified, onGone }: {
  api: GuestApi;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified: (session: GuestSessionResponse) => void;
  /** A stub answer: the link is gone, the page's unavailable path. */
  onGone: () => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent data-testid="guest-verify-dialog" showCloseButton={false} className="max-w-sm">
      <VerifyFlow api={api} onCancel={() => { onOpenChange(false); }} onVerified={onVerified} onGone={onGone} />
    </DialogContent>
  </Dialog>;
}

function VerifyFlow({ api, onCancel, onVerified, onGone }: { api: GuestApi; onCancel: () => void; onVerified: (session: GuestSessionResponse) => void; onGone: () => void }) {
  const [step, setStep] = useState<Step>("identity");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [wait, setWait] = useState<{ seconds: number; key: number } | null>(null);
  const secondsLeft = useCountdown(wait?.seconds ?? null, wait?.key);
  const startWait = (seconds: number) => { setWait((current) => ({ seconds, key: (current?.key ?? 0) + 1 })); };

  /** Sends a code to the typed address. Returns true when the guest should be on the code step. */
  const send = async (address: string): Promise<boolean> => {
    setPending(true); setError(null);
    const result = await api.sendCode(address);
    setPending(false);
    if (result.ok) { startWait(result.resendAfterSeconds); return true; }
    if (result.reason === "gone") onGone();
    else if (result.reason === "limited") { startWait(result.retryAfterSeconds); setError(`Too many codes requested. Try again in ${waitPhrase(result.retryAfterSeconds)}.`); }
    else if (result.reason === "archived") setError("This project was archived, so notes are read-only.");
    else if (result.reason === "invalid") setError("Check the email address and try again.");
    else setError("Couldn't reach Quincy. Check your connection and try again.");
    return false;
  };

  const submitIdentity = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const address = guestEmailCodeInputSchema.safeParse({ email: email.trim() });
    if (!address.success) { setError("Enter a valid email address."); return; }
    const display = name.trim();
    if (display === "" || display.length > GUEST_NAME_MAX || /[\r\n]/.test(display)) { setError(display === "" ? "Enter the name to show on your notes." : `Use a name of up to ${GUEST_NAME_MAX} characters on one line.`); return; }
    if (await send(address.data.email)) setStep("code");
  };

  const resend = async () => {
    if (pending || secondsLeft > 0) return;
    setCode("");
    await send(email.trim());
  };

  const submitCode = async (value: string) => {
    if (pending || value.length !== 6) return;
    setPending(true); setError(null);
    const result = await api.verifyCode(value, name.trim());
    if (result.ok) { setPending(false); onVerified(result.session); return; }
    if (result.reason === "code_incorrect") {
      setCode("");
      setError(result.attemptsLeft > 0 ? `That code isn't right. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try" : "tries"} left.` : "That code isn't right and has no tries left. Send a new code.");
    } else if (result.reason === "code_expired" || result.reason === "already_verified") {
      // Two correct submissions race and one wins: the loser reads the session to find out it is verified.
      const current = await api.session();
      if (current.kind === "ok" && current.value.verified) { setPending(false); onVerified(current.value); return; }
      if (current.kind === "gone") { setPending(false); onGone(); return; }
      setCode("");
      setError(result.reason === "code_expired" ? "That code has expired or been used up. Send a new code." : "This session is already verified with another address. Close this and reload the page.");
    } else if (result.reason === "gone") { setPending(false); onGone(); return; }
    else if (result.reason === "limited") setError(`Too many attempts. Try again in ${waitPhrase(result.retryAfterSeconds)}.`);
    else if (result.reason === "archived") setError("This project was archived, so notes are read-only.");
    else if (result.reason === "invalid") setError("Check the code and name and try again.");
    else setError("Couldn't reach Quincy. Check your connection and try again.");
    setPending(false);
  };

  const errorLine = error === null ? null : <p role="alert" data-testid="guest-verify-error" className={ERROR}>{error}</p>;

  if (step === "identity") {
    return <>
      <DialogHeader>
        <DialogTitle className="[font:var(--type-h3)]">Add a note</DialogTitle>
        <DialogDescription>Enter your email and we'll send a six-digit code. Your name is shown on the notes you add.</DialogDescription>
      </DialogHeader>
      <form data-testid="guest-verify-identity-form" onSubmit={(event) => { void submitIdentity(event); }} noValidate>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="guest-verify-email">Email</FieldLabel>
            <Input id="guest-verify-email" data-testid="guest-verify-email" type="email" autoComplete="email" inputMode="email" value={email} className={TOUCH} onChange={(event) => { setEmail(event.target.value); }} />
          </Field>
          <Field>
            <FieldLabel htmlFor="guest-verify-name">Your name</FieldLabel>
            <Input id="guest-verify-name" data-testid="guest-verify-name" autoComplete="name" maxLength={GUEST_NAME_MAX} value={name} className={TOUCH} onChange={(event) => { setName(event.target.value); }} />
          </Field>
          {errorLine}
          <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
            <Button type="button" variant="ghost" data-testid="guest-verify-cancel" className={TOUCH} onClick={onCancel}>Cancel</Button>
            <Button type="submit" data-testid="guest-verify-send" className={TOUCH} disabled={pending}>Send code</Button>
          </div>
        </FieldGroup>
      </form>
    </>;
  }

  return <>
    <DialogHeader>
      <DialogTitle className="[font:var(--type-h3)]">Enter your code</DialogTitle>
      <DialogDescription>We sent a six-digit code to the address below. It works for 10 minutes.</DialogDescription>
    </DialogHeader>
    <form data-testid="guest-verify-code-form" onSubmit={(event) => { event.preventDefault(); void submitCode(code); }} noValidate>
      <FieldGroup>
        <p className="m-0 flex flex-wrap items-center gap-x-[var(--space-2)] text-foreground-secondary [font:var(--type-body-sm)]">
          <span className="[overflow-wrap:anywhere]">{email.trim()}</span>
          <Button type="button" variant="link" size="sm" data-testid="guest-verify-change-email" className={TOUCH} onClick={() => { setStep("identity"); setCode(""); setError(null); }}>Change</Button>
        </p>
        <Field>
          <FieldLabel htmlFor="guest-verify-code">Code</FieldLabel>
          <InputOTP id="guest-verify-code" data-testid="guest-verify-code" aria-label="6-digit code" maxLength={6} pattern={REGEXP_ONLY_DIGITS} inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} disabled={pending}
            onChange={setCode} onComplete={(value) => { void submitCode(value); }}>
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((index) => <InputOTPSlot key={index} index={index} aria-invalid={error !== null} />)}
            </InputOTPGroup>
          </InputOTP>
        </Field>
        {errorLine}
        <div className="flex flex-wrap items-center justify-between gap-[var(--space-2)]">
          <Button type="button" variant="outline" data-testid="guest-verify-resend" className={TOUCH} disabled={pending || secondsLeft > 0} onClick={() => { void resend(); }}>{secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend code"}</Button>
          <div className="flex gap-[var(--space-2)]">
            <Button type="button" variant="ghost" data-testid="guest-verify-cancel" className={TOUCH} onClick={onCancel}>Cancel</Button>
            <Button type="submit" data-testid="guest-verify-submit" className={TOUCH} disabled={pending || code.length !== 6}>Verify</Button>
          </div>
        </div>
      </FieldGroup>
    </form>
  </>;
}
