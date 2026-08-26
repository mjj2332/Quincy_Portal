import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { safeStaffDestination } from "./router";

const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost" : window.location.origin,
  basePath: "/api/auth",
  plugins: [adminClient()],
});

export const useSession = authClient.useSession;

const returnPathKey = "quincy:sign-in-return-path";
type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type SocialClient = { signIn: { social(input: { provider: "google"; callbackURL: string }): Promise<{ error?: { message?: string | null } | null }> } };

function storage(): SessionStorageLike | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** Returns null when there is nothing genuine to restore (no sign-in flow just completed) —
 *  callers must not redirect in that case. A stored-but-invalid candidate still falls back
 *  to "/", since a real sign-in return did just happen. */
export function consumeSignInDestinationFrom(saved: SessionStorageLike | null): string | null {
  if (!saved) return null;
  let candidate: string | null = null;
  try { candidate = saved.getItem(returnPathKey); } catch { /* Storage can be disabled. */ }
  try { saved.removeItem(returnPathKey); } catch { /* A failed cleanup still falls back safely. */ }
  if (candidate === null) return null;
  return safeStaffDestination(candidate) ?? "/";
}

export function consumeSignInDestination(): string | null {
  return consumeSignInDestinationFrom(storage());
}

export async function beginSignIn(pathname: string, client: SocialClient, saved: SessionStorageLike | null): Promise<void> {
  const callbackURL = safeStaffDestination(pathname) ?? "/";
  try { saved?.setItem(returnPathKey, callbackURL); } catch { /* Better Auth callback still carries the destination. */ }

  let result: { error?: { message?: string | null } | null };
  try {
    // Better Auth retains ownership of OAuth state and PKCE; no caller state is added here.
    result = await client.signIn.social({ provider: "google", callbackURL });
  } catch (error) {
    try { saved?.removeItem(returnPathKey); } catch { /* Ignore unavailable storage. */ }
    throw error;
  }

  if (result.error) {
    try { saved?.removeItem(returnPathKey); } catch { /* Ignore unavailable storage. */ }
    throw new Error(result.error.message ?? "Google sign-in could not be started.");
  }
}

export async function signIn(pathname: string): Promise<void> {
  return beginSignIn(pathname, authClient, storage());
}

export async function signOut(): Promise<void> {
  const result = await authClient.signOut();

  if (result.error) {
    throw new Error(result.error.message ?? "Sign-out could not be completed.");
  }
}

export async function impersonateUser(userId: string): Promise<void> {
  const result = await authClient.admin.impersonateUser({ userId });
  if (result.error) throw new Error(result.error.message ?? "User impersonation could not be started.");
}

export async function stopImpersonating(): Promise<void> {
  const result = await authClient.admin.stopImpersonating();
  if (result.error) throw new Error(result.error.message ?? "Could not automatically exit.");
}
