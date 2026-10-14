/* Delivery page film tiles — the guest collection tile (D21, D22) in paper colours, on the public Delivery page (D30–D37).
   Live: tap a tile (opens the review in this tab — a toast here; in Preview it plays in a plain player), ⋯ for Download original,
   tap a locked Premium tile to request an unlock. */
const D_FILMS = [
  { id: "d1", title: "14 Harbour St, Mosman — Hero film", o: "landscape", v: 3, dur: "1:32", open: 2 },
  { id: "d2", title: "Harbour St — Social cut 9:16", o: "portrait", v: 2, dur: "0:30", open: 0 },
  { id: "d3", title: "Harbour St — Agent walkthrough", o: "landscape", v: 1, dur: "2:48", open: 1 },
  { id: "d4", title: "Harbour St — Twilight teaser", o: "portrait", locked: true },
];

const dOnPoster = { position: "absolute", display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 4, background: "rgba(10,10,10,.7)", color: "#fff", fontSize: 12 };

const LockIcon = ({ size = 22 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>;

const PremiumBadge = () => <span style={{ display: "inline-flex", alignItems: "center", padding: "1px 6px", borderRadius: 4, background: "var(--ink-900)", color: "var(--paper-050)", fontSize: 12 }}>Premium</span>;

function DPoster({ f, preview }) {
  if (f.locked) return <div style={{ position: "relative", aspectRatio: "16 / 9", background: "var(--greige-100, #EFEBE2)", borderRadius: "8px 8px 0 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--greige-600)" }}>
    <LockIcon /><span style={{ fontSize: 13 }}>Film · locked</span>
  </div>;
  return <div style={{ position: "relative", aspectRatio: "16 / 9", background: "#000", overflow: "hidden", borderRadius: "8px 8px 0 0" }}>
    <Film orientation={f.o} label="" />
    <span style={{ ...dOnPoster, right: 8, top: 10, font: "12px var(--font-mono)" }}>v{f.v}</span>
    {!preview && f.open > 0 && <span style={{ ...dOnPoster, left: 8, bottom: 8 }} title={`${f.open} open note${f.open === 1 ? "" : "s"} on v${f.v}`}><Icon n="message-square" size={13} />{f.open}</span>}
    <span className="tc" style={{ ...dOnPoster, right: 8, bottom: 8 }}>{f.dur}</span>
  </div>;
}

function DTile({ f, preview, menuOpen, requested, onOpen }) {
  const [menu, setMenu] = useState(!!menuOpen);
  const [req, setReq] = useState(!!requested);
  const click = () => f.locked ? setReq(true) : onOpen(f);
  return <div onClick={click} style={{ position: "relative", cursor: "pointer", background: "var(--paper-000)", color: "var(--ink-900)", border: "1px solid var(--greige-200)", borderRadius: 8 }} title={f.locked ? "Request unlock" : preview ? "Play" : "Open review"}>
    <DPoster f={f} preview={preview} />
    <div style={{ padding: "8px 6px 10px 12px", minHeight: 30, display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 15 }}>{f.title}</span>
      {f.locked ? <PremiumBadge /> : <button className="ibtn sm" title="Film actions" style={{ color: "var(--ink-900)" }} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}><Icon n="ellipsis" size={18} /></button>}
    </div>
    {f.locked && <div style={{ padding: "0 12px 12px", fontSize: 13, color: req ? "var(--greige-600)" : "var(--ink-900)" }}>{req ? "Requested. The studio will be in touch." : <u>Request unlock</u>}</div>}
    {menu && <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", right: 8, top: "calc(100% - 6px)", zIndex: 10, minWidth: 220, padding: 4, borderRadius: 8, background: "var(--paper-000)", color: "var(--ink-900)", border: "1px solid var(--greige-300)", boxShadow: "0 8px 24px rgba(10,10,10,.16)", fontSize: 14 }}>
      <div onClick={() => setMenu(false)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 4, cursor: "pointer" }}><Icon n="download" size={16} />Download original</div>
    </div>}
  </div>;
}

function PlainPlayer({ f, onClose, mobile }) {
  return <div style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(10,10,10,.94)", color: "var(--paper-050)", display: "flex", flexDirection: "column" }} data-surface="inverse">
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px" }}>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 15 }}>{f.title}</span>
      <button className="ibtn" title="Download original"><Icon n="download" size={18} /></button>
      <button className="ibtn" title="Close" onClick={onClose}><Icon n="x" size={18} /></button>
    </div>
    <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: mobile ? 0 : "0 48px 24px" }}>
      <div style={{ position: "relative", width: "100%", maxHeight: "100%", aspectRatio: f.o === "portrait" ? "9 / 16" : "16 / 9", maxWidth: f.o === "portrait" ? 300 : 960, background: "#000" }}>
        <Film orientation={f.o} label="" />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "linear-gradient(transparent, rgba(10,10,10,.8))" }}>
          <Icon n="play" size={18} /><div style={{ flex: 1, height: 3, borderRadius: 2, background: "rgba(250,248,242,.3)" }}><div style={{ width: "22%", height: "100%", background: "var(--paper-050)" }}></div></div><span className="tc" style={{ fontSize: 12 }}>0:20 / {f.dur}</span>
        </div>
      </div>
    </div>
    <p style={{ margin: 0, padding: "8px 12px 12px", textAlign: "center", fontSize: 12, color: "var(--greige-200)" }}>Plain player — no notes, no code. Only where the page has no review to open.</p>
  </div>;
}

/** films: which films to show. preview: staff Preview / guest review off — no review to open (D36). */
function DeliveryFilms({ mobile, films = D_FILMS.map((f) => f.id), preview, menuOn = null, requestedOn = null, playingOn = null }) {
  const list = D_FILMS.filter((f) => films.includes(f.id));
  const [toast, setToast] = useState(null);
  const [playing, setPlaying] = useState(() => D_FILMS.find((f) => f.id === playingOn) || null);
  const onOpen = (f) => {
    if (preview) { setPlaying(f); return; }
    setToast(`Opens “${f.title}” on the Delivery review link, in this tab`); setTimeout(() => setToast(null), 1800);
  };
  const single = list.length === 1;
  return <div style={{ position: "relative", background: "var(--paper-050)", color: "var(--ink-900)", minHeight: mobile ? "100%" : 560 }}>
    {preview && <div style={{ padding: "6px 12px", background: "var(--greige-200)", fontSize: 13, textAlign: "center" }}>Preview — how clients see this page</div>}
    <div data-surface="inverse" style={{ background: "var(--ink-900)", color: "var(--paper-050)", padding: mobile ? "20px 16px" : "32px 32px 28px", display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 200 }}><div style={{ fontSize: 12, color: "var(--greige-200)", textTransform: "uppercase", letterSpacing: ".06em" }}>Delivery</div><div style={{ font: `400 ${mobile ? 26 : 36}px/1.15 var(--font-display)` }}>14 Harbour St, Mosman</div></div>
      <button className="ibtn solid"><Icon n="download" size={16} />Download all</button>
    </div>
    <div style={{ padding: mobile ? "16px 12px 24px" : "24px 32px 32px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <span style={{ font: `400 ${mobile ? 22 : 28}px/1.2 var(--font-display)` }}>Video</span>
        <span style={{ fontSize: 13, color: "var(--greige-600)" }}>{list.length} {list.length === 1 ? "film" : "films"}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: mobile || single ? "minmax(0, 1fr)" : "repeat(auto-fill, minmax(280px, 1fr))", gap: mobile ? 14 : 18 }}>
        {list.map((f) => <DTile key={f.id} f={f} preview={preview} menuOpen={menuOn === f.id} requested={requestedOn === f.id} onOpen={onOpen} />)}
      </div>
      <div style={{ marginTop: 28, font: `400 ${mobile ? 22 : 28}px/1.2 var(--font-display)`, color: "var(--greige-500)" }}>Photos …</div>
    </div>
    {toast && <div style={{ position: "absolute", left: "50%", top: 12, transform: "translateX(-50%)", zIndex: 30, padding: "8px 12px", borderRadius: 8, background: "var(--ink-900)", color: "var(--paper-050)", fontSize: 13, whiteSpace: "nowrap" }}>{toast}</div>}
    {playing && <PlainPlayer f={playing} mobile={mobile} onClose={() => setPlaying(null)} />}
  </div>;
}

function MobileDelivery(props) {
  return <PhoneFrame><div style={{ flex: 1, overflowY: "auto", position: "relative" }}><DeliveryFilms {...props} mobile /></div></PhoneFrame>;
}

Object.assign(window, { DeliveryFilms, MobileDelivery });
