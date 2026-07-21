import { useState } from "react";
import { signIn } from "../lib/auth";

export function SignIn() {
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSignIn() {
    setError(undefined);
    setIsSubmitting(true);

    try {
      await signIn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "You could not sign in. Please try again or contact your administrator.");
      setIsSubmitting(false);
    }
  }

  return (
    <main className="signin">
      <section className="signin__panel" aria-labelledby="sign-in-title">
        <img className="signin__wordmark" src="/brand/quincy-wordmark-black.png" alt="Quincy Productions" />
        <div className="ey">Portal access</div>
        <h1 className="signin__title" id="sign-in-title">Welcome back.</h1>
        <p className="signin__copy">Sign in to manage your productions, review work, and keep every project moving.</p>
        <button className="button signin__action" type="button" onClick={handleSignIn} disabled={isSubmitting}>
          <span className="button__google" aria-hidden="true">G</span>
          {isSubmitting ? "Connecting…" : "Continue with Google"}
        </button>
        {error && <div className="notice" role="alert">{error}</div>}
        <p className="signin__note">Access is provisioned by your administrator.</p>
      </section>
    </main>
  );
}
