/* =====================================================================
   Quincy Portal — shared UI atoms  →  window.QP
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState, useEffect, useRef } = React;
  const Icon = QP.Icon;
  const cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  /* ---- status badge -------------------------------------------------- */
  QP.StatusBadge = function StatusBadge({ status, style }) {
    const { Badge } = DS();
    const meta = QP.STATUS[status];
    return (
      <span className="row gap2" style={style}>
        <span className="sdot" style={{ background: meta.dot }} />
        {Badge ? <Badge variant="outline" tone={meta.tone}>{meta.label}</Badge>
               : <span className="ey">{meta.label}</span>}
      </span>
    );
  };

  /* ---- read-only star row -------------------------------------------- */
  QP.Stars = function Stars({ value = 0, size = 14, className = "tstars" }) {
    if (!value) return null;
    return (
      <span className={className}>
        {[1,2,3,4,5].map((i) => (
          <span key={i} className={i <= value ? "on" : "off"}><Icon name="star" size={size} fill={i <= value ? "currentColor" : "none"} /></span>
        ))}
      </span>
    );
  };

  /* ---- label dot ----------------------------------------------------- */
  QP.LabelDot = function LabelDot({ id, size = 9, style }) {
    const l = QP.labelById(id); if (!l) return null;
    return <span className="ldot" title={l.name} style={{ background: l.color, width: size, height: size, ...style }} />;
  };

  /* ---- floorplan schematic placeholder ------------------------------- */
  function FloorplanArt() {
    return (
      <svg viewBox="0 0 300 200" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"
           style={{ background: "var(--paper-100)" }} stroke="var(--ink-900)" fill="none" strokeWidth="1.4">
        <rect x="24" y="24" width="252" height="152" />
        <path d="M24 96h120M144 24v72M144 96v80M144 130h132M210 96v34M24 150h120" />
        <rect x="40" y="40" width="34" height="22" strokeWidth="1" />
        <path d="M180 24v18a18 18 0 0 0 18 18" strokeWidth="1" />
        <circle cx="100" cy="150" r="2" /><circle cx="60" cy="120" r="2" />
        <text x="70" y="80" fontSize="9" fill="var(--greige-500)" stroke="none" fontFamily="var(--font-sans)" letterSpacing="1.5">LIVING</text>
        <text x="190" y="116" fontSize="9" fill="var(--greige-500)" stroke="none" fontFamily="var(--font-sans)" letterSpacing="1.5">BED 1</text>
      </svg>
    );
  }
  QP.FloorplanArt = FloorplanArt;

  /* ===================================================================
     PHOTO TILE — the shared grid cell (review + client + plain)
     =================================================================== */
  QP.PhotoTile = function PhotoTile(props) {
    const {
      photo, mode = "plain", onOpen, caps = {},
      // review
      selectable, selected, onSelect, review, comments = 0, onApprove, onFlag, onPick, onRecommend,
      // client
      fav, onFav, onQuickDownload, locked,
      showCaption = true,
    } = props;

    const st = review?.state;
    const pickedForEdit = mode === "raw" && review?.selected;
    const cls = cx(
      "tile",
      selected && "is-selected",
      st === "approved" && "st-approved",
      st === "flagged" && "st-flagged",
      pickedForEdit && "st-approved",
      (st || pickedForEdit) && "has-state",
      review?.rating && "has-rating",
      mode === "review" && st === "flagged" && "is-dim",
      locked && "is-locked",
    );

    return (
      <div className={cls} onClick={onOpen} role="button" tabIndex={0}
           onKeyDown={(e) => { if (e.key === "Enter") onOpen && onOpen(); }}>
        {/* placeholder so the layout reads even before the image paints */}
        <div className="tile__ph"><img src={QP.res("qpWhite", "assets/logos/quincy-qp-white.png")} alt="" /></div>
        {photo.floorplan
          ? <FloorplanArt />
          : <img loading="lazy" src={photo.src} alt={photo.cap} style={{ objectPosition: photo.pos }} />}
        <div className="tile__scrim" />

        {/* premium paywall watermark (client) */}
        {locked && (
          <>
            <div className="wmark" aria-hidden="true"><span>QUINCY · PREVIEW</span><span>QUINCY · PREVIEW</span><span>QUINCY · PREVIEW</span></div>
            <span className="lockbadge"><Icon name="lock" size={12} /> {photo.price ? QP.fmtAUD(photo.price) : "Premium"}</span>
          </>
        )}

        {!selectable && mode === "review" && <span className="tile__num">{String(photo.n).padStart(2, "0")}</span>}
        {!selectable && mode === "raw" && <span className="tile__num">{String(photo.n).padStart(2, "0")}</span>}

        {selectable && (
          <button className="selbox" onClick={(e) => { e.stopPropagation(); onSelect && onSelect(); }} aria-label="Select">
            <Icon name="check" size={13} />
          </button>
        )}

        {/* hover / state tools */}
        <div className="tile__tools">
          {mode === "review" && caps.canQA !== false && (
            <>
              <button className={cx("icbtn", "icbtn--ondark")} title="Approve (A)"
                      onClick={(e) => { e.stopPropagation(); onApprove && onApprove(); }}
                      style={st === "approved" ? { background: "var(--signal-positive)", borderColor: "var(--signal-positive)" } : null}>
                <Icon name="check" size={15} />
              </button>
              <button className={cx("icbtn", "icbtn--ondark")} title="Flag (X)"
                      onClick={(e) => { e.stopPropagation(); onFlag && onFlag(); }}
                      style={st === "flagged" ? { background: "var(--signal-critical)", borderColor: "var(--signal-critical)" } : null}>
                <Icon name="x" size={15} />
              </button>
            </>
          )}
          {mode === "raw" && caps.canSelect && (
            <button className={cx("icbtn", "icbtn--ondark")} title="Mark for editing"
                    onClick={(e) => { e.stopPropagation(); onPick && onPick(); }}
                    style={pickedForEdit ? { background: "var(--signal-positive)", borderColor: "var(--signal-positive)" } : null}>
              <Icon name="check" size={15} />
            </button>
          )}
          {mode === "raw" && caps.canRecommend && (
            <button className={cx("icbtn", "icbtn--ondark")} title="Recommend to QA"
                    onClick={(e) => { e.stopPropagation(); onRecommend && onRecommend(); }}
                    style={review?.pick ? { background: "var(--signal-caution)", borderColor: "var(--signal-caution)" } : null}>
              <Icon name="star" size={15} fill={review?.pick ? "currentColor" : "none"} />
            </button>
          )}
          {mode === "client" && (
            <>
              <button className={cx("icbtn", "icbtn--ondark", "tile__heart", fav && "is-on")} title="Favourite"
                      onClick={(e) => { e.stopPropagation(); onFav && onFav(); }}>
                <Icon name="heart" size={15} fill={fav ? "currentColor" : "none"} />
              </button>
              <button className="icbtn icbtn--ondark" title={locked ? "Unlock" : "Download"} onClick={(e) => { e.stopPropagation(); onQuickDownload && onQuickDownload(); }}>
                <Icon name={locked ? "lock" : "download"} size={15} />
              </button>
            </>
          )}
        </div>

        {/* label dot */}
        {review?.label && <QP.LabelDot id={review.label} style={{ position: "absolute", top: 13, left: selectable ? 40 : 13, zIndex: 3 }} />}

        {/* comment bubble */}
        {comments > 0 && (
          <span className="cbubble" style={{ position: "absolute", top: 9, left: selectable ? 40 : 11, zIndex: 3 }}>
            <Icon name="comment" size={12} />{comments}
          </span>
        )}

        {/* state tag */}
        {mode === "review" && st && (
          <span className={cx("statetag", "st-" + st)}>
            <Icon name={st === "approved" ? "check" : "flag"} size={12} />{st === "approved" ? "Approved" : "Flagged"}
          </span>
        )}
        {mode === "raw" && pickedForEdit && (
          <span className="statetag st-approved"><Icon name="wand" size={12} /> For edit</span>
        )}
        {mode === "raw" && review?.pick && !pickedForEdit && (
          <span className="statetag" style={{ background: "color-mix(in srgb, var(--signal-caution) 82%, #000)" }}><Icon name="star" size={12} fill="currentColor" /> Recommended</span>
        )}

        {review?.rating ? <QP.Stars value={review.rating} /> : null}

        {showCaption && !photo.floorplan && <span className="tile__cap">{photo.cap}</span>}
      </div>
    );
  };

  /* ===================================================================
     MODAL
     =================================================================== */
  QP.Modal = function Modal({ title, eyebrow, children, footer, onClose, wide }) {
    useEffect(() => {
      const fn = (e) => { if (e.key === "Escape") onClose && onClose(); };
      window.addEventListener("keydown", fn); return () => window.removeEventListener("keydown", fn);
    }, [onClose]);
    return (
      <div className="scrim" onClick={onClose}>
        <div className={cx("modal", wide && "modal--wide")} onClick={(e) => e.stopPropagation()}>
          <div className="modal__head">
            {eyebrow && <div className="ey" style={{ marginBottom: 10 }}>{eyebrow}</div>}
            <h3 className="serif">{title}</h3>
          </div>
          <div className="modal__body">{children}</div>
          {footer && <div className="modal__foot">{footer}</div>}
        </div>
      </div>
    );
  };

  /* ===================================================================
     TOASTS — tiny pub/sub
     =================================================================== */
  const listeners = new Set();
  QP.toast = (msg, opts = {}) => listeners.forEach((l) => l(msg, opts));
  QP.ToastHost = function ToastHost() {
    const [items, setItems] = useState([]);
    useEffect(() => {
      const fn = (msg, opts) => {
        const id = Math.random().toString(36).slice(2);
        setItems((x) => [...x, { id, msg, sub: opts.sub, icon: opts.icon || "check" }]);
        setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), opts.duration || 3400);
      };
      listeners.add(fn); return () => listeners.delete(fn);
    }, []);
    return (
      <div className="toasts">
        {items.map((t) => (
          <div className="toast" key={t.id}>
            <Icon name={t.icon} size={17} />
            <div><div>{t.msg}</div>{t.sub && <div className="sub">{t.sub}</div>}</div>
          </div>
        ))}
      </div>
    );
  };

  /* ===================================================================
     PERSONA / PROTOTYPE SWITCH
     =================================================================== */
  QP.PersonaSwitch = function PersonaSwitch({ persona, setPersona }) {
    const opts = [
      { id: "admin", label: "Admin" },
      { id: "photographer", label: "Photographer" },
      { id: "editor", label: "Editor / QA" },
      { id: "client", label: "Client" },
    ];
    return (
      <div className="persona">
        <span className="persona__lbl">Prototype<br/>View as</span>
        <div className="persona__opts">
          {opts.map((o) => (
            <button key={o.id} className={persona === o.id ? "is-on" : ""} onClick={() => setPersona(o.id)}>{o.label}</button>
          ))}
        </div>
      </div>
    );
  };

  /* ---- small spinner / prep bar ------------------------------------- */
  QP.PrepBar = function PrepBar({ pct }) {
    return <div className="zipbar"><i style={{ width: pct + "%" }} /></div>;
  };
})();
