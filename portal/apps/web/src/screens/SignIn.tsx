import { useState } from "react";
import { signIn } from "../lib/auth";
import { Eyebrow } from "@/components/quincy/Eyebrow";
import { Button } from "@/components/reui/button";
import { Notice } from "@/components/quincy/Notice";

export function SignIn({ pathname }: { pathname: string }) {
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSignIn() {
    setError(undefined);
    setIsSubmitting(true);

    try {
      await signIn(pathname);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "You could not sign in. Please try again or contact your administrator.");
      setIsSubmitting(false);
    }
  }

  return (
    <main className="signin min-h-screen grid place-items-center p-[var(--space-6)] bg-background relative overflow-hidden">
      <section
        className="relative w-[min(100%,430px)] p-[var(--space-8)] max-[721px]:p-[var(--space-6)] bg-card border-solid border-[length:var(--border-width-hair)] border-border"
        aria-labelledby="sign-in-title"
      >
        <img
          className="w-[min(238px,100%)] h-auto mb-[var(--space-8)]"
          src="/brand/quincy-wordmark-black.png"
          alt="Quincy Productions"
        />
        <Eyebrow className="block mb-[var(--space-3)]">Portal access</Eyebrow>
        {/* The `!` on every non-zero margin below is required, not decorative: `tokens/base.css` is
            imported outside any `@layer`, so its `h1, h2, h3, h4 { margin: 0 }` and `p { margin: 0 }`
            beat any margin utility Tailwind emits into `@layer utilities`. (§7 case O) */}
        <h1 id="sign-in-title" className="m-0 !mb-[var(--space-4)] [font:var(--type-h1)] max-[721px]:[font:var(--type-h2)] tracking-[var(--tracking-tight)] text-foreground">Welcome back.</h1>
        <p className="max-w-[32ch] !mb-[var(--space-6)] [font:var(--weight-regular)_var(--text-base)/var(--leading-relaxed)_var(--font-sans)] text-foreground-secondary">Sign in to manage your productions, review work, and keep every project moving.</p>
        {/* No `busy`/`cursor-wait` here: the cva base in components/reui/button.tsx carries
            `disabled:pointer-events-none`, and `disabled` below is exactly `isSubmitting`, so a
            `cursor-wait` class could never render. */}
        <Button className="w-full" type="button" onClick={handleSignIn} disabled={isSubmitting}>
          {isSubmitting ? "Connecting…" : "Continue with Google"}
        </Button>
        {error && <Notice role="alert" className="mt-[var(--space-4)]">{error}</Notice>}
        <p className="!mt-[var(--space-4)] [font:var(--type-eyebrow)] tracking-[var(--tracking-wide)] text-foreground-secondary">Access is provisioned by your administrator.</p>
      </section>
    </main>
  );
}
