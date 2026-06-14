/* =====================================================================
   Quincy Portal — Review workspace  →  window.QP.Review
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  const FILTERS = [
    { id: "all", label: "All frames" },
    { id: "pending", label: "To review" },
    { id: "approved", label: "Approved" },
    { id: "flagged", label: "Flagged" },
    { id: "labelled", label: "Hero & selects" },
  ];

  QP.Review = function Review({ project, states, setReview, comments, addComment, persona, onRequestPublish, density }) {
    const { Button } = DS();
    const [coll, setColl] = useState("web");
    const [filter, setFilter] = useState("all");
    const [sel, setSel] = useState(() => new Set());
    const [viewer, setViewer] = useState(null);
    const [compare, setCompare] = useState(false);

    const collection = project.collections.find((c) => c.id === coll);
    const photos = collection.photos;
    const getReview = (id) => states[id] || {};
    const cCount = (id) => (comments[id] || []).length;

    const matches = (p) => {
      const r = getReview(p.id);
      if (filter === "pending") return !r.state;
      if (filter === "approved") return r.state === "approved";
      if (filter === "flagged") return r.state === "flagged";
      if (filter === "labelled") return r.label === "hero" || r.label === "select";
      return true;
    };
    const shown = photos.filter(matches);

    const counts = {
      all: photos.length,
      pending: photos.filter((p) => !getReview(p.id).state).length,
      approved: photos.filter((p) => getReview(p.id).state === "approved").length,
      flagged: photos.filter((p) => getReview(p.id).state === "flagged").length,
      labelled: photos.filter((p) => ["hero", "select"].includes(getReview(p.id).label)).length,
    };

    const toggleSel = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const clearSel = () => setSel(new Set());
    const selectAllShown = () => setSel(new Set(shown.map((p) => p.id)));

    const bulk = (patch) => { sel.forEach((id) => setReview(id, patch)); };
    const bulkApprove = () => { bulk({ state: "approved" }); QP.toast(`${sel.size} frames approved`, { sub: project.street }); clearSel(); };
    const bulkFlag = () => { bulk({ state: "flagged" }); QP.toast(`${sel.size} frames flagged`); clearSel(); };
    const bulkLabel = (id) => { bulk({ label: id }); QP.toast(`Labelled ${sel.size} frames`); };

    const reviewer = persona === "reviewer";

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
            <div className="kv"><span className="k">Guide</span><span className="vv">{QP.fmtAUD(project.price)}</span></div>
          </div>

          <div className="rail__sec">
            <div className="ey" style={{ marginBottom: 12 }}>Collections</div>
            <div className="filterlist">
              {project.collections.map((c) => (
                <div key={c.id} className={cx("frow", coll === c.id && "is-active")} onClick={() => { setColl(c.id); clearSel(); }}>
                  <span className="row gap2"><Icon name={c.id === "floorplan" ? "folder" : "image"} size={15} /> {c.name}</span>
                  <span className="cnt">{c.photos.length}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rail__sec">
            <div className="ey" style={{ marginBottom: 12 }}>Filter</div>
            <div className="filterlist">
              {FILTERS.map((f) => (
                <div key={f.id} className={cx("frow", filter === f.id && "is-active")} onClick={() => setFilter(f.id)}>
                  <span>{f.label}</span><span className="cnt">{counts[f.id]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rail__sec">
            <div className="ey" style={{ marginBottom: 12 }}>Labels</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {QP.LABELS.map((l) => (
                <div key={l.id} className="row gap3" style={{ fontSize: 13.5 }}>
                  <span className="ldot" style={{ background: l.color }} />{l.name}
                  <span className="grow" /><span className="cnt muted">{photos.filter((p) => getReview(p.id).label === l.id).length}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* MAIN ---------------------------------------------------------- */}
        <div className="workmain">
          <div className="worktools">
            <div className="ey" style={{ color: "var(--text-primary)" }}>{collection.name} · {collection.note}</div>
            <span className="prog row gap3" style={{ marginLeft: 8 }}>
              <span className="row gap2"><span className="sdot" style={{ background: "var(--signal-positive)" }} /><b>{counts.approved}</b> approved</span>
              <span className="row gap2"><span className="sdot" style={{ background: "var(--signal-critical)" }} /><b>{counts.flagged}</b> flagged</span>
              <span className="row gap2"><span className="sdot" style={{ background: "var(--greige-400)" }} /><b>{counts.pending}</b> to review</span>
            </span>
            <div className="grow" />
            <button className="chip" onClick={selectAllShown}><Icon name="check" size={13} /> Select all</button>
            <button className="chip" onClick={() => setCompare(true)} disabled={photos.length < 2}><Icon name="compare" size={13} /> Compare</button>
            {reviewer ? (
              <Button variant="primary" size="sm" iconLeft={<Icon name="send" size={14} />}
                onClick={() => QP.toast("Review sent to Quincy Productions", { sub: `${counts.approved} approved · ${counts.flagged} flagged` })}>Submit review</Button>
            ) : (
              <Button variant="primary" size="sm" iconLeft={<Icon name="arrow" size={14} />} onClick={() => onRequestPublish(project)}>Publish to client</Button>
            )}
          </div>

          <div className="workgrid">
            {shown.length === 0
              ? <div className="empty"><span className="serif">All clear.</span>No frames in this filter.</div>
              : (
                <div className="grid" style={{ "--cols": density === "comfortable" ? 3 : density === "dense" ? 5 : 4 }}>
                  {shown.map((p) => (
                    <QP.PhotoTile key={p.id} photo={p} mode="review"
                      selectable selected={sel.has(p.id)} onSelect={() => toggleSel(p.id)}
                      review={getReview(p.id)} comments={cCount(p.id)}
                      onApprove={() => setReview(p.id, (r) => ({ state: r.state === "approved" ? null : "approved" }))}
                      onFlag={() => setReview(p.id, (r) => ({ state: r.state === "flagged" ? null : "flagged" }))}
                      onOpen={() => setViewer(photos.indexOf(p))} />
                  ))}
                </div>
              )}
          </div>
        </div>

        {/* selection action bar */}
        {sel.size > 0 && (
          <div className="actionbar">
            <span className="n">{sel.size}</span><span className="lbl">selected</span>
            <span className="vline" />
            <button className="barbtn barbtn--solid" onClick={bulkApprove}><Icon name="check" size={15} /> Approve</button>
            <button className="barbtn" onClick={bulkFlag}><Icon name="flag" size={15} /> Flag</button>
            <span className="row gap2" style={{ paddingLeft: 4 }}>
              {QP.LABELS.map((l) => <button key={l.id} className="labelpick" title={"Label " + l.name} style={{ width: 22, height: 22, background: l.color }} onClick={() => bulkLabel(l.id)} />)}
            </span>
            <span className="vline" />
            <button className="barbtn" onClick={clearSel}><Icon name="x" size={15} /> Clear</button>
          </div>
        )}

        {/* lightbox */}
        {viewer !== null && (
          <QP.ImageViewer mode="review" project={project} photos={photos} index={viewer}
            onIndex={setViewer} onClose={() => setViewer(null)}
            getReview={getReview} setReview={setReview}
            getComments={(id) => comments[id]} addComment={addComment} readOnly={false} />
        )}

        {/* compare */}
        {compare && <QP.Compare photos={photos} project={project} onClose={() => setCompare(false)} getReview={getReview} setReview={setReview} />}
      </div>
    );
  };
})();
