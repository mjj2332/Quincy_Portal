import { useState } from "react";
import { Topbar, type AppView } from "./components/Topbar";
import { useSession } from "./lib/auth";
import { useCapabilities } from "./lib/capabilities";
import { Dashboard } from "./screens/Dashboard";
import { SignIn } from "./screens/SignIn";

type SessionUser = {
  name?: string | null;
  email?: string | null;
};

function ProjectPlaceholder({ projectId, onBack }: { projectId: string | null; onBack: () => void }) {
  return (
    <main className="page project-placeholder">
      <div className="pagehead">
        <div>
          <div className="ey" style={{ marginBottom: 14 }}>Project workspace</div>
          <h1 className="serif">Project detail</h1>
        </div>
        <button className="button button--secondary" type="button" onClick={onBack}>Back to dashboard</button>
      </div>
      <section className="placeholder-card">
        <div className="ey" style={{ marginBottom: 12 }}>Selected project</div>
        <p className="serif" style={{ fontSize: 28, marginBottom: 12 }}>{projectId ?? "No project selected"}</p>
        <p>The project workspace will be connected in the next portal increment. This shell preserves the selected project identifier for that view.</p>
      </section>
    </main>
  );
}

function AdminPlaceholder() {
  return (
    <main className="page project-placeholder">
      <div className="pagehead"><div><div className="ey" style={{ marginBottom: 14 }}>Administration</div><h1 className="serif">Studio controls</h1></div></div>
      <section className="placeholder-card"><p>Administration is available to authorised studio staff. Its management screens will be connected in a later increment.</p></section>
    </main>
  );
}

function Shell({ user }: { user: SessionUser }) {
  const [view, setView] = useState<AppView>("dashboard");
  const [projectId, setProjectId] = useState<string | null>(null);
  const { can } = useCapabilities();
  const canAccessAdmin = can("adminBackend");

  function navigate(nextView: AppView) {
    if (nextView === "admin" && !canAccessAdmin) {
      setView("dashboard");
      return;
    }
    setView(nextView);
  }

  function openProject(id: string) {
    setProjectId(id);
    setView("project");
  }

  return (
    <div className="app">
      <Topbar activeView={view} canAccessAdmin={canAccessAdmin} user={user} onNavigate={navigate} />
      {view === "dashboard" && <Dashboard onOpenProject={openProject} />}
      {view === "project" && <ProjectPlaceholder projectId={projectId} onBack={() => setView("dashboard")} />}
      {view === "admin" && canAccessAdmin && <AdminPlaceholder />}
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
