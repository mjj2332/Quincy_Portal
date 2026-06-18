/* =====================================================================
   Quincy Portal — Photo board (RAW select-for-edit + Edited QA)
   →  window.QP.PhotoBoard   (used inside the project workspace)
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  QP.PhotoBoard = function PhotoBoard({ project, coll, role, states, setReview, comments, addComment, density, onSend }) {
    const { Button } = DS();
    const collection = QP.collOf(project, coll);
    const photos = collection.photos;
    const isRaw = coll === "raw";
    const canSelect = isRaw && role.canSelectForEdit;          // editor/admin pick RAW for autoHDR
    const canQA = coll === "edited" && role.canQAEdited;       // editor/admin approve edited
    const annotateOnly = isRaw && !canSelect;                  // photographer: view + annotate only
    const canRecommend = annotateOnly;                         // photographer recommends frames to QA
    const canMulti = canSelect || canQA || canRecommend;       // who gets multi-select checkboxes
    const caps = { isRaw, canSelect, canQA, canRecommend, canRate: true, canLabel: canQA, annotateOnly };

    const [filter, setFilter] = useState("all");
    const [sel, setSel] = useState(() => new Set());
    const [viewer, setViewer] = useState(null);
    const [compare, setCompare] = useState(false);
    const getReview = (id) => states[id] || {};
    const cCount = (id) => (comments[id] || []).length;

    /* filters differ by collection + role */
    const FILTERS = isRaw
      ? (canSelect
          ? [ { id: "all", label: "All frames" }, { id: "selected", label: "Marked for edit" }, { id: "recommended", label: "Recommended" }, { id: "unselected", label: "Not marked" }, { id: "noted", label: "With notes" } ]
          : [ { id: "all", label: "All frames" }, { id: "recommended", label: "My picks" }, { id: "rated", label: "Rated" }, { id: "noted", label: "With notes" } ])
      : [ { id: "all", label: "All frames" }, { id: "pending", label: "To review" }, { id: "approved", label: "Approved" }, { id: "flagged", label: "Flagged" }, { id: "labelled", label: "Hero & selects" } ];

    const matches = (p) => {
      const r = getReview(p.id);
      if (isRaw) {
        if (filter === "selected") return !!r.selected;
        if (filter === "unselected") return !r.selected;
        if (filter === "recommended") return !!r.pick;
        if (filter === "rated") return (r.rating || 0) > 0;
        if (filter === "noted") return cCount(p.id) > 0;
        return true;
      }
      if (filter === "pending") return !r.state;
      if (filter === "approved") return r.state === "approved";
      if (filter === "flagged") return r.state === "flagged";
      if (filter === "labelled") return ["hero", "select"].includes(r.label);
      return true;
    };
    const shown = photos.filter(matches);
    const cnt = (id) => photos.filter((p) => {
      const r = getReview(p.id);
      if (id === "all") return true;
      if (id === "selected") return !!r.selected;
      if (id === "unselected") return !r.selected;
      if (id === "recommended") return !!r.pick;
      if (id === "rated") return (r.rating || 0) > 0;
      if (id === "noted") return cCount(p.id) > 0;
      if (id === "pending") return !r.state;
      if (id === "approved") return r.state === "approved";
      if (id === "flagged") return r.state === "flagged";
      if (id === "labelled") return ["hero", "select"].includes(r.label);
      return false;
    }).length;

    const selectedForEdit = photos.filter((p) => getReview(p.id).selected).length;
    const recommended = photos.filter((p) => getReview(p.id).pick).length;
    const approved = photos.filter((p) => getReview(p.id).state === "approved").length;
    const flagged = photos.filter((p) => getReview(p.id).state === "flagged").length;
    const pending = photos.length - approved - flagged;

    const toggleSel = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const clearSel = () => setSel(new Set());
    const selectAllShown = () => setSel(new Set(shown.map((p) => p.id)));
    const bulk = (patch) => { sel.forEach((id) => setReview(id, patch)); };

    return (
      <div className="board">
        {/* board toolbar */}
        <div className="worktools">
          <div className="ey" style={{ color: "var(--text-primary)" }}>{collection.name} · {collection.note}</div>
          <span className="prog row gap3" style={{ marginLeft: 8 }}>
            {isRaw ? (
              annotateOnly
                ? <span className="row gap2"><span className="sdot" style={{ background: "var(--signal-caution)" }} /><b>{recommended}</b> recommended · {photos.length} total</span>
                : <span className="row gap2"><span className="sdot" style={{ background: "var(--signal-positive)" }} /><b>{selectedForEdit}</b> marked for edit · {recommended} recommended · {photos.length} total</span>
            ) : (
              <>
                <span className="row gap2"><span className="sdot" style={{ background: "var(--signal-positive)" }} /><b>{approved}</b> approved</span>
                <span className="row gap2"><span className="sdot" style={{ background: "var(--signal-critical)" }} /><b>{flagged}</b> flagged</span>
                <span className="row gap2"><span className="sdot" style={{ background: "var(--greige-400)" }} /><b>{pending}</b> to review</span>
              </>
            )}
          </span>
          <div className="grow" />
          {canMulti && <button className="chip" onClick={selectAllShown}><Icon name="check" size={13} /> Select all</button>}
          <button className="chip" onClick={() => setCompare(true)} disabled={photos.length < 2}><Icon name="compare" size={13} /> Compare</button>
          {canSelect && (
            <Button variant="primary" size="sm" iconLeft={<Icon name="wand" size={14} />}
              onClick={() => onSend && onSend(selectedForEdit)} disabled={selectedForEdit === 0}>
              Send {selectedForEdit} → autoHDR
            </Button>
          )}
        </div>

        {/* annotate-only banner for photographers */}
        {annotateOnly && (
          <div className="boardnote">
            <Icon name="info" size={15} />
            <span>You can review and annotate RAW frames here. Your QA team selects which frames go to editing — your notes guide that choice.</span>
          </div>
        )}

        <div className="workgrid">
          {shown.length === 0
            ? <div className="empty"><span className="serif">All clear.</span>No frames in this filter.</div>
            : (
              <div className="grid" style={{ "--cols": density === "comfortable" ? 3 : density === "dense" ? 5 : 4 }}>
                {shown.map((p) => (
                  <QP.PhotoTile key={p.id} photo={p} mode={isRaw ? "raw" : "review"} caps={caps}
                    selectable={canMulti} selected={sel.has(p.id)} onSelect={() => toggleSel(p.id)}
                    review={getReview(p.id)} comments={cCount(p.id)}
                    onApprove={() => canQA && setReview(p.id, (r) => ({ state: r.state === "approved" ? null : "approved" }))}
                    onFlag={() => canQA && setReview(p.id, (r) => ({ state: r.state === "flagged" ? null : "flagged" }))}
                    onPick={() => canSelect && setReview(p.id, (r) => ({ selected: !r.selected }))}
                    onRecommend={() => canRecommend && setReview(p.id, (r) => ({ pick: !r.pick }))}
                    onOpen={() => setViewer(photos.indexOf(p))} />
                ))}
              </div>
            )}
        </div>

        {/* bulk action bar */}
        {sel.size > 0 && (
          <div className="actionbar">
            <span className="n">{sel.size}</span><span className="lbl">selected</span>
            <span className="vline" />
            {canRecommend && <>
              <button className="barbtn barbtn--solid" onClick={() => { bulk({ pick: true }); QP.toast(`${sel.size} frames recommended to QA`); clearSel(); }}><Icon name="star" size={15} /> Recommend</button>
              <button className="barbtn" onClick={() => { bulk({ pick: false }); clearSel(); }}><Icon name="x" size={15} /> Unmark</button>
            </>}
            {canSelect && <>
              <button className="barbtn barbtn--solid" onClick={() => { bulk({ selected: true }); QP.toast(`${sel.size} frames marked for editing`); clearSel(); }}><Icon name="check" size={15} /> Mark for edit</button>
              <button className="barbtn" onClick={() => { bulk({ selected: false }); clearSel(); }}><Icon name="x" size={15} /> Unmark</button>
            </>}
            {canQA && <>
              <button className="barbtn barbtn--solid" onClick={() => { bulk({ state: "approved" }); QP.toast(`${sel.size} frames approved`); clearSel(); }}><Icon name="check" size={15} /> Approve</button>
              <button className="barbtn" onClick={() => { bulk({ state: "flagged" }); QP.toast(`${sel.size} frames flagged`); clearSel(); }}><Icon name="flag" size={15} /> Flag</button>
              <span className="row gap2" style={{ paddingLeft: 4 }}>
                {QP.LABELS.map((l) => <button key={l.id} className="labelpick" title={"Label " + l.name} style={{ width: 22, height: 22, background: l.color }} onClick={() => { bulk({ label: l.id }); QP.toast(`Labelled ${sel.size} frames`); }} />)}
              </span>
            </>}
            <span className="vline" />
            <button className="barbtn" onClick={() => { QP.toast(`Downloading ${sel.size} ${sel.size === 1 ? "frame" : "frames"}`, { sub: `${collection.name} · .zip`, icon: "download" }); clearSel(); }}><Icon name="download" size={15} /> Download</button>
            <button className="barbtn" onClick={clearSel}><Icon name="x" size={15} /> Clear</button>
          </div>
        )}

        {/* lightbox */}
        {viewer !== null && (
          <QP.ImageViewer mode="review" caps={caps} project={project} photos={photos} index={viewer}
            onIndex={setViewer} onClose={() => setViewer(null)}
            getReview={getReview} setReview={setReview}
            getComments={(id) => comments[id]} addComment={addComment} />
        )}
        {compare && <QP.Compare photos={photos} project={project} caps={caps} onClose={() => setCompare(false)} getReview={getReview} setReview={setReview} />}
      </div>
    );
  };
})();
