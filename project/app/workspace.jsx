/* =====================================================================
   Quincy Portal — Project workspace (role-gated shell)
   →  window.QP.Workspace
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  const TAB_META = {
    raw:       { name: "RAW", icon: "image" },
    edited:    { name: "Edited", icon: "sparkle" },
    video:     { name: "Video", icon: "video" },
    floorplan: { name: "Floorplan", icon: "folder" },
    copy:      { name: "Copy", icon: "text" },
  };

  QP.Workspace = function Workspace(props) {
    const { project, role, states, setReview, comments, addComment, density,
            onBack, onPublish, onUpload, onSendToEdit, setCopy, onPreview } = props;
    const { Button } = DS();

    // which collection tabs this role may see AND that exist on the project
    const available = role.tabs.filter((t) => t === "copy" ? true : !!QP.collOf(project, t));
    const [tab, setTab] = useState(available[0] || "raw");
    const activeTab = available.includes(tab) ? tab : available[0];

    const ed = project.editing;

    return (
      <div className="work">
        {/* RAIL ---------------------------------------------------------- */}
        <aside className="rail">
          <div style={{ marginBottom: 6 }}><QP.StatusBadge status={project.status} /></div>
          <h2 className="serif" style={{ marginTop: 10 }}>{project.street}</h2>
          <div className="ey" style={{ marginTop: 8 }}>{project.suburb} · {project.postcode} NSW</div>

          <div className="rail__sec">
            <div className="kv"><span className="k">Client</span><span className="vv">{project.agency}</span></div>
            <div className="kv"><span className="k">Agent</span><span className="vv">{project.agent}</span></div>
            <div className="kv"><span className="k">Shoot</span><span className="vv">{QP.fmtShort(project.shoot)}</span></div>
            <div className="kv"><span className="k">Shooter</span><span className="vv">{project.photographer}</span></div>
            {role.id !== "photographer" && <div className="kv"><span className="k">Guide</span><span className="vv">{QP.fmtAUD(project.price)}</span></div>}
          </div>

          <div className="rail__sec">
            <div className="ey" style={{ marginBottom: 12 }}>Collections</div>
            <div className="filterlist">
              {available.map((t) => {
                const m = TAB_META[t];
                const coll = QP.collOf(project, t);
                const n = t === "copy" ? null : (coll.photos ? coll.photos.length : coll.items.length);
                return (
                  <div key={t} className={cx("frow", activeTab === t && "is-active")} onClick={() => setTab(t)}>
                    <span className="row gap2"><Icon name={m.icon} size={15} /> {m.name}</span>
                    {n != null ? <span className="cnt">{n}</span> : <span className="cnt">{project.copy.status === "published" ? "✓" : "—"}</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* autoHDR status */}
          {ed && role.id !== "photographer" && (
            <div className="rail__sec">
              <div className="ey" style={{ marginBottom: 10 }}>autoHDR</div>
              <div className="hdr">
                <Icon name={ed.status === "processing" ? "clock" : "check2"} size={16}
                      style={{ color: ed.status === "processing" ? "var(--signal-caution)" : "var(--signal-positive)" }} />
                <div>
                  <div style={{ fontSize: 13.5 }}>{ed.status === "processing" ? "Processing edits" : "Edits returned"}</div>
                  <div className="ey muted">{ed.returned} / {ed.sent} frames</div>
                </div>
              </div>
            </div>
          )}
        </aside>

        {/* MAIN ---------------------------------------------------------- */}
        <div className="workmain">
          {/* workspace bar */}
          <div className="wsbar">
            <button className="chip" onClick={onBack}><Icon name="left" size={13} /> {role.seesAll ? "All projects" : "My shoots"}</button>
            {ed && ed.status === "processing" && <span className="chip" style={{ cursor: "default" }}><span className="sdot" style={{ background: "var(--signal-caution)" }} /> autoHDR processing</span>}
            <div className="grow" />
            {role.id === "photographer" && (
              <Button variant="primary" size="sm" iconLeft={<Icon name="upload" size={14} />} onClick={onUpload}>Upload RAW</Button>
            )}
            {role.canManageExtras && onUpload && (
              <button className="chip" onClick={onUpload}><Icon name="upload" size={13} /> Upload</button>
            )}
            {role.canPublish && (
              <>
                <button className="chip" onClick={() => onPreview && onPreview()}><Icon name="eye" size={13} /> Preview client</button>
                <Button variant="primary" size="sm" iconLeft={<Icon name="arrow" size={14} />} onClick={() => onPublish(project)}>Publish to client</Button>
              </>
            )}
          </div>

          {/* active collection */}
          {(activeTab === "raw" || activeTab === "edited") && (
            <QP.PhotoBoard project={project} coll={activeTab} role={role} states={states}
              setReview={setReview} comments={comments} addComment={addComment} density={density}
              onSend={(n) => onSendToEdit(project, n)} />
          )}
          {activeTab === "video" && <VideoBoard project={project} role={role} />}
          {activeTab === "floorplan" && <FloorplanBoard project={project} />}
          {activeTab === "copy" && <CopyBoard project={project} role={role} setCopy={setCopy} />}
        </div>
      </div>
    );
  };

  /* ---- video board --------------------------------------------------- */
  function VideoBoard({ project, role }) {
    const coll = QP.collOf(project, "video");
    const [open, setOpen] = useState(null);
    return (
      <>
        <div className="worktools">
          <div className="ey" style={{ color: "var(--text-primary)" }}>{coll.name} · {coll.note}</div>
          <div className="grow" />
          <span className="prog">{coll.items.length} clips · {coll.items.filter((v) => v.premium).length} premium</span>
        </div>
        <div className="workgrid">
          <div className="grid" style={{ "--cols": 3, "--gap": "16px" }}>
            {coll.items.map((v) => (
              <div key={v.id} className="vtile" onClick={() => setOpen(v)}>
                <div className="vtile__media">
                  <img src={v.poster} alt={v.title} loading="lazy" />
                  <span className="vtile__play"><Icon name="play" size={20} fill="currentColor" /></span>
                  <span className="vtile__dur">{v.dur}</span>
                  {v.vimeo && <span className="vtile__src">Vimeo</span>}
                  {v.premium && <span className="lockbadge"><Icon name="lock" size={12} /> Premium · {QP.fmtAUD(v.price)}</span>}
                </div>
                <div className="vtile__body">
                  <div style={{ fontSize: 15 }}>{v.title}</div>
                  <div className="ey muted">{v.premium ? "Paywalled add-on" : "Included in delivery"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        {open && (
          <QP.Modal eyebrow={project.street} title={open.title} onClose={() => setOpen(null)} wide
            footer={<Button variant="primary" size="md" onClick={() => setOpen(null)}>Close</Button>}>
            <div className="videoframe">
              <img src={open.poster} alt="" />
              <span className="vtile__play vtile__play--lg"><Icon name="play" size={28} fill="currentColor" /></span>
            </div>
            <div className="row gap3" style={{ justifyContent: "space-between" }}>
              <span className="ey muted">{open.vimeo ? "Vimeo · " + open.vimeo : "Duration " + open.dur}</span>
              {open.premium && <span className="chip is-active"><Icon name="lock" size={12} /> Premium · {QP.fmtAUD(open.price)}</span>}
            </div>
          </QP.Modal>
        )}
      </>
    );
  }

  /* ---- floorplan board ----------------------------------------------- */
  function FloorplanBoard({ project }) {
    const coll = QP.collOf(project, "floorplan");
    return (
      <>
        <div className="worktools"><div className="ey" style={{ color: "var(--text-primary)" }}>{coll.name} · {coll.note}</div></div>
        <div className="workgrid">
          <div className="grid" style={{ "--cols": 2, "--gap": "16px" }}>
            {coll.photos.map((p) => (
              <div key={p.id} className="tile" style={{ aspectRatio: "3 / 2", cursor: "default" }}>
                <QP.FloorplanArt />
                <span className="tile__cap" style={{ opacity: .9 }}>{p.cap}</span>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  /* ---- copywriting board (PDF deliverable) --------------------------- */
  function CopyBoard({ project, role, setCopy }) {
    const c = project.copy;
    const canManage = role.canManageExtras;
    const hasFile = !!c.file;

    const upload = () => {
      setCopy(project.id, { ...c, status: "published", file: c.file || (project.slug + "-copy.pdf"), pages: c.pages || 2 });
      QP.toast("Copywriting PDF uploaded", { sub: project.street, icon: "upload" });
    };

    return (
      <>
        <div className="worktools">
          <div className="ey" style={{ color: "var(--text-primary)" }}>Copywriting · listing description (PDF)</div>
          <div className="grow" />
          <span className={cx("chip", hasFile && "is-active")} style={{ cursor: "default" }}>{hasFile ? "Published" : "Awaiting upload"}</span>
          {canManage && <button className="chip" onClick={upload}><Icon name="upload" size={13} /> {hasFile ? "Replace PDF" : "Upload PDF"}</button>}
        </div>
        <div className="workgrid">
          <div className="copywrap">
            {hasFile ? (
              <div className="doccard">
                <div className="doccard__icon"><Icon name="file" size={26} /></div>
                <div className="doccard__b">
                  <div style={{ fontSize: 15.5 }}>{c.file}</div>
                  <div className="ey muted">PDF · {c.pages || 2} pages · uploaded by Admin</div>
                </div>
                <button className="chip" onClick={() => QP.toast("Downloading PDF", { sub: c.file, icon: "download" })}><Icon name="download" size={13} /> Download</button>
              </div>
            ) : canManage ? (
              <div className="dropzone" onClick={upload}><Icon name="upload" size={26} /><div style={{ marginTop: 10, fontSize: 15 }}>Upload copywriting PDF</div><div className="ey muted" style={{ marginTop: 6 }}>Drag a .pdf here · added by project admin</div></div>
            ) : (
              <div className="empty"><span className="serif">No copy yet.</span>The copywriting PDF hasn't been uploaded.</div>
            )}

            {hasFile && c.headline && (
              <div className="docpreview">
                <div className="ey" style={{ marginBottom: 12 }}>Preview</div>
                <h2 className="serif">{c.headline}</h2>
                <p>{c.body}</p>
                {c.features && c.features.length > 0 && <ul>{c.features.map((f, i) => <li key={i}>{f}</li>)}</ul>}
              </div>
            )}
            <div className="ey muted" style={{ marginTop: 22, textTransform: "none", letterSpacing: 0, fontSize: 13 }}>Inline copy editing &amp; social-media content delivery — planned.</div>
          </div>
        </div>
      </>
    );
  }
})();
