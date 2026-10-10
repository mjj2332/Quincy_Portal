import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestSessionResponse } from "@quincy/shared";
import type { GuestApi, Read, SendCodeResult, VerifyResult } from "./guest-api";
import { GuestVerifyDialog } from "./GuestVerifyDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: GuestSessionResponse = { link: { label: null, expiresAt: "2026-11-01T00:00:00.000Z", allow: { comments: true, approve: false, download: false, markup: true } }, verified: true, email: "sam@example.com", name: "Sam" };
const UNVERIFIED: GuestSessionResponse = { ...SESSION, verified: false, email: null, name: null };

let sendCode: ReturnType<typeof vi.fn<(email: string) => Promise<SendCodeResult>>>;
let verifyCode: ReturnType<typeof vi.fn<(code: string, name: string) => Promise<VerifyResult>>>;
let session: ReturnType<typeof vi.fn<() => Promise<Read<GuestSessionResponse>>>>;
let onVerified: ReturnType<typeof vi.fn<(next: GuestSessionResponse) => void>>;
let onGone: ReturnType<typeof vi.fn<() => void>>;
let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
let root: Root | null = null;
let host: HTMLElement;

const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); }); };
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const setValue = async (element: HTMLElement | null, value: string) => {
  const input = element as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click(); }); await flush(); };
const submit = async (id: string) => { await act(async () => { q(id)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await flush(); };

async function mount() {
  const api = { sendCode, verifyCode, session } as unknown as GuestApi;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<GuestVerifyDialog api={api} open onOpenChange={onOpenChange} onVerified={onVerified} onGone={onGone} />); });
  await flush();
}
/** Re-renders the mounted dialog open or closed, as its parent would after onOpenChange. */
async function setOpen(open: boolean) {
  const api = { sendCode, verifyCode, session } as unknown as GuestApi;
  await act(async () => { root!.render(<GuestVerifyDialog api={api} open={open} onOpenChange={onOpenChange} onVerified={onVerified} onGone={onGone} />); });
  await flush();
}
async function reachCodeStep() {
  await setValue(q("guest-verify-email"), "  Sam@Example.com ");
  await setValue(q("guest-verify-name"), " Sam ");
  await submit("guest-verify-identity-form");
}
const typeCode = async (code: string) => { await setValue(q("guest-verify-code"), code); await flush(); };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  sendCode = vi.fn(async () => ({ ok: true, resendAfterSeconds: 60 }) as SendCodeResult);
  verifyCode = vi.fn(async () => ({ ok: true, session: SESSION }) as VerifyResult);
  session = vi.fn(async () => ({ kind: "ok", value: UNVERIFIED }) as Read<GuestSessionResponse>);
  onVerified = vi.fn(); onGone = vi.fn(); onOpenChange = vi.fn();
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host?.remove(); vi.useRealTimers();
});

describe("GuestVerifyDialog: identity step", () => {
  it("asks for an email and a name, and sends nothing for an address that is not one", async () => {
    await mount();
    expect(q("guest-verify-email")).not.toBeNull();
    expect(q("guest-verify-name")).not.toBeNull();
    await setValue(q("guest-verify-email"), "not-an-email");
    await setValue(q("guest-verify-name"), "Sam");
    await submit("guest-verify-identity-form");
    expect(sendCode).not.toHaveBeenCalled();
    expect(q("guest-verify-error")?.textContent).toMatch(/email/i);
  });
  it("needs a name too", async () => {
    await mount();
    await setValue(q("guest-verify-email"), "sam@example.com");
    await setValue(q("guest-verify-name"), "   ");
    await submit("guest-verify-identity-form");
    expect(sendCode).not.toHaveBeenCalled();
    expect(q("guest-verify-error")?.textContent).toMatch(/name/i);
  });
  it("sends the trimmed address and moves to the code step with the resend countdown running", async () => {
    await mount();
    await reachCodeStep();
    expect(sendCode).toHaveBeenCalledExactlyOnceWith("Sam@Example.com");
    expect(q("guest-verify-code")).not.toBeNull();
    expect(q("guest-verify-code-form")?.textContent).toContain("Sam@Example.com");
    const resend = q("guest-verify-resend") as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toContain("60");
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(q("guest-verify-resend")!.textContent).toContain("30");
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect((q("guest-verify-resend") as HTMLButtonElement).disabled).toBe(false);
    await click(q("guest-verify-resend"));
    expect(sendCode).toHaveBeenCalledTimes(2);
    expect((q("guest-verify-resend") as HTMLButtonElement).disabled).toBe(true);
  });
  it("says when the send is rate limited and how long to wait", async () => {
    sendCode.mockResolvedValueOnce({ ok: false, reason: "limited", retryAfterSeconds: 90 });
    await mount();
    await reachCodeStep();
    expect(q("guest-verify-code")).toBeNull();
    expect(q("guest-verify-error")?.textContent).toMatch(/90 seconds/);
  });
  it("hands a stub to the unavailable path and says so for an archived Project or a dropped connection", async () => {
    sendCode.mockResolvedValueOnce({ ok: false, reason: "gone" });
    await mount();
    await reachCodeStep();
    expect(onGone).toHaveBeenCalledOnce();
    sendCode.mockResolvedValueOnce({ ok: false, reason: "archived" });
    await submit("guest-verify-identity-form");
    expect(q("guest-verify-error")?.textContent).toMatch(/archived/i);
    sendCode.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    await submit("guest-verify-identity-form");
    expect(q("guest-verify-error")?.textContent).toMatch(/couldn.t reach/i);
  });
});

describe("GuestVerifyDialog: code step", () => {
  it("verifies once six digits are in, with the name as typed, and hands the new session on", async () => {
    await mount();
    await reachCodeStep();
    await typeCode("12345");
    expect(verifyCode).not.toHaveBeenCalled();
    await typeCode("123456");
    expect(verifyCode).toHaveBeenCalledExactlyOnceWith("123456", "Sam");
    expect(onVerified).toHaveBeenCalledExactlyOnceWith(SESSION);
  });
  it("keeps the dialog and says how many tries are left on a wrong code, and clears the code", async () => {
    verifyCode.mockResolvedValueOnce({ ok: false, reason: "code_incorrect", attemptsLeft: 2 });
    await mount();
    await reachCodeStep();
    await typeCode("000000");
    expect(onVerified).not.toHaveBeenCalled();
    expect(q("guest-verify-error")?.textContent).toMatch(/isn.t right/i);
    expect(q("guest-verify-error")?.textContent).toMatch(/2 tries left/);
    expect((q("guest-verify-code") as HTMLInputElement).value).toBe("");
  });
  it("on an expired code first checks whether the session became verified (a double submit), else asks for a new code", async () => {
    verifyCode.mockResolvedValueOnce({ ok: false, reason: "code_expired" });
    session.mockResolvedValueOnce({ kind: "ok", value: SESSION });
    await mount();
    await reachCodeStep();
    await typeCode("111111");
    expect(session).toHaveBeenCalledOnce();
    expect(onVerified).toHaveBeenCalledExactlyOnceWith(SESSION);

    onVerified.mockClear();
    verifyCode.mockResolvedValueOnce({ ok: false, reason: "code_expired" });
    await typeCode("");
    await typeCode("222222");
    expect(onVerified).not.toHaveBeenCalled();
    expect(q("guest-verify-error")?.textContent).toMatch(/expired|used/i);
  });
  it("a code send answered already_verified reads the session and closes as verified", async () => {
    sendCode.mockResolvedValueOnce({ ok: false, reason: "already_verified" });
    session.mockResolvedValueOnce({ kind: "ok", value: SESSION });
    await mount();
    await reachCodeStep();
    expect(session).toHaveBeenCalledTimes(1);
    expect(onVerified).toHaveBeenCalledWith(SESSION);
    expect(onGone).not.toHaveBeenCalled();
  });
  it("treats already_verified the same way", async () => {
    verifyCode.mockResolvedValueOnce({ ok: false, reason: "already_verified" });
    session.mockResolvedValueOnce({ kind: "ok", value: SESSION });
    await mount();
    await reachCodeStep();
    await typeCode("111111");
    expect(onVerified).toHaveBeenCalledExactlyOnceWith(SESSION);
  });
  it("shows a rate limit with its time, an archived Project, and a dropped connection (keeping the code step)", async () => {
    await mount();
    await reachCodeStep();
    verifyCode.mockResolvedValueOnce({ ok: false, reason: "limited", retryAfterSeconds: 300 });
    await typeCode("111111");
    expect(q("guest-verify-error")?.textContent).toMatch(/300 seconds|5 minutes/);
    // The code stays in the field after these, so the Verify button repeats the attempt.
    verifyCode.mockResolvedValueOnce({ ok: false, reason: "archived" });
    await click(q("guest-verify-submit"));
    expect(q("guest-verify-error")?.textContent).toMatch(/archived/i);
    verifyCode.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    await click(q("guest-verify-submit"));
    expect(verifyCode).toHaveBeenLastCalledWith("111111", "Sam");
    expect(q("guest-verify-error")?.textContent).toMatch(/couldn.t reach/i);
    expect(q("guest-verify-code")).not.toBeNull();
  });
  it("hands a stub to the unavailable path", async () => {
    verifyCode.mockResolvedValueOnce({ ok: false, reason: "gone" });
    await mount();
    await reachCodeStep();
    await typeCode("111111");
    expect(onGone).toHaveBeenCalledOnce();
  });
  it("lets the guest go back to change the address, and cancel", async () => {
    await mount();
    await reachCodeStep();
    await click(q("guest-verify-change-email"));
    expect(q("guest-verify-email")).not.toBeNull();
    expect((q("guest-verify-email") as HTMLInputElement).value).toBe("Sam@Example.com");
    await click(q("guest-verify-cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("GuestVerifyDialog: in-flight requests (#741 13c round 1)", () => {
  it("freezes the address while the code request is out, and the code step and Resend use the address that was sent", async () => {
    let finish!: (result: SendCodeResult) => void;
    sendCode.mockImplementationOnce(() => new Promise<SendCodeResult>((resolve) => { finish = resolve; }));
    await mount();
    await reachCodeStep();
    expect((q("guest-verify-email") as HTMLInputElement).disabled).toBe(true);
    await act(async () => { finish({ ok: true, resendAfterSeconds: 60 }); });
    await flush();
    expect(q("guest-verify-code-form")?.textContent).toContain("Sam@Example.com");
    await act(async () => { vi.advanceTimersByTime(61_000); });
    await click(q("guest-verify-resend"));
    expect(sendCode).toHaveBeenLastCalledWith("Sam@Example.com");
  });
  it("lets a verify that finishes after Cancel and a reopen do nothing to the new dialog", async () => {
    let finish!: (result: VerifyResult) => void;
    verifyCode.mockImplementationOnce(() => new Promise<VerifyResult>((resolve) => { finish = resolve; }));
    await mount();
    await reachCodeStep();
    await typeCode("111111");
    await click(q("guest-verify-cancel"));
    await setOpen(false);
    await setOpen(true);
    await act(async () => { finish({ ok: true, session: SESSION }); });
    await flush();
    expect(onVerified).not.toHaveBeenCalled();
    expect(q("guest-verify-identity-form")).not.toBeNull();
  });
  it("lets a code request that finishes after Cancel and a reopen leave the new dialog on its first step", async () => {
    let finish!: (result: SendCodeResult) => void;
    sendCode.mockImplementationOnce(() => new Promise<SendCodeResult>((resolve) => { finish = resolve; }));
    await mount();
    await reachCodeStep();
    await click(q("guest-verify-cancel"));
    await setOpen(false);
    await setOpen(true);
    await act(async () => { finish({ ok: false, reason: "gone" }); });
    await flush();
    expect(onGone).not.toHaveBeenCalled();
  });
});
