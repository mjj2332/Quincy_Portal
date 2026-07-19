import { useState } from "react";
import { Topbar, type AppView } from "./components/Topbar";
import { useSession } from "./lib/auth";
import { useCapabilities } from "./lib/capabilities";
import { Dashboard } from "./screens/Dashboard";
import { ProjectWorkspace } from "./screens/ProjectWorkspace";
import { SignIn } from "./screens/SignIn";
import { Admin } from "./screens/Admin";
import { CreateProject } from "./screens/CreateProject";

type SessionUser = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
};

function Shell({ user }: { user: SessionUser }) {
  const [view, setView] = useState<AppView>("dashboard");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const { can } = useCapabilities();
  const canAccessAdmin = can("adminBackend");
  const canCreateProject = can("createProject");

  function navigate(nextView: AppView) {
    if (nextView === "admin" && !canAccessAdmin) {
      setView("dashboard");
      return;
    }
    if (nextView === "create-project" && !canCreateProject) {
      setView("dashboard");
      return;
    }
    setView(nextView);
  }

  function openProject(id: string, notice?: string) {
    setProjectId(id);
    setProjectNotice(notice ?? null);
    setView("project");
  }

  return (
    <div className="app">
      <Topbar activeView={view} canAccessAdmin={canAccessAdmin} user={user} onNavigate={navigate} />
      {view === "dashboard" && <Dashboard onOpenProject={openProject} onCreateProject={() => navigate("create-project")} />}
      {view === "project" && <ProjectWorkspace projectId={projectId} notice={projectNotice} onNoticeShown={() => setProjectNotice(null)} onBack={() => setView("dashboard")} />}
      {view === "create-project" && canCreateProject && <CreateProject onCancel={() => setView("dashboard")} onOpenProject={openProject} />}
      {view === "admin" && canAccessAdmin && <Admin currentUserId={user.id} />}
    </div>
  );
}

export default function App() {
  const session = useSession();

  if (session.isPending) {
    return <div className="boot">Loading the studio…</div>;
  }

  if (!session.data) {
    return <SignIn />;
  }

  return <Shell user={session.data.user as SessionUser} />;
}
