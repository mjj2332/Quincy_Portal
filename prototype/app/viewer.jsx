/* =====================================================================
   Quincy Portal — image viewer (lightbox), pins, compare  →  window.QP
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState, useEffect, useRef } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  function timeAgo(iso) {
    const d = new Date(iso), now = new Date("2026-06-18T12:00:00");
    const days = Math.round((now - d) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    return days + " days ago";
  }

  /* ===================================================================
     IMAGE VIEWER
     =================================================================== */
  QP.ImageViewer = function ImageViewer(props) {
    const {
      mode = "client", photos, index, onIndex, onClose, project, caps = {},
      getReview, setReview,                 // review
      getComments, addComment,              // review
      favs, onFav, onDownload, onOrder, isLocked,     // client
    } = props;
    const { Button } = DS();
    const photo = photos[index];
    const lockedNow = mode === "client" && isLocked ? isLocked(photo) : false;
    const [panelOpen, setPanelOpen] = useState(false);
    const [draft, setDraft] = useState("");
    // freehand markup
    const [markup, setMarkup] = useState(false);
    const [tool, setTool] = useState({ color: "#e64b3c", width: 4 });
    const [strokes, setStrokes] = useState([]);   // current editable drawing, points normalized 0–100
    const frameRef = useRef(null);
    const drawingRef = useRef(false);

    const review = mode === "review" ? (getReview(photo.id) || {}) : null;
    const comments = mode === "review" ? (getComments(photo.id) || []) : [];

    const go = (d) => { const n = (index + d + photos.length) % photos.length; onIndex(n); setStrokes([]); };

    useEffect(() => {
      const fn = (e) => {
        if (e.target.tagName === "TEXTAREA") return;
        if (e.key === "Escape") { if (markup) { setMarkup(false); setStrokes([]); return; } return onClose(); }
        if (mode === "review" && markup && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); return setStrokes((s) => s.slice(0, -1)); }
        if (e.key === "ArrowLeft") return go(-1);
        if (e.key === "ArrowRight") return go(1);
        if (mode === "review") {
          if (caps.canQA && e.key.toLowerCase() === "a") setReview(photo.id, (r) => ({ state: r.state === "approved" ? null : "approved" }));
          if (caps.canQA && e.key.toLowerCase() === "x") setReview(photo.id, (r) => ({ state: r.state === "flagged" ? null : "flagged" }));
          if (caps.canSelect && e.key.toLowerCase() === "e") setReview(photo.id, (r) => ({ selected: !r.selected }));
          if (caps.canRecommend && e.key.toLowerCase() === "r") setReview(photo.id, (r) => ({ pick: !r.pick }));
          if ("12345".includes(e.key)) setReview(photo.id, { rating: +e.key });
        }
        if (mode === "client" && e.key.toLowerCase() === "f") onFav(photo.id);
      };
      window.addEventListener("keydown", fn);
      return () => window.removeEventListener("keydown", fn);
    });

    function ptFrom(e) {
      const r = frameRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
      const y = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
      return { x: +x.toFixed(2), y: +y.toFixed(2) };
    }
    function drawDown(e) { if (!markup) return; e.preventDefault(); drawingRef.current = true; const p = ptFrom(e); setStrokes((s) => [...s, { color: tool.color, width: tool.width, points: [p] }]); try { e.target.setPointerCapture(e.pointerId); } catch (x) {} }
    function drawMove(e) { if (!markup || !drawingRef.current) return; const p = ptFrom(e); setStrokes((s) => { if (!s.length) return s; const n = s.slice(); const last = n[n.length - 1]; n[n.length - 1] = { ...last, points: [...last.points, p] }; return n; }); }
    function drawUp() { drawingRef.current = false; }
    const undo = () => setStrokes((s) => s.slice(0, -1));
    const clearDraw = () => setStrokes([]);

    function submitComment() {
      const hasDraw = strokes.length > 0;
      if (!draft.trim() && !hasDraw) return;
      addComment(photo.id, { text: draft.trim() || "Marked up the frame", drawing: hasDraw ? strokes : null });
      setDraft(""); setStrokes([]); setMarkup(false);
    }

    const savedDrawings = mode === "review" ? comments.filter((c) => c.drawing && c.drawing.length) : [];
    const pins = comments.filter((c) => c.pin);
    const ptsStr = (pts) => pts.map((p) => `${p.x},${p.y}`).join(" ");

    return (
      <div className={cx("viewer")} style={mode === "client" ? { "--panel": "360px" } : null}>
        <div className="viewer__stage">
          <button className="icbtn icbtn--ondark viewer__close" onClick={onClose} title="Close (Esc)"><Icon name="x" size={18} /></button>
          <div className="viewer__meta">
            <div className="a serif">{project.street}</div>
            <div className="b">{photo.cap} · {String(photo.n).padStart(2,"0")} / {photos.length}</div>
          </div>

          <button className="icbtn icbtn--lg icbtn--ondark viewer__nav prev" onClick={() => go(-1)}><Icon name="left" size={20} /></button>
          <button className="icbtn icbtn--lg icbtn--ondark viewer__nav next" onClick={() => go(1)}><Icon name="right" size={20} /></button>

          <div className="viewer__imgwrap">
            <div className={cx("canvasframe", photo.floorplan && "is-plan")} ref={frameRef}>
              {photo.floorplan
                ? <QP.FloorplanArt />
                : <img className="viewer__img" src={photo.src} alt={photo.cap} style={{ objectPosition: photo.pos }} />}
              {lockedNow && <div className="wmark wmark--lg" aria-hidden="true"><span>QUINCY · PREVIEW</span><span>QUINCY · PREVIEW</span><span>QUINCY · PREVIEW</span><span>QUINCY · PREVIEW</span></div>}
              <svg className="markup-svg" viewBox="0 0 100 100" preserveAspectRatio="none"
                   style={{ pointerEvents: markup ? "auto" : "none", cursor: markup ? "crosshair" : "default", touchAction: "none" }}
                   onPointerDown={drawDown} onPointerMove={drawMove} onPointerUp={drawUp} onPointerLeave={drawUp}>
                {savedDrawings.map((c) => c.drawing.map((st, j) => (
                  st.points.length < 2
                    ? <circle key={c.id + "-" + j} cx={st.points[0].x} cy={st.points[0].y} r={(st.width || 4) / 3} fill={st.color} opacity="0.8" />
                    : <polyline key={c.id + "-" + j} points={ptsStr(st.points)} fill="none" stroke={st.color} strokeWidth={st.width} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" opacity="0.82" />
                )))}
                {strokes.map((st, j) => (
                  st.points.length < 2
                    ? <circle key={"cur" + j} cx={st.points[0].x} cy={st.points[0].y} r={(st.width || 4) / 3} fill={st.color} />
                    : <polyline key={"cur" + j} points={ptsStr(st.points)} fill="none" stroke={st.color} strokeWidth={st.width} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
                ))}
              </svg>
              {/* legacy pins */}
              {mode === "review" && pins.map((c, i) => (
                <span key={c.id} className="pin" style={{ left: c.pin.x + "%", top: c.pin.y + "%" }} title={c.text}>{i + 1}</span>
              ))}
            </div>
          </div>

          {/* mobile panel toggle */}
          <button className="icbtn icbtn--ondark" style={{ position: "absolute", top: 16, right: 16, zIndex: 5 }}
                  onClick={() => setPanelOpen((o) => !o)}>
            <Icon name={mode === "review" ? "comment" : "info"} size={17} />
          </button>

          {/* markup toolbar */}
          {mode === "review" && markup && (
            <div className="drawbar">
              <span className="drawbar__lbl">Markup</span>
              <span className="drawbar__grp">
                {["#e64b3c", "#f0a020", "#3f8f5a", "#2f6df0", "#ffffff", "#0a0a0a"].map((c) => (
                  <button key={c} className={cx("swatch", tool.color === c && "on")} style={{ background: c }} onClick={() => setTool((t) => ({ ...t, color: c }))} />
                ))}
              </span>
              <span className="drawbar__grp">
                {[2, 4, 7].map((w) => (
                  <button key={w} className={cx("wbtn", tool.width === w && "on")} onClick={() => setTool((t) => ({ ...t, width: w }))}><span style={{ width: w + 3, height: w + 3 }} /></button>
                ))}
              </span>
              <button className="barbtn" onClick={undo}><Icon name="undo" size={14} /> Undo</button>
              <button className="barbtn" onClick={clearDraw}><Icon name="x" size={14} /> Clear</button>
              <button className="barbtn barbtn--solid" style={{ color: "var(--ink-900)" }} onClick={() => setPanelOpen(true)}><Icon name="send" size={13} /> Add note</button>
            </div>
          )}
        </div>

        {/* filmstrip */}
        <div className={cx("strip")}>
          {photos.map((p, i) => (
            <img key={p.id} className={cx("strip__t", i === index && "is-active")} src={p.floorplan ? QP.res("qpWhite", "assets/logos/quincy-qp-white.png") : p.src}
                 style={p.floorplan ? { objectFit: "contain", padding: 14, background: "var(--ink-700)" } : { objectPosition: p.pos }}
                 onClick={() => onIndex(i)} alt="" loading="lazy" />
          ))}
        </div>

        {/* side panel */}
        <div className={cx("vpanel", panelOpen && "open")}>
          {mode === "review" ? (
            <ReviewPanel {...{ photo, review, setReview, comments, draft, setDraft, markup, setMarkup, hasDrawing: strokes.length > 0, clearDraw, submitComment, caps }} />
          ) : (
            <ClientPanel {...{ photo, project, fav: favs[photo.id], onFav, onDownload, onOrder, locked: lockedNow }} />
          )}
        </div>
      </div>
    );
  };

  /* ---- review side panel --------------------------------------------- */
  function ReviewPanel({ photo, review, setReview, comments, draft, setDraft, markup, setMarkup, hasDrawing, clearDraw, submitComment, caps = {} }) {
    return (
      <>
        <div className="vpanel__head">
          <div className="ey" style={{ marginBottom: 8 }}>{photo.coll} · frame {String(photo.n).padStart(2,"0")}</div>
          <div className="vpanel__addr serif">{photo.cap}</div>
        </div>
        <div className="vpanel__scroll">
          {/* decision — RAW select-for-edit */}
          {caps.canSelect && (
            <div className="vpanel__sec">
              <div className="eylab">For editing</div>
              {review.pick && <div className="row gap2" style={{ marginBottom: 10, color: "var(--signal-caution)", fontSize: 13 }}><Icon name="star" size={13} fill="currentColor" /> Recommended by photographer</div>}
              <button className={cx("dbtn", "on-approve", review.selected && "is-on")} style={{ width: "100%" }}
                      onClick={() => setReview(photo.id, (r) => ({ selected: !r.selected }))}>
                <Icon name={review.selected ? "check2" : "wand"} size={16} /> {review.selected ? "Marked for editing" : "Mark for editing"}
              </button>
              <div className="ey" style={{ marginTop: 10, color: "var(--text-muted)" }}>Shortcut · E · selected RAW frames go to autoHDR</div>
            </div>
          )}

          {/* recommend (photographer) */}
          {caps.canRecommend && (
            <div className="vpanel__sec">
              <div className="eylab">Recommend</div>
              <button className={cx("dbtn", review.pick && "is-on")} style={{ width: "100%", ...(review.pick ? { background: "var(--signal-caution)", borderColor: "var(--signal-caution)", color: "#fff" } : {}) }}
                      onClick={() => setReview(photo.id, (r) => ({ pick: !r.pick }))}>
                <Icon name="star" size={16} fill={review.pick ? "currentColor" : "none"} /> {review.pick ? "Recommended to QA" : "Recommend to QA"}
              </button>
              <div className="ey" style={{ marginTop: 10, color: "var(--text-muted)" }}>Shortcut · R · flags this frame as your pick for editing</div>
            </div>
          )}

          {/* annotate-only note for photographers */}
          {caps.annotateOnly && (
            <div className="vpanel__sec">
              <div className="eylab">Your frame</div>
              <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.5 }}>Recommend your picks and leave notes &amp; markup to guide selection. QA decides which frames go to editing.</div>
            </div>
          )}

          {/* decision — Edited QA */}
          {caps.canQA && (
            <div className="vpanel__sec">
              <div className="eylab">Decision</div>
              <div className="decide">
                <button className={cx("dbtn", "on-approve", review.state === "approved" && "is-on")}
                        onClick={() => setReview(photo.id, (r) => ({ state: r.state === "approved" ? null : "approved" }))}>
                  <Icon name="check" size={16} /> Approve
                </button>
                <button className={cx("dbtn", "on-flag", review.state === "flagged" && "is-on")}
                        onClick={() => setReview(photo.id, (r) => ({ state: r.state === "flagged" ? null : "flagged" }))}>
                  <Icon name="flag" size={16} /> Flag
                </button>
              </div>
              <div className="ey" style={{ marginTop: 10, color: "var(--text-muted)" }}>Shortcut · A approve · X flag</div>
            </div>
          )}

          {/* rating */}
          <div className="vpanel__sec">
            <div className="eylab">Rating</div>
            <div className="starpick">
              {[1,2,3,4,5].map((i) => (
                <button key={i} className={i <= (review.rating || 0) ? "on" : ""} onClick={() => setReview(photo.id, { rating: review.rating === i ? 0 : i })}>
                  <Icon name="star" size={22} fill={i <= (review.rating || 0) ? "currentColor" : "none"} />
                </button>
              ))}
            </div>
          </div>

          {/* labels (QA only) */}
          {caps.canLabel && (
            <div className="vpanel__sec">
              <div className="eylab">Label</div>
              <div className="labels">
                {QP.LABELS.map((l) => (
                  <button key={l.id} className={cx("labelpick", review.label === l.id && "is-on")} title={l.name}
                          style={{ background: l.color }} onClick={() => setReview(photo.id, (r) => ({ label: r.label === l.id ? null : l.id }))} />
                ))}
              </div>
            </div>
          )}

          {/* notes & markup */}
          <div className="vpanel__sec">
            <div className="eylab" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Notes &amp; markup · {comments.length}</span>
              <button className={cx("chip", markup && "is-active")} style={{ padding: "5px 11px" }} onClick={() => setMarkup((m) => !m)}>
                <Icon name="pen" size={13} /> {markup ? "Drawing…" : "Draw"}
              </button>
            </div>
            {markup && <div className="ey" style={{ marginTop: 10, color: "var(--text-muted)", textTransform: "none", letterSpacing: 0, fontSize: 13 }}>Draw directly on the frame with the toolbar, then add a note and send.</div>}
            <div className="thread" style={{ marginTop: 14 }}>
              {comments.length === 0 && <div className="muted" style={{ fontSize: 14 }}>No notes yet. Hit <strong style={{ color: "var(--text-primary)" }}>Draw</strong> to mark up the frame, or just leave a note.</div>}
              {comments.map((c, i) => (
                <div className="cmt" key={c.id}>
                  <div className={cx("cmt__pin", !(c.pin || c.drawing) && "unpinned")}
                       style={c.drawing ? { background: (c.drawing[0] && c.drawing[0].color) || "var(--ink-900)", color: "#fff" } : null}>
                    {c.drawing ? <Icon name="pen" size={11} /> : c.pin ? i + 1 : <Icon name="comment" size={11} />}
                  </div>
                  <div className="cmt__b">
                    <div className="cmt__who">{c.who}<span>{c.role}</span></div>
                    <div className="cmt__txt">{c.text}</div>
                    {c.drawing && <div className="ey" style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)" }}><Icon name="pen" size={11} /> Markup on frame</div>}
                    <div className="ey" style={{ marginTop: 6, color: "var(--text-muted)" }}>{timeAgo(c.at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* composer */}
        <div className="composer">
          {hasDrawing && <div className="hint"><Icon name="pen" size={13} /> Markup attached · <button className="chip" style={{ padding: "3px 8px" }} onClick={clearDraw}>clear</button></div>}
          <textarea placeholder={markup ? "Describe your markup…" : "Add a note…"} value={draft} onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitComment(); }} />
          <div className="spread">
            <span className="ey muted">⌘↵ to send</span>
            <button className="barbtn barbtn--solid" style={{ color: "var(--ink-900)" }} onClick={submitComment}><Icon name="send" size={14} /> Send note</button>
          </div>
        </div>
      </>
    );
  }

  /* ---- client side panel --------------------------------------------- */
  function ClientPanel({ photo, project, fav, onFav, onDownload, onOrder, locked }) {
    const coll = project.collections.find((c) => c.id === photo.coll);
    const total = coll && coll.photos ? coll.photos.length : 0;
    return (
      <>
        <div className="vpanel__head">
          <div className="ey" style={{ marginBottom: 8 }}>{project.suburb} · {photo.coll}</div>
          <div className="vpanel__addr serif">{photo.cap}</div>
        </div>
        <div className="vpanel__scroll">
          <div className="vpanel__sec">
            <div className="eylab">This frame</div>
            <div className="kv"><span className="k">Frame</span><span className="vv">{String(photo.n).padStart(2,"0")} / {total}</span></div>
            <div className="kv"><span className="k">Collection</span><span className="vv" style={{ textTransform: "capitalize" }}>{photo.coll}</span></div>
            <div className="kv"><span className="k">Resolution</span><span className="vv">6048 × 4032</span></div>
          </div>
          <div className="vpanel__sec" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {locked ? (
              <>
                <div className="lockcard">
                  <Icon name="lock" size={16} /><div><div style={{ fontSize: 13.5 }}>Premium frame</div><div className="ey muted">Watermarked preview · unlock to download</div></div>
                </div>
                <button className="dbtn" onClick={() => onOrder(photo)} style={{ background: "var(--ink-900)", color: "var(--paper-050)", borderColor: "var(--ink-900)" }}>
                  <Icon name="unlock" size={16} /> Unlock {photo.price ? "— " + QP.fmtAUD(photo.price) : ""}
                </button>
              </>
            ) : (
              <button className="dbtn" onClick={() => onDownload(photo)}><Icon name="download" size={16} /> Download this frame</button>
            )}
            <button className="dbtn" onClick={() => onFav(photo.id)} style={fav ? { background: "var(--ink-900)", color: "var(--paper-050)", borderColor: "var(--ink-900)" } : null}>
              <Icon name="heart" size={16} fill={fav ? "currentColor" : "none"} /> {fav ? "Favourited" : "Add to favourites"}
            </button>
          </div>
          <div className="vpanel__sec">
            <div className="eylab">Shoot</div>
            <div className="kv"><span className="k">Photographer</span><span className="vv">{project.photographer}</span></div>
            <div className="kv"><span className="k">Captured</span><span className="vv">{QP.fmtShort(project.shoot)}</span></div>
            <div className="kv"><span className="k">Studio</span><span className="vv">Quincy Productions</span></div>
          </div>
        </div>
      </>
    );
  }

  /* ===================================================================
     COMPARE — two frames side by side
     =================================================================== */
  QP.Compare = function Compare({ photos, project, onClose, getReview, setReview, caps = {} }) {
    const isRaw = caps.isRaw;
    const pick = (id) => { if (!setReview) return; if (isRaw) setReview(id, { selected: true }); else setReview(id, { state: "approved" }); };
    const [a, setA] = useState(0);
    const [b, setB] = useState(Math.min(1, photos.length - 1));
    const [picking, setPicking] = useState(null); // which side to re-pick
    const Cell = ({ i, tag, onPick }) => {
      const p = photos[i]; const r = getReview ? getReview(p.id) || {} : {};
      return (
        <div className="compare__cell">
          <div className="compare__tag">{tag} · {p.cap}</div>
          {p.floorplan ? <div style={{ width: "60%" }}><QP.FloorplanArt /></div>
                       : <img src={p.src} alt={p.cap} style={{ objectPosition: p.pos }} />}
          <div style={{ position: "absolute", top: 16, right: 16 }}><QP.Stars value={r.rating} /></div>
          <button className="barbtn barbtn--solid compare__pickbtn"
                  onClick={onPick} style={{ color: "var(--ink-900)" }}>
            <Icon name={isRaw ? "wand" : "check"} size={14} /> {isRaw ? "Mark for edit" : "Pick this one"}
          </button>
        </div>
      );
    };
    return (
      <div className="compare">
        <div className="worktools" style={{ background: "var(--ink-900)", borderColor: "rgba(246,244,239,.12)", color: "var(--paper-050)", position: "static" }}>
          <button className="icbtn icbtn--ondark" onClick={onClose}><Icon name="x" size={18} /></button>
          <div className="ey" style={{ color: "var(--text-on-inverse-muted)" }}>Compare · {project.street}</div>
          <div className="grow" />
          <div className="segment" style={{ background: "transparent" }}>
            <button onClick={() => { const n = (a + 1) % photos.length; setA(n); }} style={{ color: "var(--paper-050)" }}>Cycle left</button>
            <button onClick={() => { const n = (b + 1) % photos.length; setB(n); }} style={{ color: "var(--paper-050)" }}>Cycle right</button>
          </div>
        </div>
        <div className="compare__pair">
          <Cell i={a} tag="A" onPick={() => { pick(photos[a].id); QP.toast(isRaw ? "Frame A marked for edit" : "Frame A approved", { sub: photos[a].cap }); }} />
          <Cell i={b} tag="B" onPick={() => { pick(photos[b].id); QP.toast(isRaw ? "Frame B marked for edit" : "Frame B approved", { sub: photos[b].cap }); }} />
        </div>
      </div>
    );
  };
})();
