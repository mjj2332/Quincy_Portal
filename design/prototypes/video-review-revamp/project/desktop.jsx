/* Desktop review — the agreed design: today's header and player, plus a notes rail you can resize and collapse (D17, D18).
   Live: play, scrub, drag the rail's left edge, collapse / reopen it, switch tabs. */
function BrowserWindow({ children, w = 1280, h = 800, url = "quincy.flamingfire.my/projects/harbour-st/video?film=hero&v=3" }) {
  return <div style={{ width: w, height: h, borderRadius: 10, overflow: "hidden", boxShadow: "0 24px 64px rgba(10,10,10,.2)", display: "flex", flexDirection: "column", background: "#000" }}>
    <div style={{ height: 36, flex: "none", background: "#2a2a2c", display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }}></span>)}
      <span style={{ marginLeft: 40, flex: 1, maxWidth: 520, height: 24, borderRadius: 6, background: "#1c1c1e", color: "#bbb", font: "12px -apple-system, sans-serif", display: "flex", alignItems: "center", padding: "0 10px", whiteSpace: "nowrap", overflow: "hidden" }}>{url}</span>
    </div>
    <div data-surface="inverse" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>{children}</div>
  </div>;
}

/** Header: unchanged from today for staff (D29). Guests get a one-tap Approve (a prototype choice). */
function DesktopHeader({ role }) {
  const [approved, setApproved] = useState(false);
  return <header style={{ height: 56, flex: "none", display: "flex", alignItems: "center", gap: 12, padding: "0 12px 0 8px", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
    {role === "staff" && <><button className="ibtn"><Icon n="chevron-left" size={18} />Video</button><span style={{ width: 1, height: 24, background: "var(--border)" }}></span></>}
    <span style={{ minWidth: "10ch", flex: "0 1 auto", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 16, paddingLeft: role === "guest" ? 8 : 0 }}>{FILM.title}</span>
    <button className="chip" style={{ height: 32 }}>v3 · latest<Icon n="chevron-down" size={12} /></button>
    {role === "staff" && <StatusPill caret />}
    <span style={{ flex: 1 }}></span>
    <button className="ibtn" title="Social preview"><Icon n="smartphone" size={18} /></button>
    {role === "staff" && <button className="ibtn" title="Compare versions"><Icon n="columns-2" size={18} /></button>}
    <button className="ibtn" title={role === "guest" ? "Download v3 (when released)" : "Download v3"}><Icon n="download" size={18} /></button>
    {role === "staff" && <><button className="ibtn" title="Copy link"><Icon n="link-2" size={18} /></button><button className="ibtn solid" style={{ padding: "0 14px" }}>Create Review link</button></>}
    {role === "guest" && <button className="ibtn outline" onClick={() => setApproved(!approved)} style={{ padding: "0 14px", ...(approved ? { color: "var(--tone-positive)", borderColor: "var(--tone-positive)" } : {}) }}>{approved ? <><Icon n="check" size={16} />Approved</> : "Approve"}</button>}
  </header>;
}

function DesktopControls({ pb, notes }) {
  return <div style={{ flex: "none", padding: "4px 20px 12px" }}>
    <Scrubber pb={pb} notes={notes} />
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button className="ibtn sm" title="Previous frame (←)"><Icon n="step-back" size={17} /></button>
      <button className="ibtn" title="Play (Space)" onClick={pb.toggle}><Icon n={pb.playing ? "pause" : "play"} size={20} /></button>
      <button className="ibtn sm" title="Next frame (→)"><Icon n="step-forward" size={17} /></button>
      <span className="tc" style={{ fontSize: 13, padding: "0 8px" }}>{tc(pb.t)} <span style={{ color: "var(--fg2)" }}>/ {tc(pb.duration)}</span></span>
      <button className="ibtn sm" title="Mark in (I)" style={{ font: "12px var(--font-mono)" }}>I</button>
      <button className="ibtn sm" title="Mark out (O)" style={{ font: "12px var(--font-mono)" }}>O</button>
      <span style={{ flex: 1 }}></span>
      <button className="ibtn sm" title="Mute (M)"><Icon n="volume-2" size={17} /></button>
      <button className="ibtn sm" title="Shortcuts"><span style={{ font: "12px var(--font-mono)" }}>?</span></button>
      <button className="ibtn sm" title="Full screen (F)"><Icon n="maximize" size={17} /></button>
    </div>
  </div>;
}

const RAIL_MIN = 300, RAIL_MAX = 560;

/** role: "staff" | "guest". open: whether the rail starts open (a portrait tablet starts collapsed, D18). */
function DesktopReview({ role = "staff", open: initialOpen = true, w = 1280, h = 800 }) {
  const pb = usePlayback(FILM.duration);
  const notes = visibleNotes(role);
  const [rw, setRw] = useState(380);
  const [open, setOpen] = useState(initialOpen);
  const [tab, setTab] = useState("notes");
  const [active, setActive] = useState(role === "staff" ? "n2" : "n1");
  const drag = useRef(null);
  const pick = (n) => { setActive(n.id); pb.seek(n.t); pb.setPlaying(false); };
  const handle = {
    onPointerDown: (e) => { drag.current = { x: e.clientX, w: rw }; e.currentTarget.setPointerCapture?.(e.pointerId); },
    onPointerMove: (e) => { if (drag.current) setRw(Math.max(RAIL_MIN, Math.min(RAIL_MAX, drag.current.w + drag.current.x - e.clientX))); },
    onPointerUp: () => { drag.current = null; },
  };
  const tabs = role === "staff" ? [["notes", "Notes", openCount(role)], ["delivery", "Delivery"]] : [["notes", "Notes", openCount(role)]];
  return <BrowserWindow w={w} h={h} url={role === "guest" ? "quincy.flamingfire.my/r/7Hq2…/hero" : undefined}>
    <DesktopHeader role={role} />
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ position: "relative", flex: 1, minHeight: 0, margin: "16px 20px 0" }} onClick={pb.toggle}><Film /></div>
        <DesktopControls pb={pb} notes={notes} />
      </div>
      {open
        ? <>
          <div {...handle} title={`Drag to resize (${RAIL_MIN}–${RAIL_MAX} px)`} style={{ width: 9, margin: "0 -4px", cursor: "col-resize", position: "relative", zIndex: 2, touchAction: "none", display: "flex", justifyContent: "center" }}><span style={{ width: 1, background: "var(--border)" }}></span></div>
          <aside style={{ width: rw, flex: "none", display: "flex", flexDirection: "column", background: "var(--card)" }}>
            <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", paddingRight: 6 }}>
              <div className="tabs" style={{ border: 0, flex: 1 }}>{tabs.map(([k, l, c]) => <button key={k} className={`tab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>{l}{c != null && <span className="count">{c}</span>}</button>)}</div>
              <button className="ibtn sm" title="Hide notes (keyboard shortcut — key chosen at build)" onClick={() => setOpen(false)}><Icon n="panel-right-close" size={17} /></button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {tab === "notes" && <><NotesFilter role={role} />{notes.map((n) => <NoteItem key={n.id} note={n} active={active === n.id} onPick={pick} />)}</>}
              {tab === "delivery" && <DeliveryPanel />}
            </div>
            {tab === "notes" && <Composer pb={pb} />}
          </aside>
        </>
        : <div style={{ width: 44, flex: "none", borderLeft: "1px solid var(--border)", background: "var(--card)", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 6, gap: 6 }}>
          <button className="ibtn sm" title="Show notes" onClick={() => setOpen(true)}><Icon n="panel-right-open" size={17} /></button>
          <span className="count" title="Open notes">{openCount(role)}</span>
        </div>}
    </div>
  </BrowserWindow>;
}

Object.assign(window, { DesktopReview, BrowserWindow });
