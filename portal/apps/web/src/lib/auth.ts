import { createAuthClient } from "better-auth/react";

const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
});

export const useSession = authClient.useSession;

export async function signIn(): Promise<void> {
  const result = await authClient.signIn.social({
    provider: "google",
    callbackURL: "/",
  });

  if (result.error) {
    throw new Error(result.error.message ?? "Google sign-in could not be started.");
  }
}

export async function signOut(): Promise<void> {
  const result = await authClient.signOut();

  if (result.error) {
    throw new Error(result.error.message ?? "Sign-out could not be completed.");
  }
}
