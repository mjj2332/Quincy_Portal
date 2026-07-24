import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Topbar, type AppView } from "./components/Topbar";
import { consumeSignInDestination, useSession } from "./lib/auth";
import { useCapabilities } from "./lib/capabilities";
import { locationStore, parseStaffPathname, type StaffRoute } from "./lib/router";
import { InternalLink } from "./components/InternalLink";
import { Dashboard } from "./screens/Dashboard";
import { ProjectWorkspace } from "./screens/ProjectWorkspace";
import { SignIn } from "./screens/SignIn";
import { Admin } from "./screens/Admin";
import { CreateProject } from "./screens/CreateProject";
import { EditProject } from "./screens/EditProject";
import { StagesProvider } from "./lib/stages";

type SessionUser = { id?: string | null; name?: string | null; email?: string | null };
type Notice = { path: string; message: string } | null;

function viewFor(route: StaffRoute): AppView {
  switch (route.kind) {
    case "dashboard": return "dashboard";
    case "create-project": return "create-project";
    case "project": return "project";
    case "edit-project": return "edit-project";
    case "admin": return "admin";
    default: return "not-found";
  }
}

function Shell({ user }: { user: SessionUser }) {
  const history = locationStore();
  const pathname = useSyncExternalStore(history.subscribe, history.getPathname, () => "/");
  const route = parseStaffPathname(pathname);
  const [notice, setNotice] = useState<Notice>(null);
  const restored = useRef(false);
  const { can } = useCapabilities();
  const canAccessAdmin = can("adminBackend");
  const canCreateProject = can("createProject");
  const canEditProject = can("editProject");
  const blocked = (route.kind === "admin" && !canAccessAdmin)
    || (route.kind === "create-project" && !canCreateProject)
    || (route.kind === "edit-project" && !canEditProject);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const destination = consumeSignInDestination();
    if (destination !== pathname) history.replace(destination);
  }, [history, pathname]);

  useEffect(() => {
    if (blocked) history.replace("/");
  }, [blocked, history]);

  function navigate(path: string, message?: string, replace = false) {
    if (message) setNotice({ path, message });
    else setNotice(null);
    if (replace) history.replace(path); else history.push(path);
  }

  const activeView = viewFor(route);
  return (
    <div className="app">
      <Topbar activeView={activeView} canAccessAdmin={canAccessAdmin} user={user} />
      {blocked && <main className="page"><div className="empty" role="status"><span className="serif">Returning to dashboard.</span></div></main>}
      {!blocked && route.kind === "dashboard" && <Dashboard />}
      {!blocked && route.kind === "project" && <ProjectWorkspace key={route.projectId} projectId={route.projectId} notice={notice?.path === pathname ? notice.message : null} onNoticeShown={() => setNotice(null)} />}
      {!blocked && route.kind === "create-project" && <CreateProject onNavigate={navigate} />}
      {!blocked && route.kind === "edit-project" && <EditProject key={route.projectId} projectId={route.projectId} onNavigate={navigate} />}
      {!blocked && route.kind === "admin" && <Admin currentUserId={user.id} />}
      {!blocked && (route.kind === "not-found" || route.kind === "reserved") && <main className="page"><div className="empty" role="status"><span className="serif">That page is not available.</span><InternalLink className="button button--secondary" to="/">Return to dashboard</InternalLink></div></main>}
    </div>
  );
}

export default function App() {
  const session = useSession();
  const pathname = typeof window === "undefined" ? "/" : window.location.pathname;
  if (session.isPending) return <div className="boot">Loading the studio…</div>;
  if (!session.data) return <SignIn pathname={pathname} />;
  return <StagesProvider><Shell user={session.data.user as SessionUser} /></StagesProvider>;
}
