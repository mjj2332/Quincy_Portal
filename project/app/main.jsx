/* =====================================================================
   Quincy Portal — app shell, routing, state, publish handoff
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState, useEffect, useMemo, useRef } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  function App() {
    const { Button } = DS();
    const { useTweaks } = window;
    const seed = useMemo(() => QP.seedReview(), []);
    const [persona, setPersona] = QP.useStored("persona", "team");
    const [view, setView] = QP.useStored("view", "dashboard"); // team: dashboard | project
    const [currentId, setCurrentId] = QP.useStored("current", "p-kings");
    const [query, setQuery] = useState("");
    const [states, setStates] = QP.useStored("review", seed.states);
    const [comments, setComments] = QP.useStored("comments", seed.comments);
    const [favs, setFavs] = QP.useStored("favs", seed.favs);
    const [overrides, setOverrides] = QP.useStored("status", {});
    const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
    const [publish, setPublish] = useState(null); // {project} | {project, done:true}

    // apply client theme tweak on the root
    const projects = QP.PROJECTS.map((p) => ({ ...p, status: overrides[p.id] || p.status }));
    const project = projects.find((p) => p.id === currentId) || projects[0];

    const setReview = (id, patch) => setStates((prev) => {
      const cur = prev[id] || {};
      const next = typeof patch === "function" ? patch(cur) : patch;
      return { ...prev, [id]: { ...cur, ...next } };
    });
    const addComment = (id, { text, pin, drawing }) => setComments((prev) => ({
      ...prev,
      [id]: [...(prev[id] || []), { id: Math.random().toString(36).slice(2), who: "You", role: persona === "reviewer" ? "Reviewer" : "Quincy", text, pin: pin || null, drawing: drawing || null, at: new Date().toISOString() }],
    }));
    const toggleFav = (id) => setFavs((prev) => ({ ...prev, [id]: !prev[id] }));

    const openProject = (id) => { setCurrentId(id); setView("project"); };

    const confirmPublish = (proj) => {
      setOverrides((o) => ({ ...o, [proj.id]: "delivered" }));
      setPublish({ project: proj, done: true });
    };

    /* ----- top chrome per persona ----- */
    const isClient = persona === "client";
    const isReviewer = persona === "reviewer";

    return (
      <div className={cx("app", tweaks.accent === "olive" && "acc-olive")}>
        {/* TEAM / REVIEWER top bar (client renders its own hero brand) */}
        {!isClient && (
          <div className={cx("topbar", isReviewer && "is-ink")}>
            <div className="topbar__brand" onClick={() => { if (!isReviewer) { setView("dashboard"); } }}>
              <img src={isReviewer ? QP.res("wmWhite", "assets/logos/quincy-wordmark-white.png") : QP.res("wmBlack", "assets/logos/quincy-wordmark-black.png")} alt="Quincy Productions" />
            </div>
            <div className="topbar__divider" />
            {isReviewer ? (
              <div className="ey">Review link · {project.suburb}</div>
            ) : (
              <nav className="topnav">
                <a className={view === "dashboard" ? "is-active" : ""} onClick={() => setView("dashboard")}>Projects</a>
                <a>Clients</a>
                <a>Schedule</a>
                <a>Settings</a>
              </nav>
            )}
            <div className="grow" />
            {!isReviewer && (
              <div className="search">
                <Icon name="search" size={15} />
                <input placeholder="Search address, suburb, client…" value={query} onChange={(e) => setQuery(e.target.value)} onFocus={() => setView("dashboard")} />
              </div>
            )}
            {!isReviewer && <button className="icbtn"><Icon name="calendar" size={17} /></button>}
            <div className="avatar">{isReviewer ? "MP" : "JQ"}</div>
          </div>
        )}

        {/* guest reviewer banner */}
        {isReviewer && (
          <div className="guestbar">
            <div className="row gap4">
              <span className="eyl">Shared for review</span>
              <span style={{ opacity: .6 }}>—</span>
              <span>You're reviewing <strong>{project.street}</strong> for Quincy Productions. Your approvals &amp; notes are sent back to the studio.</span>
            </div>
            <select className="chip" value={currentId} onChange={(e) => setCurrentId(e.target.value)} style={{ background: "transparent", color: "var(--paper-050)", borderColor: "rgba(246,244,239,.3)" }}>
              {projects.filter((p) => p.status !== "editing").map((p) => <option key={p.id} value={p.id} style={{ color: "#111" }}>{p.street}</option>)}
            </select>
          </div>
        )}

        {/* MAIN ROUTER */}
        {persona === "team" && view === "dashboard" && (
          <QP.Dashboard projects={projects} states={states} onOpen={openProject} query={query} />
        )}

        {persona === "team" && view === "project" && (
          <>
            <div className="spread" style={{ padding: "16px 28px 0", maxWidth: 1480, margin: "0 auto", width: "100%" }}>
              <button className="chip" onClick={() => setView("dashboard")}><Icon name="left" size={13} /> All projects</button>
              <div className="toolbar">
                <button className="chip" onClick={() => setPersona("reviewer")}><Icon name="eye" size={13} /> Preview reviewer link</button>
                <button className="chip" onClick={() => setPersona("client")}><Icon name="image" size={13} /> Preview client gallery</button>
              </div>
            </div>
            <QP.Review project={project} states={states} setReview={setReview} comments={comments} addComment={addComment}
              persona="team" density={tweaks.density} onRequestPublish={(p) => setPublish({ project: p })} />
          </>
        )}

        {isReviewer && (
          <QP.Review project={project} states={states} setReview={setReview} comments={comments} addComment={addComment}
            persona="reviewer" density={tweaks.density} onRequestPublish={() => {}} />
        )}

        {isClient && (
          <QP.Client project={project} favs={favs} toggleFav={toggleFav} density={tweaks.density} theme={tweaks.clientTheme} captions={tweaks.captions} />
        )}

        {/* publish modal */}
        {publish && <PublishFlow data={publish} onConfirm={confirmPublish} onClose={() => setPublish(null)}
          states={states} viewClient={() => { setPublish(null); setPersona("client"); }} />}

        <QP.PersonaSwitch persona={persona} setPersona={setPersona} />
        <TweakPanelUI tweaks={tweaks} setTweak={setTweak} />
        <QP.ToastHost />
      </div>
    );
  }

  /* ---- publish handoff modal ----------------------------------------- */
  function PublishFlow({ data, onConfirm, onClose, states, viewClient }) {
    const { Button } = DS();
    const { project } = data;
    const rs = QP.reviewStats(project, states);
    if (data.done) {
      return (
        <QP.Modal eyebrow="Published" title="The gallery is live." onClose={onClose} wide
          footer={<>
            <Button variant="secondary" size="md" iconLeft={<Icon name="copy" size={15} />} onClick={() => { QP.toast("Client link copied", { sub: `quincyportal.com.au/g/${project.slug}`, icon: "link" }); }}>Copy client link</Button>
            <Button variant="primary" size="md" iconLeft={<Icon name="arrow" size={15} />} onClick={viewClient}>Open client gallery</Button>
          </>}>
          <p style={{ fontSize: 15.5, lineHeight: 1.65, color: "var(--text-secondary)" }}>
            <strong style={{ color: "var(--text-primary)" }}>{rs.approved} approved frames</strong> of {project.street} have been delivered to <strong style={{ color: "var(--text-primary)" }}>{project.agent}</strong> at {project.agency}. Flagged frames were held back.
          </p>
          <div className="row gap3" style={{ border: "1px solid var(--border-hairline)", padding: "12px 14px", background: "var(--paper-000)" }}>
            <Icon name="link" size={16} style={{ color: "var(--text-muted)" }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5 }}>quincyportal.com.au/g/{project.slug}</span>
          </div>
        </QP.Modal>
      );
    }
    return (
      <QP.Modal eyebrow={`${project.street} · ${project.suburb}`} title="Publish to client" onClose={onClose} wide
        footer={<>
          <Button variant="ghost" size="md" onClick={onClose}>Not yet</Button>
          <Button variant="primary" size="md" iconLeft={<Icon name="send" size={15} />} onClick={() => onConfirm(project)}>Publish {rs.approved} frames</Button>
        </>}>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>This delivers the approved set to the client gallery and notifies the agent. You can keep editing and re-publish anytime.</p>
        <div className="stats" style={{ margin: 0 }}>
          <div className="stat" style={{ padding: 16 }}><div className="v" style={{ fontSize: 26 }}>{rs.approved}</div><div className="l">Approved</div></div>
          <div className="stat" style={{ padding: 16 }}><div className="v" style={{ fontSize: 26 }}>{rs.flagged}</div><div className="l">Held back</div></div>
          <div className="stat" style={{ padding: 16 }}><div className="v" style={{ fontSize: 26 }}>{rs.pending}</div><div className="l">Unreviewed</div></div>
        </div>
        <div className="row gap3" style={{ marginTop: 4 }}>
          <div className="avatar" style={{ background: "var(--greige-500)" }}>{project.agent.split(" ").map((x) => x[0]).join("").slice(0,2)}</div>
          <div><div style={{ fontSize: 14 }}>{project.agent}</div><div className="ey muted">{project.email}</div></div>
        </div>
      </QP.Modal>
    );
  }

  /* ---- tweaks defaults + panel --------------------------------------- */
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "density": "standard",
    "clientTheme": "paper",
    "accent": "mono",
    "captions": true
  }/*EDITMODE-END*/;

  function TweakPanelUI({ tweaks, setTweak }) {
    const { TweaksPanel, TweakSection, TweakRadio, TweakToggle } = window;
    if (!TweaksPanel) return null;
    return (
      <TweaksPanel title="Tweaks">
        <TweakSection label="Galleries" />
        <TweakRadio label="Grid density" value={tweaks.density} options={["comfortable", "standard", "dense"]} onChange={(v) => setTweak("density", v)} />
        <TweakToggle label="Frame captions" value={tweaks.captions} onChange={(v) => setTweak("captions", v)} />
        <TweakSection label="Client delivery" />
        <TweakRadio label="Gallery theme" value={tweaks.clientTheme} options={["paper", "ink"]} onChange={(v) => setTweak("clientTheme", v)} />
        <TweakSection label="System" />
        <TweakRadio label="Accent" value={tweaks.accent} options={["mono", "olive"]} onChange={(v) => setTweak("accent", v)} />
      </TweaksPanel>
    );
  }

  /* ---- mount once DS bundle is ready ---------------------------------- */
  function mount() {
    if (!window.QuincyProductionsDesignSystem_b05a1c || !QP.Dashboard || !window.useTweaks) return setTimeout(mount, 40);
    ReactDOM.createRoot(document.getElementById("app")).render(<App />);
  }
  mount();
})();
