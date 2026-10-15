/* Phone review — the agreed design. One component, gated by role ("staff" | "guest").
   Every phone is live: play, scrub, drag the sheet between its three stops, tap a note or a marker,
   tap the composer, the pen, the Version chip, ⋯ and Full screen. */
const BODY_H = 703;          // phone body between the status bar and Safari's toolbar (844 − 20 bezel − 47 − 74)
const HEADER_H = 56;
const CONTROLS_H = 78;
const PEEK = 127;            // collapsed stop: grabber + tab row (with the open-note count) + composer
const AVAIL = BODY_H - HEADER_H;

/** Sheet stops. The film area (video + controls) is ~308 px for 16:9 and grows to 65% of the space for 9:16 (D7). */
function stopsFor(orientation) {
  const filmArea = orientation === "portrait" ? Math.round(AVAIL * 0.65) : 308;
  return { peek: PEEK, half: AVAIL - filmArea, full: AVAIL - 200 };
}

function MobileHeader({ role, approved, onApprove, onMenu, onVersion, onBack }) {
  return <div style={{ height: HEADER_H, flex: "none", display: "flex", alignItems: "center", gap: 4, padding: "0 4px", background: "var(--background)", borderBottom: "1px solid var(--border)" }}>
    <button className="ibtn" title="Back to Video" onClick={onBack}><Icon n="chevron-left" size={22} /></button>
    <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
      <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 15 }}>{FILM.title}</div>
      <button onClick={onVersion} title="Choose Version" style={{ justifySelf: "start", border: 0, background: "transparent", padding: 0, display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", color: "var(--foreground)", fontSize: 12 }}>
        {role === "staff" && <StatusDot status={approved ? "approved_internal" : "in_review"} />}v3 · latest<Icon n="chevron-down" size={12} />
      </button>
    </div>
    <button className="ibtn outline" onClick={onApprove} aria-pressed={approved} style={{ minHeight: 34, padding: "0 10px", fontSize: 13, whiteSpace: "nowrap", ...(approved ? { color: "var(--tone-positive)", borderColor: "var(--tone-positive)" } : {}) }}>
      {approved ? <><Icon n="check" size={15} />Approved</> : role === "guest" ? "Approve" : "Approve (internal)"}
    </button>
    <button className="ibtn" title="More" onClick={onMenu}><Icon n="ellipsis" size={20} /></button>
  </div>;
}

function ControlBar({ pb, notes, onFull, onMark }) {
  const [muted, setMuted] = useState(false);
  return <div style={{ flex: "none", height: CONTROLS_H, boxSizing: "border-box", padding: "2px 12px 6px", background: "var(--background)" }} onClick={(e) => e.stopPropagation()}>
    <Scrubber pb={pb} notes={notes} onMark={onMark} />
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button className="ibtn" title={pb.playing ? "Pause" : "Play"} onClick={pb.toggle}><Icon n={pb.playing ? "pause" : "play"} size={20} /></button>
      <span className="tc" style={{ fontSize: 13 }}>{tc(pb.t)}</span>
      <span style={{ flex: 1 }}></span>
      <button className="ibtn" title="Mute" onClick={() => setMuted(!muted)}><Icon n={muted ? "volume-x" : "volume-2"} size={19} /></button>
      <button className="ibtn" title="Full screen" onClick={onFull}><Icon n="maximize" size={19} /></button>
    </div>
  </div>;
}

function useSheet(initial, stops) {
  const [h, setH] = useState(initial);
  const [drag, setDrag] = useState(null);
  const base = useRef(initial);
  const live = useRef(null);
  const snaps = [stops.peek, stops.half, stops.full];
  const handlers = useDrag((dy) => { const next = Math.max(stops.peek - 30, Math.min(stops.full, base.current - dy)); live.current = next; setDrag(next); }, () => {
    const d = live.current; live.current = null; setDrag(null);
    if (d === null) return;
    const target = snaps.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a)); setH(target); base.current = target;
  });
  const snapTo = (x) => { setH(x); base.current = x; };
  return { h: drag ?? h, dragging: drag !== null, handlers, snapTo };
}

function PlayBadge() {
  return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}><span style={{ width: 60, height: 60, borderRadius: "50%", background: "rgba(10,10,10,.55)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon n="play" size={26} /></span></div>;
}

/** A stroke drawn on the frame, shown while drawing (D11). */
function DrawnStroke() {
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
    <path d="M30 62 C 36 50, 52 46, 64 52 S 74 66, 62 70" fill="none" stroke="var(--tone-critical)" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 3 }} />
  </svg>;
}

/**
 * The phone review.
 * mode: "split" (default) · "compose" (keyboard up) · "draw" (pen on) · "full" / "fullLand" (Full screen) — all reachable by tapping.
 * sheetAt: the stop the sheet opens at. Always "half" in the product (D6); other values only to show a stop in a frame.
 * openMenu: "version" | "more" to show that sheet already open in a frame.
 */
function MobileReview({ role = "staff", orientation = "landscape", sheetAt = "half", mode: initialMode = "split", openMenu = null, markerNote = null }) {
  const pb = usePlayback(FILM.duration);
  const notes = visibleNotes(role);
  const stops = stopsFor(orientation);
  const sheet = useSheet(stops[sheetAt], stops);
  const [tab, setTab] = useState("notes");
  const [active, setActive] = useState(null);
  const [menu, setMenu] = useState(openMenu);
  const [mode, setMode] = useState(initialMode);
  const [approved, setApproved] = useState(false);
  const [viaTurn, setViaTurn] = useState(initialMode === "fullLand");
  const turn = () => { setViaTurn(true); setMode("fullLand"); };
  const pick = (n) => { setActive(n.id); pb.seek(n.t); pb.setPlaying(false); };
  const tabs = role === "staff" ? [["notes", "Notes", openCount(role)], ["delivery", "Delivery"]] : [["notes", "Notes", openCount(role)]];

  const menus = {
    more: role === "staff"
      ? { rows: [{ icon: "smartphone", label: "Social preview" }, { icon: "download", label: "Download v3" }, { icon: "list", label: "Marker export…" }, { icon: "link-2", label: "Copy link" }, { icon: "link-2", label: "Create Review link" }, { icon: "maximize", label: "Open in iPhone player", onClick: () => setMode("native") }, "-", { label: "Remove v3…", danger: true }] }
      : { rows: [{ icon: "smartphone", label: "Social preview" }, { icon: "download", label: "Download v3", sub: "when released" }, { icon: "maximize", label: "Open in iPhone player", onClick: () => setMode("native") }] },
    version: { title: "Version", rows: FILM.versions.map((v, i) => ({ label: `v${v.v}${v.latest ? " · latest" : ""}`, sub: `${v.when} · ${i === 0 ? openCount(role) : i === 1 ? 2 : 0} open${role === "staff" && i === 0 ? ` · ${approved ? "Approved" : "In review"}` : ""}`, check: v.latest })) },
  };

  if (mode === "native") return <NativeFullscreen onExit={() => setMode("split")} />;
  // D14: turning the phone sideways enters Full screen; turning it back returns to where you were before the turn
  // (the split view if the turn opened Full screen, portrait Full screen if you were already in it).
  if (mode === "full" || mode === "fullLand") return <PhoneFrame land={mode === "fullLand"} safari={mode === "fullLand" ? "none" : "compact"}>
    <Fullscreen pb={pb} role={role} land={mode === "fullLand"} initialNote={markerNote} onExit={() => setMode("split")}
      onRotate={() => { if (mode === "full") { setViaTurn(false); setMode("fullLand"); } else setMode(viaTurn ? "split" : "full"); }} />
  </PhoneFrame>;

  const header = <MobileHeader role={role} approved={approved} onApprove={() => setApproved(!approved)} onMenu={() => setMenu("more")} onVersion={() => setMenu("version")} />;

  // D10: while typing, the film stays visible above the keyboard and only the composer floats on it.
  if (mode === "compose") return <PhoneFrame safari="none">
    {header}
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}><Film orientation={orientation} /></div>
    <div style={{ flex: "none", background: "var(--card)", borderTop: "1px solid var(--border)" }}>
      <div style={{ padding: "6px 16px 0", fontSize: 12, color: "var(--fg2)" }}>Paused at {tc(pb.t)} · the note is stamped here</div>
      <Composer pb={pb} autoFocus onPen={() => setMode("draw")} />
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 12px 6px" }}><button className="ibtn sm" onClick={() => setMode("split")} style={{ fontSize: 13 }}>Cancel</button></div>
    </div>
    <Keyboard />
  </PhoneFrame>;

  // D11: the pen hides the keyboard and makes the film the canvas; Done returns to the composer.
  if (mode === "draw") return <PhoneFrame>
    {header}
    <div style={{ position: "relative", flex: 1, minHeight: 0, outline: "2px solid var(--tone-critical)", outlineOffset: -2 }}>
      <Film orientation={orientation} />
      <DrawnStroke />
      <div style={{ position: "absolute", left: 8, right: 8, top: 8, display: "flex", alignItems: "center", gap: 6, padding: "4px 4px 4px 10px", borderRadius: 10, background: "rgba(10,10,10,.72)", fontSize: 13 }}>
        <Icon n="pencil" size={15} /><span style={{ flex: 1 }}>Drawing on {tc(pb.t)}</span>
        <button className="ibtn sm" title="Undo"><Icon n="rotate-ccw" size={16} /></button>
        <button className="ibtn solid" style={{ minHeight: 32, padding: "0 12px" }} onClick={() => setMode("compose")}>Done</button>
      </div>
    </div>
    <div style={{ flex: "none", background: "var(--card)", borderTop: "1px solid var(--border)" }}><Composer pb={pb} penOn onPen={() => setMode("compose")} placeholder="Add a note with this drawing…" /></div>
  </PhoneFrame>;

  return <PhoneFrame>
    {header}
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", flex: 1, minHeight: 0 }} onClick={pb.toggle}>
        <Film orientation={orientation} />
        {!pb.playing && <PlayBadge />}
        <button className="ibtn" title="Prototype only: simulates turning the phone sideways" onClick={(e) => { e.stopPropagation(); turn(); }} style={{ position: "absolute", right: 6, top: 6, border: "1px dashed var(--greige-400)", fontSize: 11, gap: 4, background: "rgba(10,10,10,.5)", minHeight: 30 }}><Icon n="rotate-ccw" size={14} />demo</button>
      </div>
      <ControlBar pb={pb} notes={notes} onFull={() => setMode("full")} onMark={(id) => { setActive(id); setTab("notes"); if (sheet.h < stops.half) sheet.snapTo(stops.half); }} />
    </div>
    <div style={{ height: sheet.h, transition: sheet.dragging ? "none" : "height var(--dur-base) var(--ease-entrance)", flex: "none", display: "flex", flexDirection: "column", background: "var(--card)", borderTop: "1px solid var(--border)", borderRadius: "14px 14px 0 0" }}>
      <div className="grabber" {...sheet.handlers} onDoubleClick={() => sheet.snapTo(sheet.h > stops.peek ? stops.peek : stops.half)} title="Drag: collapsed · half · full. Double-tap: collapse / half."></div>
      <div className="tabs">
        {tabs.map(([k, l, c]) => <button key={k} className={`tab${tab === k ? " on" : ""}`} onClick={() => { setTab(k); if (sheet.h <= stops.peek) sheet.snapTo(stops.half); }}>{l}{c != null && <span className="count">{c}</span>}</button>)}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {tab === "notes" && <><NotesFilter role={role} />{notes.map((n) => <NoteItem key={n.id} note={n} active={active === n.id} onPick={pick} />)}</>}
        {tab === "delivery" && <DeliveryPanel />}
      </div>
      {tab === "notes" && <Composer pb={pb} onFocus={() => setMode("compose")} onPen={() => setMode("draw")} />}
    </div>
    {menu && <ActionSheet {...menus[menu]} onClose={() => setMenu(null)} />}
  </PhoneFrame>;
}

/** Full screen = Quincy's immersive mode (D12–D15). Tap toggles the controls; they hide after 3 s of play. */
function Fullscreen({ pb, role, land, onExit, onRotate, initialNote = null }) {
  const notes = visibleNotes(role);
  const [chrome, setChrome] = useState(true);
  const [composing, setComposing] = useState(false);
  const [card, setCard] = useState(initialNote ? notes.find((n) => n.id === initialNote) : null);
  useEffect(() => { if (!pb.playing || composing) { setChrome(true); return undefined; } const id = setTimeout(() => setChrome(false), 3000); return () => clearTimeout(id); }, [pb.playing, chrome, composing]);
  const side = land ? 44 : 12;
  return <div style={{ position: "relative", flex: 1, minHeight: 0, background: "#000" }} onClick={() => setChrome(!chrome)}>
    <Film />
    {card && <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", left: side, right: side, top: land ? 56 : 64, maxWidth: 420, zIndex: 15, display: "flex", gap: 8, padding: "8px 6px 8px 10px", borderRadius: 12, background: "rgba(10,10,10,.8)", backdropFilter: "blur(8px)", fontSize: 14 }}>
      <span className={`avatar${card.ext ? " ext" : ""}`} style={{ width: 24, height: 24, fontSize: 10 }}>{card.init}</span>
      <span style={{ flex: 1, minWidth: 0 }}><span style={{ color: "var(--fg2)", fontSize: 12 }}>{card.who} · {tc(card.t)}</span><br />{card.body}</span>
      <button className="ibtn sm" title="Close" onClick={() => setCard(null)}><Icon n="x" size={16} /></button>
    </div>}
    <div style={{ position: "absolute", inset: 0, opacity: chrome ? 1 : 0, transition: "opacity var(--dur-base)", pointerEvents: chrome ? "auto" : "none", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: land ? `10px ${side}px 0` : "4px 8px", background: "var(--scrim-top)" }} onClick={(e) => e.stopPropagation()}>
        <button className="ibtn" title="Exit full screen" onClick={onExit}><Icon n="minimize" size={20} /></button>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 14 }}>{FILM.title} · v3</span>
        <button className="ibtn" title="Prototype only: simulates turning the phone (the product follows the device)" onClick={onRotate} style={{ border: "1px dashed var(--greige-400)", fontSize: 11, gap: 4 }}><Icon n="rotate-ccw" size={15} />demo</button>
      </div>
      {!pb.playing && <button onClick={(e) => { e.stopPropagation(); pb.toggle(); }} style={{ alignSelf: "center", width: 64, height: 64, borderRadius: "50%", border: 0, background: "rgba(10,10,10,.55)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><Icon n="play" size={28} /></button>}
      <div style={{ padding: land ? `0 ${side}px 12px` : "0 12px 8px", background: "var(--scrim-caption)" }} onClick={(e) => e.stopPropagation()}>
        {composing && <div style={{ marginBottom: 6, borderRadius: 12, overflow: "hidden" }}><Composer pb={pb} compact autoFocus /></div>}
        <Scrubber pb={pb} notes={notes} onMark={(id) => { setCard(notes.find((n) => n.id === id)); pb.setPlaying(false); }} />
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button className="ibtn" onClick={pb.toggle}><Icon n={pb.playing ? "pause" : "play"} size={20} /></button>
          <span className="tc" style={{ fontSize: 13 }}>{tc(pb.t)}</span><span style={{ flex: 1 }}></span>
          <button className="ibtn" title="Mute"><Icon n="volume-2" size={19} /></button>
          <button className="ibtn outline" onClick={() => setComposing(!composing)} aria-pressed={composing}><Icon n="square-pen" size={16} />Add note</button>
        </div>
      </div>
    </div>
  </div>;
}

/** "Open in iPhone player" (⋯): Apple's own player via video.webkitEnterFullscreen(). None of Quincy's layers show. Static. */
function NativeFullscreen({ onExit }) {
  return <PhoneFrame land safari="none">
    <div style={{ position: "relative", flex: 1, background: "#000" }}>
      <Film label={"film frame · 16:9\nApple's player owns this screen:\nno markers, notes, drawing or Social overlay"} />
      <div style={{ position: "absolute", left: 44, top: 14, display: "flex", gap: 10 }}>{["x", "minimize"].map((n) => <span key={n} onClick={onExit} style={{ width: 40, height: 40, borderRadius: 20, background: "rgba(80,80,80,.6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", cursor: onExit ? "pointer" : "default" }}><Icon n={n} size={18} /></span>)}</div>
      <div style={{ position: "absolute", left: 44, right: 44, bottom: 16, padding: "10px 14px", borderRadius: 16, background: "rgba(80,80,80,.55)", display: "flex", alignItems: "center", gap: 12, color: "#fff" }}><Icon n="play" size={20} /><span style={{ flex: 1, height: 4, borderRadius: 2, background: "rgba(255,255,255,.35)", position: "relative" }}><span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "14%", background: "#fff", borderRadius: 2 }}></span></span><span style={{ font: "12px -apple-system" }}>0:12</span></div>
    </div>
  </PhoneFrame>;
}

/** Today's phone viewer — reference only, NOT the design: one scrolling stack (player, Delivery, composer, notes). */
function CurrentMobile() {
  const pb = usePlayback(FILM.duration);
  return <PhoneFrame>
    <div style={{ height: 52, flex: "none", display: "flex", alignItems: "center", gap: 6, padding: "0 6px", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
      <button className="ibtn"><Icon n="chevron-left" size={20} /></button>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 15 }}>{FILM.title}</span>
      <StatusPill compact /><button className="ibtn outline" style={{ minHeight: 44 }}>v3</button><button className="ibtn outline" style={{ minHeight: 44 }}><Icon n="smartphone" size={16} /></button><button className="ibtn"><Icon n="ellipsis" size={18} /></button>
    </div>
    <div style={{ flex: 1, overflowY: "auto" }}>
      <div style={{ padding: 24 }}>
        <div style={{ position: "relative", height: 320 }}><Film /></div>
        <div style={{ paddingTop: 8 }}><Scrubber pb={pb} /></div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", padding: "6px 0" }}>{["step-back", "play", "step-forward"].map((n) => <button key={n} className="ibtn outline"><Icon n={n} size={16} /></button>)}<span className="tc">{tc(pb.t)}</span><button className="ibtn outline">I</button><button className="ibtn outline">O</button></div>
        <div style={{ fontSize: 12, color: "var(--fg2)" }}>Space play · ← → frame · I / O marks …</div>
        <div style={{ marginTop: 16, border: "1px solid var(--border)" }}><DeliveryPanel /></div>
      </div>
      <div style={{ background: "var(--card)", borderTop: "1px solid var(--border)" }}><Composer pb={pb} />{NOTES.map((n) => <NoteItem key={n.id} note={n} />)}</div>
    </div>
  </PhoneFrame>;
}

Object.assign(window, { MobileReview, NativeFullscreen, CurrentMobile, stopsFor });
