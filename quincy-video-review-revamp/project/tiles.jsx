/* Video collection tiles — the agreed design: the ink look (D20), content by role (D21), ⋯ as the only button (D23).
   Live: tap a tile (opens review — shown as a toast here), tick to select (staff), ⋯ for the menu. */
const FILMS = [
  { id: "f1", title: "14 Harbour St, Mosman — Hero film", o: "landscape", v: 3, dur: "1:32", status: "in_review", open: { staff: 4, guest: 2 }, linked: true },
  { id: "f2", title: "Harbour St — Social cut 9:16", o: "portrait", v: 2, dur: "0:30", status: "approved_internal", open: { staff: 0, guest: 0 }, linked: true },
  { id: "f3", title: "Harbour St — Agent walkthrough", o: "landscape", v: 1, dur: "2:48", status: "in_review", open: { staff: 1, guest: 1 } },
  { id: "f4", title: "Harbour St — Twilight teaser", o: "portrait", v: 4, dur: "0:15", status: "published", open: { staff: 3, guest: 0 } },
  { id: "f5", title: "Harbour St — Drone loop", o: "landscape", v: 1, dur: "0:20", status: "in_review", open: { staff: 0, guest: 0 } },
];
const GUEST_FILMS = ["f1", "f2", "f4"];

const onPoster = { position: "absolute", display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 4, background: "rgba(10,10,10,.7)", color: "#fff", fontSize: 12 };

function Poster({ f, role, sel, onSel, mobile, drop }) {
  const [hover, setHover] = useState(false);
  const showTick = role === "staff" && (mobile || sel || hover);
  const open = f.open[role];
  return <div style={{ position: "relative", aspectRatio: "16 / 9", background: "#000", overflow: "hidden", borderRadius: "8px 8px 0 0" }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <Film orientation={f.o} label="" />
    {role === "staff" && <label onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: 4, top: 4, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: showTick ? 1 : 0, transition: "opacity var(--dur-fast)" }}>
      <input type="checkbox" checked={sel} onChange={onSel} aria-label={`Select ${f.title}`} style={{ position: "absolute", opacity: 0, inset: 0, cursor: "pointer" }} />
      <span style={{ width: 20, height: 20, borderRadius: 4, border: "1.5px solid rgba(250,248,242,.85)", background: sel ? "var(--paper-050)" : "rgba(10,10,10,.35)", color: "var(--ink-900)", display: "flex", alignItems: "center", justifyContent: "center" }}>{sel && <Icon n="check" size={14} stroke={2.5} />}</span>
    </label>}
    {role === "staff" && <span style={{ ...onPoster, left: showTick ? 44 : 8, top: 10, transition: "left var(--dur-fast)" }}><StatusDot status={f.status} />{STATUS[f.status][0]}</span>}
    <span style={{ position: "absolute", right: 8, top: 10, display: "flex", gap: 6 }}>
      {role === "staff" && f.linked && <span style={{ ...onPoster, position: "static" }} title="On a Review link"><Icon n="link-2" size={13} /></span>}
      <span style={{ ...onPoster, position: "static", font: "12px var(--font-mono)" }}>v{f.v}</span>
    </span>
    {open > 0 && <span style={{ ...onPoster, left: 8, bottom: 8 }} title={`${open} open note${open === 1 ? "" : "s"} on v${f.v}`}><Icon n="message-square" size={13} />{open}</span>}
    <span className="tc" style={{ ...onPoster, right: 8, bottom: 8 }}>{f.dur}</span>
    {drop && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "rgba(10,10,10,.72)", border: "2px dashed var(--paper-050)", borderRadius: "8px 8px 0 0", fontSize: 15 }}><Icon n="upload" size={18} />Drop to upload v{f.v + 1}</div>}
  </div>;
}

function Tile({ f, role, sel, onSel, mobile, menuOpen, drop, onOpen }) {
  const [menu, setMenu] = useState(!!menuOpen);
  return <div onClick={() => onOpen(f)} style={{ position: "relative", cursor: "pointer", background: "var(--ink-800)", borderRadius: 8, boxShadow: sel ? "0 0 0 2px var(--paper-050)" : "none" }} title="Open review">
    <Poster f={f} role={role} sel={sel} onSel={onSel} mobile={mobile} drop={drop} />
    <div style={{ padding: "8px 6px 10px 12px", minHeight: 30, display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 15 }}>{f.title}</span>
      {role === "staff" && <button className="ibtn sm" title="Film actions" onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}><Icon n="ellipsis" size={18} /></button>}
    </div>
    {menu && <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", right: 8, top: "calc(100% - 6px)", zIndex: 10, minWidth: 220, padding: 4, borderRadius: 8, background: "var(--ink-800)", color: "var(--paper-050)", border: "1px solid var(--greige-500)", boxShadow: "0 8px 24px rgba(10,10,10,.3)", fontSize: 14 }} data-surface="inverse">
      {[`Upload v${f.v + 1}`, "Rename…", `Download v${f.v}`, `Versions (${f.v})`, "Review links", "-", "Delete…"].map((l, i) => l === "-" ? <div key={i} style={{ height: 1, background: "var(--greige-500)", margin: "4px 0", opacity: .6 }}></div> : <div key={i} onClick={() => setMenu(false)} style={{ padding: "8px 10px", borderRadius: 4, cursor: "pointer", color: l === "Delete…" ? "var(--critical-inv)" : undefined }}>{l}</div>)}
    </div>}
  </div>;
}

/** role: "staff" | "guest". selected / menuOn / dropOn pre-set a state for a frame; all are also reachable live. */
function Collection({ role = "staff", mobile, selected = [], menuOn = null, dropOn = null }) {
  const [sel, setSel] = useState(() => new Set(selected));
  const [toast, setToast] = useState(null);
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const films = role === "guest" ? FILMS.filter((f) => GUEST_FILMS.includes(f.id)) : FILMS;
  const onOpen = (f) => { setToast(`Opens the review of “${f.title}”`); setTimeout(() => setToast(null), 1600); };
  return <div data-surface="inverse" style={{ position: "relative", background: "var(--ink-900)", color: "var(--paper-050)", padding: mobile ? "12px 12px 24px" : "20px 24px 24px", minHeight: mobile ? 0 : 560 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
      <span style={{ font: `400 ${mobile ? 22 : 28}px/1.2 var(--font-display)` }}>Video</span>
      <span style={{ fontSize: 13, color: "var(--greige-200)" }}>{films.length} films</span>
      <span style={{ flex: 1 }}></span>
      {role === "staff" && <button className="ibtn solid"><Icon n="upload" size={16} />Upload</button>}
    </div>
    <div style={{ display: "grid", gridTemplateColumns: mobile ? "minmax(0, 1fr)" : "repeat(auto-fill, minmax(280px, 1fr))", gap: mobile ? 14 : 18 }}>
      {films.map((f) => <Tile key={f.id} f={f} role={role} sel={sel.has(f.id)} onSel={() => toggle(f.id)} mobile={mobile} menuOpen={menuOn === f.id} drop={dropOn === f.id} onOpen={onOpen} />)}
    </div>
    {role === "staff" && sel.size > 0 && <div style={{ position: "sticky", bottom: 16, marginTop: 18, display: "flex", justifyContent: "center", zIndex: 20 }}><div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 6px 6px 14px", borderRadius: 12, background: "var(--ink-800)", border: "1px solid var(--greige-500)", boxShadow: "0 8px 24px rgba(10,10,10,.3)", whiteSpace: "nowrap" }}>
      <span style={{ fontSize: 14 }}>{sel.size} selected</span>
      <button className="ibtn solid" style={{ marginLeft: 6 }}>Create Review link</button>
      <button className="ibtn" title="Download"><Icon n="download" size={17} /></button>
      <button className="ibtn" title="Clear selection" onClick={() => setSel(new Set())}><Icon n="x" size={17} /></button>
    </div></div>}
    {toast && <div style={{ position: "absolute", left: "50%", top: 12, transform: "translateX(-50%)", zIndex: 30, padding: "8px 12px", borderRadius: 8, background: "var(--paper-050)", color: "var(--ink-900)", fontSize: 13, whiteSpace: "nowrap" }}>{toast}</div>}
  </div>;
}

function MobileCollection(props) {
  return <PhoneFrame><div style={{ flex: 1, overflowY: "auto" }}><Collection {...props} mobile /></div></PhoneFrame>;
}

Object.assign(window, { Collection, MobileCollection });
