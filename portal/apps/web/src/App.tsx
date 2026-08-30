import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Topbar, type AppView } from "./components/Topbar";
import { consumeSignInDestination, useSession } from "./lib/auth";
import { useCapabilities } from "./lib/capabilities";
import { locationStore, parseStaffLocation, staffPathFor, type StaffRoute } from "./lib/router";
import { InternalLink } from "./components/InternalLink";
import { Dashboard } from "./screens/Dashboard";
import { ProjectWorkspace } from "./screens/ProjectWorkspace";
import { SignIn } from "./screens/SignIn";
import { Admin } from "./screens/Admin";
import { CreateProject } from "./screens/CreateProject";
import { EditProject } from "./screens/EditProject";
import { NotificationPreferences } from "./screens/NotificationPreferences";
import { ImpersonationBanner } from "./components/ImpersonationBanner";
import { PrincipalFreshnessBoundary } from "./components/PrincipalFreshnessBoundary";
import { StagesProvider } from "./lib/stages";
import { QuincyQueryProvider } from "./lib/query-client";
import { roleHasCapability, type Role } from "@quincy/shared";

type SessionUser = { id: string; name?: string | null; email?: string | null; role: Role; authorizationEpoch: number };
type Notice = { path: string; message: string } | null;

function viewFor(route: StaffRoute): AppView {
  switch (route.kind) {
    case "dashboard": return "dashboard";
    case "create-project": return "create-project";
    case "project": return "project";
    case "edit-project": return "edit-project";
    case "admin": return "admin";
    case "notifications": return "notifications";
    default: return "not-found";
  }
}

function Shell({ user, impersonating }: { user: SessionUser; impersonating: boolean }) {
  const history = locationStore();
  const completeLocation = useSyncExternalStore(history.subscribe, history.getLocation, () => "/");
  const pathname = completeLocation.split("?", 1)[0]!;
  const route = useMemo(() => parseStaffLocation(completeLocation), [completeLocation]);
  const [notice, setNotice] = useState<Notice>(null);
  const restored = useRef(false);
  const lastObservedIntentLocationRef = useRef<string | null>(null);
  const collaborationSignalRef = useRef(0);
  const [collaborationIntent, setCollaborationIntent] = useState<{ projectId: string; signal: number } | null>(null);
  const { can } = useCapabilities();
  const canAccessAdmin = can("adminBackend");
  const canCreateProject = can("createProject");
  const canEditProject = can("editProject");
  const blocked = (route.kind === "admin" && !canAccessAdmin)
    || (route.kind === "create-project" && !canCreateProject)
    || (route.kind === "edit-project" && !canEditProject);
  const calendarBlocked = route.kind === "dashboard" && route.calendar !== undefined && !roleHasCapability(user.role, "viewProductionCalendar");

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const destination = consumeSignInDestination();
    if (destination !== null && destination !== completeLocation) history.replace(destination);
  }, [completeLocation, history]);

  useEffect(() => {
    if (route.kind === "project" && route.collaboration === "open") {
      if (lastObservedIntentLocationRef.current !== completeLocation) {
        lastObservedIntentLocationRef.current = completeLocation;
        const signal = ++collaborationSignalRef.current;
        setCollaborationIntent({ projectId: route.projectId, signal });
      }
      return;
    }
    lastObservedIntentLocationRef.current = null;
    setCollaborationIntent(null);
  }, [completeLocation, route]);

  const acknowledgeCollaborationSignal = (projectId: string, signal: number) => {
    if (route.kind !== "project" || route.projectId !== projectId || route.collaboration !== "open" || collaborationIntent?.projectId !== projectId || collaborationIntent.signal !== signal) return;
    lastObservedIntentLocationRef.current = null;
    history.replace(staffPathFor({ kind: "project", projectId }));
  };

  useEffect(() => {
    if (blocked) history.replace("/");
  }, [blocked, history]);

  useEffect(() => {
    if (calendarBlocked) history.replace("/");
  }, [calendarBlocked, history]);

  function navigate(path: string, message?: string, replace = false) {
    if (message) setNotice({ path, message });
    else setNotice(null);
    if (replace) history.replace(path); else history.push(path);
  }

  const activeView = viewFor(route);
  return (
    <div className={impersonating ? "app app--impersonating" : "app"}>
      <Topbar activeView={activeView} canAccessAdmin={canAccessAdmin} user={user} />
      {blocked && <main className="page"><div className="empty" role="status"><span className="serif">Returning to dashboard.</span></div></main>}
      {!blocked && route.kind === "dashboard" && <Dashboard currentUserId={user.id} role={user.role} authorizationEpoch={user.authorizationEpoch} calendar={calendarBlocked ? null : route.calendar ?? null} />}
      {!blocked && route.kind === "project" && <ProjectWorkspace key={route.projectId} projectId={route.projectId} notice={notice?.path === pathname ? notice.message : null} onNoticeShown={() => setNotice(null)} collaborationOpenSignal={collaborationIntent?.projectId === route.projectId ? collaborationIntent.signal : undefined} onCollaborationOpenSignalConsumed={(signal) => acknowledgeCollaborationSignal(route.projectId, signal)} />}
      {!blocked && route.kind === "create-project" && <CreateProject onNavigate={navigate} />}
      {!blocked && route.kind === "edit-project" && <EditProject key={route.projectId} projectId={route.projectId} onNavigate={navigate} />}
      {!blocked && route.kind === "admin" && <Admin currentUserId={user.id} />}
      {!blocked && route.kind === "notifications" && <NotificationPreferences />}
      {!blocked && (route.kind === "not-found" || route.kind === "reserved") && <main className="page"><div className="empty" role="status"><span className="serif">That page is not available.</span><InternalLink className="button button--secondary" to="/">Return to dashboard</InternalLink></div></main>}
    </div>
  );
}

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
  return <>{banner}<QuincyQueryProvider key={`${user.id}:${user.role}:${user.authorizationEpoch}`} principalId={user.id} role={user.role}><PrincipalFreshnessBoundary principalId={user.id} role={user.role} authorizationEpoch={user.authorizationEpoch}><StagesProvider><Shell user={user} impersonating={Boolean(impersonatedBy)} /></StagesProvider></PrincipalFreshnessBoundary></QuincyQueryProvider></>;
}
