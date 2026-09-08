import { useSession } from "./lib/auth";
import { SignIn } from "./screens/SignIn";
import { ImpersonationBanner } from "./components/ImpersonationBanner";
import { PrincipalFreshnessBoundary } from "./components/PrincipalFreshnessBoundary";
import { StagesProvider } from "./lib/stages";
import { QuincyQueryProvider } from "./lib/query-client";
import { ShellIdentityProvider, StaffRouter, type SessionUser } from "./lib/app-router";

/**
 * `App` owns the authentication boundary; everything routed lives in `lib/app-router.tsx` (#52).
 *
 * The split matters: the impersonation branches below run *before* any router exists, because an
 * invalidated impersonated session must never reach a staff route. `StaffRouter` is the only
 * thing in the application that mounts a `RouterProvider`, which is what keeps `Dashboard`,
 * `Admin`, `ImpersonationBanner` and `PrincipalFreshnessBoundary` renderable standalone by their
 * own DOM tests — they navigate through `locationStore()`, never through router hooks.
 */
export default function App() {
  const session = useSession();
  const pathname = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;
  if (session.isPending) return <div className="boot">Loading the studio…</div>;
  if (!session.data) return <SignIn pathname={pathname} />;
  const sessionUser = session.data.user as unknown as Partial<SessionUser>;
  const user = { ...sessionUser, id: sessionUser.id!, role: sessionUser.role!, authorizationEpoch: sessionUser.authorizationEpoch ?? 0 } as SessionUser;
  const sessionValue = session.data.session as unknown as { impersonatedBy?: string | null } | undefined;
  const impersonatedBy = sessionValue?.impersonatedBy ?? null;
  const banner = impersonatedBy ? <ImpersonationBanner user={{ name: user.name || user.email || "Quincy user", role: user.role }} invalidated={user.role === "admin"} /> : null;
  if (impersonatedBy && user.role === "admin") {
    return <>{banner}<main className="impersonation-invalidated" role="alert">This impersonated session is no longer valid — exit to restore your Admin session.</main></>;
  }
  return <>{banner}<QuincyQueryProvider key={`${user.id}:${user.role}:${user.authorizationEpoch}`} principalId={user.id} role={user.role}><PrincipalFreshnessBoundary principalId={user.id} role={user.role} authorizationEpoch={user.authorizationEpoch}><StagesProvider><ShellIdentityProvider user={user} impersonating={Boolean(impersonatedBy)}><StaffRouter /></ShellIdentityProvider></StagesProvider></PrincipalFreshnessBoundary></QuincyQueryProvider></>;
}
