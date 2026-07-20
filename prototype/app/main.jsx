/* =====================================================================
   Quincy Portal — app shell, roles, routing, flows
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState, useEffect, useMemo } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  function App() {
    const { Button } = DS();
    const { useTweaks } = window;
    const seed = useMemo(() => QP.seedReview(), []);
    const [persona, setPersona] = QP.useStored("persona", "admin");   // admin | photographer | editor | client
    const [view, setView] = QP.useStored("view", "dashboard");
    const [currentId, setCurrentId] = QP.useStored("current", "p-kings");
    const [query, setQuery] = useState("");
    const [states, setStates] = QP.useStored("review2", seed.states);
    const [comments, setComments] = QP.useStored("comments2", seed.comments);
    const [favs, setFavs] = QP.useStored("favs", seed.favs);
    const [purchases, setPurchases] = QP.useStored("purchases", seed.purchases);
    const [overrides, setOverrides] = QP.useStored("status2", {});
    const [copyEdits, setCopyEdits] = QP.useStored("copy", {});
    const [created, setCreated] = QP.useStored("created", []);   // Tonomo-ingested order payloads
    const [rawSync, setRawSync] = QP.useStored("rawSync", {});    // { [projectId]: [raw photos] } added via upload/sync
    const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
    const [publish, setPublish] = useState(null);
    const [send, setSend] = useState(null);     // {project, n}
    const [upload, setUpload] = useState(false);
    const [sync, setSync] = useState(false);    // Dropbox sync modal
    const [tonomo, setTonomo] = useState(false);   // webhook modal

    const role = QP.ROLES[persona] || QP.ROLES.admin;

    const createdProjects = (created || []).map((o) => QP.fromTonomo(o));
    const projects = [...createdProjects, ...QP.PROJECTS].map((p) => {
      const eff = overrides[p.id] || p.status;
      // merge any uploaded/synced RAW frames into the project's RAW collection
      const extraRaw = rawSync[p.id];
      let collections = p.collections;
      if (extraRaw && extraRaw.length) {
        collections = p.collections.map((c) => c.id === "raw" ? { ...c, photos: [...c.photos, ...extraRaw] } : c);
      }
      return {
        ...p,
        status: eff,
        stage: QP.STATUS[eff].stage,
        copy: copyEdits[p.id] || p.copy,
        collections,
      };
    });
    let project = projects.find((p) => p.id === currentId) || projects[0];

    // role guards
    if (persona === "photographer" && project.photographer !== role.who) {
      project = projects.find((p) => p.photographer === role.who) || project;
    }
    // client must land on a published project
    let clientProject = project;
    if (persona === "client" && !QP.collOf(project, "edited")) {
      clientProject = projects.find((p) => QP.collOf(p, "edited")) || project;
    }

    const setReview = (id, patch) => setStates((prev) => {
      const cur = prev[id] || {};
      const next = typeof patch === "function" ? patch(cur) : patch;
      return { ...prev, [id]: { ...cur, ...next } };
    });
    const addComment = (id, { text, pin, drawing }) => setComments((prev) => ({
      ...prev,
      [id]: [...(prev[id] || []), { id: Math.random().toString(36).slice(2), who: role.who, role: role.id === "client" ? "Client" : role.label, text, pin: pin || null, drawing: drawing || null, at: new Date().toISOString() }],
    }));
    const toggleFav = (id) => setFavs((prev) => ({ ...prev, [id]: !prev[id] }));
    const onPurchase = (id) => setPurchases((prev) => ({ ...prev, [id]: true }));
    const setCopy = (pid, copy) => setCopyEdits((prev) => ({ ...prev, [pid]: { ...copy, status: copy.status || "draft" } }));

    const openProject = (id) => { setCurrentId(id); setView("project"); };
    const confirmSend = (proj) => { setOverrides((o) => ({ ...o, [proj.id]: "editing" })); setSend(null); QP.toast("Copied to autoHDR Dropbox", { sub: `${proj.street} · editing in progress`, icon: "wand" }); };
    const confirmPublish = (proj) => { setOverrides((o) => ({ ...o, [proj.id]: "delivered" })); setPublish({ project: proj, done: true }); };
    const setStatus = (id, status) => setOverrides((o) => ({ ...o, [id]: status }));
    const addRaw = (projId, count) => {
      setRawSync((prev) => {
        const existing = prev[projId] || [];
        const next = QP.makeRawPhotos(projId, count, existing.length);
        return { ...prev, [projId]: [...existing, ...next] };
      });
      // a fresh booking moves into RAW review once frames land
      setOverrides((o) => (o[projId] === "raw_review" || !isAwaiting(projId) ? o : { ...o, [projId]: "raw_review" }));
    };
    const isAwaiting = (projId) => {
      const base = [...createdProjects, ...QP.PROJECTS].find((p) => p.id === projId);
      const eff = overrides[projId] || (base && base.status);
      return eff === "awaiting_raw";
    };
    const createFromTonomo = (order) => {
      setCreated((c) => [order, ...(c || [])]);
      setTonomo(false);
      const proj = QP.fromTonomo(order);
      QP.toast("Project created from Tonomo", { sub: `${proj.street} · order ${order.orderNo}`, icon: "plus" });
      setCurrentId(proj.id); setView("project");
    };

    const isClient = persona === "client";

    return (
      <div className={cx("app", tweaks.accent === "olive" && "acc-olive")}>
        {/* top bar (not for client) */}
        {!isClient && (
          <div className="topbar">
            <div className="topbar__brand" onClick={() => setView("dashboard")}>
              <img src={QP.res("wmBlack", "assets/logos/quincy-wordmark-black.png")} alt="Quincy Productions" />
            </div>
            <div className="topbar__divider" />
            <nav className="topnav">
              <a className={view === "dashboard" ? "is-active" : ""} onClick={() => setView("dashboard")}>{role.seesAll ? "Projects" : "My shoots"}</a>
              {role.seesAll && <a>Clients</a>}
              {role.seesAll && <a>Schedule</a>}
              {role.id === "admin" && <a>Settings</a>}
            </nav>
            <div className="grow" />
            <div className="search">
              <Icon name="search" size={15} />
              <input placeholder="Search address, suburb, client…" value={query} onChange={(e) => setQuery(e.target.value)} onFocus={() => setView("dashboard")} />
            </div>
            <div className="row gap3">
              <span className="ey" style={{ color: "var(--text-muted)" }}>{role.label}</span>
              <div className="avatar">{role.initials}</div>
            </div>
          </div>
        )}

        {/* ROUTER */}
        {!isClient && view === "dashboard" && (
          <QP.Dashboard projects={projects} states={states} onOpen={openProject} query={query} role={role} setStatus={setStatus} onNewProject={() => setTonomo(true)} />
        )}

        {!isClient && view === "project" && (
          <QP.Workspace project={project} role={role} states={states} setReview={setReview}
            comments={comments} addComment={addComment} density={tweaks.density}
            onBack={() => setView("dashboard")}
            onPublish={(p) => setPublish({ project: p })}
            onSendToEdit={(p, n) => setSend({ project: p, n })}
            onUpload={role.canUploadRaw ? () => setUpload(true) : null}
            onSync={role.canUploadRaw ? () => setSync(true) : null}
            setCopy={setCopy}
            onPreview={() => setPersona("client")} />
        )}

        {isClient && (
          <QP.Client project={clientProject} favs={favs} toggleFav={toggleFav} density={tweaks.density}
            theme={tweaks.clientTheme} captions={tweaks.captions} purchases={purchases} onPurchase={onPurchase} />
        )}

        {/* flows */}
        {publish && <PublishFlow data={publish} onConfirm={confirmPublish} onClose={() => setPublish(null)}
          states={states} viewClient={() => { setPublish(null); setPersona("client"); }} />}
        {send && <SendFlow data={send} states={states} onConfirm={confirmSend} onClose={() => setSend(null)} />}
        {upload && <UploadModal project={project} onClose={() => setUpload(false)} onDone={(n) => addRaw(project.id, n)} />}
        {sync && <SyncModal project={project} onClose={() => setSync(false)} onDone={(n) => addRaw(project.id, n)} />}
        {tonomo && <QP.TonomoModal orders={QP.TONOMO_ORDERS} existingIds={projects.map((p) => p.id)} onCreate={createFromTonomo} onClose={() => setTonomo(false)} />}

        <QP.PersonaSwitch persona={persona} setPersona={setPersona} />
        <TweakPanelUI tweaks={tweaks} setTweak={setTweak} />
        <QP.ToastHost />
      </div>
    );
  }

  /* ---- send to autoHDR ----------------------------------------------- */
  function SendFlow({ data, states, onConfirm, onClose }) {
    const { Button } = DS();
    const { project } = data;
    const rs = QP.rawStats(project, states);
    return (
      <QP.Modal eyebrow={`${project.street} · RAW`} title="Send to autoHDR" onClose={onClose} wide
        footer={<>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" iconLeft={<Icon name="wand" size={15} />} onClick={() => onConfirm(project)} disabled={rs.selected === 0}>Copy {rs.selected} to Dropbox</Button>
        </>}>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>The frames marked for editing are copied to the <strong style={{ color: "var(--text-primary)" }}>Dropbox folder autoHDR monitors</strong>. autoHDR retouches them automatically and the edited frames return to the <strong style={{ color: "var(--text-primary)" }}>Edited</strong> collection for QA.</p>
        <div className="stats" style={{ margin: 0 }}>
          <div className="stat" style={{ padding: 16 }}><div className="v" style={{ fontSize: 26 }}>{rs.selected}</div><div className="l">Marked for edit</div></div>
          <div className="stat" style={{ padding: 16 }}><div className="v" style={{ fontSize: 26 }}>{rs.total - rs.selected}</div><div className="l">Held back</div></div>
          <div className="stat" style={{ padding: 16 }}><div className="v" style={{ fontSize: 26 }}>~{Math.max(1, Math.round(rs.selected / 12))}h</div><div className="l">Est. turnaround</div></div>
        </div>
        <div className="ey muted" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13 }}>Direct API hand-off to autoHDR — planned. For now the portal drops files into the watched Dropbox folder.</div>
      </QP.Modal>
    );
  }

  /* ---- publish to client --------------------------------------------- */
  function PublishFlow({ data, onConfirm, onClose, states, viewClient }) {
    const { Button } = DS();
    const { project } = data;
    const rs = QP.reviewStats(project, states);
    const hasVideo = QP.collOf(project, "video"); const hasCopy = project.copy.status === "published";
    if (data.done) {
      return (
        <QP.Modal eyebrow="Published" title="The gallery is live." onClose={onClose} wide
          footer={<>
            <Button variant="secondary" size="md" iconLeft={<Icon name="copy" size={15} />} onClick={() => { QP.toast("Client link copied", { sub: `quincyportal.com.au/g/${project.slug}`, icon: "link" }); }}>Copy client link</Button>
            <Button variant="primary" size="md" iconLeft={<Icon name="arrow" size={15} />} onClick={viewClient}>Open client gallery</Button>
          </>}>
          <p style={{ fontSize: 15.5, lineHeight: 1.65, color: "var(--text-secondary)" }}>
            <strong style={{ color: "var(--text-primary)" }}>{rs.approved} approved frames</strong>{hasVideo ? ", film" : ""}{hasCopy ? " & listing copy" : ""} for {project.street} have been delivered to <strong style={{ color: "var(--text-primary)" }}>{project.agent}</strong> at {project.agency}. Flagged frames were held back.
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
        <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>This delivers the approved images{hasVideo ? ", video" : ""}, floorplan{hasCopy ? " and copy" : ""} to the client gallery and notifies the agent. Premium add-ons stay paywalled. You can re-publish anytime.</p>
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

  /* ---- upload RAW ---------------------------------------------------- */
  function UploadModal({ project, onClose, onDone }) {
    const { Button } = DS();
    const [uploading, setUploading] = useState(false);
    const [pct, setPct] = useState(0);
    const n = 18;
    React.useEffect(() => {
      if (!uploading) return;
      const fill = setTimeout(() => setPct(100), 60);
      const done = setTimeout(() => { onClose(); if (onDone) onDone(n); QP.toast(`${n} RAW frames uploaded`, { sub: `${project.street} · ready for QA`, icon: "upload" }); }, 1600);
      return () => { clearTimeout(fill); clearTimeout(done); };
    }, [uploading]);
    const start = () => setUploading(true);
    return (
      <QP.Modal eyebrow={`${project.street} · ${project.suburb}`} title="Upload RAW" onClose={onClose}
        footer={!uploading ? <>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" iconLeft={<Icon name="upload" size={15} />} onClick={start}>Upload {n} files</Button>
        </> : null}>
        {!uploading ? <>
          <div className="dropzone"><Icon name="upload" size={26} /><div style={{ marginTop: 10, fontSize: 15 }}>Drop RAW or image files here</div><div className="ey muted" style={{ marginTop: 6 }}>Any RAW or image format · no size limit</div></div>
          <div className="muted" style={{ fontSize: 13 }}>{n} files staged from this shoot. Bracketed sets aren't grouped — your editor brackets them manually during selection.</div>
        </> : (
          <div style={{ padding: "8px 0 4px" }}>
            <div className="ey" style={{ marginBottom: 12 }}>Uploading {n} RAW frames…</div>
            <QP.PrepBar pct={pct} />
            <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>{pct < 100 ? "Transferring originals…" : "Done — handed to QA."}</div>
          </div>
        )}
      </QP.Modal>
    );
  }

  /* ---- sync RAW from Dropbox ----------------------------------------- */
  function SyncModal({ project, onClose, onDone }) {
    const { Button } = DS();
    const t = project.tonomo || {};
    const [link, setLink] = useState(t.rawFolderLink || "");
    const [syncing, setSyncing] = useState(false);
    const [pct, setPct] = useState(0);
    const fromTonomo = !!(t.rawFolderLink && link === t.rawFolderLink);
    const n = 24;

    React.useEffect(() => {
      if (!syncing) return;
      // fill the bar, then complete with a single guaranteed timer
      const fill = setTimeout(() => setPct(100), 60);
      const done = setTimeout(() => { onClose(); if (onDone) onDone(n); QP.toast(`${n} RAW frames synced from Dropbox`, { sub: `${project.street} · ready for QA`, icon: "dropbox" }); }, 1700);
      return () => { clearTimeout(fill); clearTimeout(done); };
    }, [syncing]);

    const start = () => { if (link.trim()) setSyncing(true); };
    return (
      <QP.Modal eyebrow={`${project.street} · ${project.suburb}`} title="Sync RAW from Dropbox" onClose={onClose} wide
        footer={!syncing ? <>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" iconLeft={<Icon name="dropbox" size={15} />} onClick={start} disabled={!link.trim()}>Sync folder</Button>
        </> : null}>
        {!syncing ? <>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>Fetch the RAW frames straight from the shoot's Dropbox folder. Paste a folder link or path, or use the one carried over from the Tonomo booking.</p>
          <div className="optrow">
            <div className="ey">Dropbox folder link or path</div>
            <input className="copyinput mono" style={{ fontSize: 13 }} value={link} placeholder="https://www.dropbox.com/scl/fo/…  or  /tonomo/raw files/…"
                   onChange={(e) => setLink(e.target.value)} />
          </div>
          {t.rawFolderLink ? (
            <button className={cx("dropcard", fromTonomo && "is-on")} onClick={() => setLink(t.rawFolderLink)}>
              <Icon name="dropbox" size={18} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13.5 }}>From Tonomo booking · order {t.orderNo}</div>
                <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.rawFolderPath}</div>
              </div>
              {fromTonomo && <Icon name="check" size={16} />}
            </button>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>This project has no Dropbox folder from Tonomo — paste one manually above.</div>
          )}
        </> : (
          <div style={{ padding: "8px 0 4px" }}>
            <div className="ey row gap2" style={{ marginBottom: 12 }}><Icon name="dropbox" size={14} style={{ color: "var(--signal-info)" }} /> Syncing {n} RAW frames from Dropbox…</div>
            <QP.PrepBar pct={pct} />
            <div className="mono" style={{ fontSize: 12, marginTop: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{link}</div>
          </div>
        )}
      </QP.Modal>
    );
  }

  /* ---- tweaks -------------------------------------------------------- */
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

  function mount() {
    if (!window.QuincyProductionsDesignSystem_b05a1c || !QP.Dashboard || !QP.Workspace || !QP.PhotoBoard || !QP.TonomoModal || !window.useTweaks) {
      mount._n = (mount._n || 0) + 1;
      if (mount._n > 60) {
        var miss = [];
        if (!window.QuincyProductionsDesignSystem_b05a1c) miss.push("DS bundle");
        if (!QP.Dashboard) miss.push("Dashboard"); if (!QP.Workspace) miss.push("Workspace");
        if (!QP.PhotoBoard) miss.push("PhotoBoard"); if (!QP.Client) miss.push("Client");
        if (!QP.ImageViewer) miss.push("ImageViewer"); if (!window.useTweaks) miss.push("Tweaks");
        document.getElementById("app").innerHTML = '<div class="boot">Missing: ' + miss.join(", ") + '</div>';
        return;
      }
      return setTimeout(mount, 40);
    }
    ReactDOM.createRoot(document.getElementById("app")).render(<App />);
  }
  mount();
})();
