/* Shared prototype kit: icons, mock data, playback clock, and the viewer pieces every frame reuses. */
const { useState, useEffect, useRef, useCallback } = React;

function Icon({ n, size = 18, stroke = 1.75, style }) {
  const node = (window.QICONS || {})[n] || [];
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none", ...style }}>
    {node.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))}
  </svg>;
}

const FPS = 25;
const pad = (n) => String(Math.floor(n)).padStart(2, "0");
/** SMPTE-style HH:MM:SS:FF, as the Portal shows it. */
function tc(t) { const f = Math.floor((t % 1) * FPS); return `${pad(t / 3600)}:${pad((t / 60) % 60)}:${pad(t % 60)}:${pad(f)}`; }
function short(t) { return `${Math.floor(t / 60)}:${pad(t % 60)}`; }

const FILM = { title: "14 Harbour St, Mosman — Hero film", version: 3, versions: [
  { v: 3, by: "Tom Reyes", when: "14 Oct, 3:58 pm", latest: true },
  { v: 2, by: "Tom Reyes", when: "12 Oct, 11:20 am" },
  { v: 1, by: "Ava Lin", when: "9 Oct, 6:02 pm" },
], duration: 92, status: "in_review", orientation: "landscape" };

const NOTES = [
  { id: "n1", t: 4.2, who: "Mia Chen", init: "MC", ext: true, role: "Agent", body: "Can we open on the harbour view instead of the driveway?", when: "2h", replies: 2, done: false },
  { id: "n2", t: 18.6, out: 24.0, who: "Tom Reyes", init: "TR", role: "Editor", body: "Kitchen grade is a touch warm — pulling it back in v4.", when: "1h", replies: 0, done: false, internal: true },
  { id: "n3", t: 31.0, who: "Mia Chen", init: "MC", ext: true, role: "Agent", body: "Love this drone pass. Keep it.", when: "1h", replies: 1, done: true },
  { id: "n4", t: 47.5, who: "Mia Chen", init: "MC", ext: true, role: "Agent", body: "Agent name on the lower third is misspelled — it's \"Kozma\".", when: "40m", replies: 0, done: false, drawing: true },
  { id: "n5", t: 66.0, who: "Ava Lin", init: "AL", role: "Producer", body: "Music swell lands a beat late after the pool shot.", when: "12m", replies: 0, done: false, internal: true },
];

const STATUS = { in_review: ["In review", "tone-info"], approved_internal: ["Approved (internal)", "tone-positive"], published: ["Published", "tone-neutral"] };
const STATUS_SHORT = { in_review: "In review", approved_internal: "Approved", published: "Published" };

/** A fake playback clock: play/pause/seek on a fixed duration. */
function usePlayback(duration, start = 12.32) {
  const [t, setT] = useState(start);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return undefined;
    let last = performance.now(); let raf;
    const tick = (now) => { const dt = (now - last) / 1000; last = now; setT((x) => { const n = x + dt; if (n >= duration) { setPlaying(false); return duration; } return n; }); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);
  const seek = useCallback((x) => setT(Math.max(0, Math.min(duration, x))), [duration]);
  return { t, playing, toggle: () => setPlaying((p) => !p), setPlaying, seek, duration };
}

function Film({ orientation = "landscape", fit = "contain", label, children }) {
  const portrait = orientation === "portrait";
  const ratio = portrait ? "9 / 16" : "16 / 9";
  return <div className="film">
    <div className={`film-frame${fit === "cover" ? " cover" : ""}`} style={fit === "cover" ? {} : { aspectRatio: ratio, width: portrait ? "auto" : "100%", height: portrait ? "100%" : "auto" }}>
      <div className="film-horizon"></div>
      <div className="film-label">{label ?? (portrait ? "film frame\n9:16" : "film frame · 16:9")}</div>
    </div>
    {children}
  </div>;
}

function Scrubber({ pb, notes = NOTES, showMarks = true, onMark }) {
  const ref = useRef(null);
  const at = (e) => { const r = ref.current.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * pb.duration; };
  const down = (e) => { e.stopPropagation(); ref.current.setPointerCapture?.(e.pointerId); pb.seek(at(e)); };
  const move = (e) => { if (e.buttons) pb.seek(at(e)); };
  const pct = (x) => `${(x / pb.duration) * 100}%`;
  return <div className="scrub" ref={ref} onPointerDown={down} onPointerMove={move} onClick={(e) => e.stopPropagation()}>
    <div className="scrub-track"><div className="scrub-fill" style={{ width: pct(pb.t) }}></div></div>
    {showMarks && notes.map((n) => <span key={n.id} className={`scrub-mark${n.done ? " done" : ""}`} style={{ left: pct(n.t) }} title={`${n.who} · ${short(n.t)}`} onPointerDown={(e) => { e.stopPropagation(); pb.seek(n.t); onMark?.(n.id); }}></span>)}
    <div className="scrub-head" style={{ left: pct(pb.t) }}></div>
  </div>;
}

function StatusPill({ status = "in_review", compact, caret }) {
  const [label, tone] = STATUS[status];
  return <span className={`pill ${tone}`}><span className="dot"></span>{compact ? STATUS_SHORT[status] : label}{caret && <Icon n="chevron-down" size={12} />}</span>;
}

function NoteItem({ note, active, onPick }) {
  return <div className={`note${active ? " on" : ""}`} onClick={() => onPick?.(note)}>
    <span className={`avatar${note.ext ? " ext" : ""}`}>{note.init}</span>
    <div style={{ minWidth: 0 }}>
      <div className="note-head"><b>{note.who}</b><span className="tc-chip">{tc(note.t)}{note.out ? ` – ${tc(note.out).slice(3)}` : ""}</span>{note.internal && <span className="tag-int">Internal</span>}<span style={{ marginLeft: "auto" }}>{note.when}</span></div>
      <div className="note-body" style={note.done ? { color: "var(--fg2)", textDecoration: "line-through", textDecorationColor: "var(--greige-500)" } : null}>{note.body}</div>
      <div className="note-foot">{note.drawing && <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}><Icon n="pencil" size={13} />Drawing</span>}<span>{note.replies ? `${note.replies} ${note.replies === 1 ? "reply" : "replies"}` : "Reply"}</span>{note.done ? <span style={{ display: "inline-flex", gap: 4, alignItems: "center", color: "var(--tone-positive)" }}><Icon n="circle-check" size={13} />Done</span> : <span>Mark done</span>}</div>
    </div>
  </div>;
}

function NotesFilter({ role = "staff" }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: "1px solid color-mix(in srgb, var(--border) 55%, transparent)" }}>
    <button className="chip">Open · {openCount(role)}<Icon n="chevron-down" size={12} /></button>
    <button className="chip">Everyone<Icon n="chevron-down" size={12} /></button>
    <span style={{ marginLeft: "auto", display: "flex" }}><button className="ibtn sm" title="Search notes"><Icon n="search" size={16} /></button></span>
  </div>;
}

function Composer({ pb, compact, onFocus, autoFocus, onPen, penOn, placeholder = "Add a note…" }) {
  const [text, setText] = useState("");
  return <div className="composer" style={compact ? { padding: "8px 10px" } : null}>
    <div className="composer-input">
      <span className="tc-chip">{tc(pb.t)}</span>
      <input placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onFocus={() => { pb.setPlaying(false); onFocus?.(); }} autoFocus={autoFocus} />
      <button className="ibtn sm" title="Draw on frame" aria-pressed={!!penOn} onClick={() => { pb.setPlaying(false); onPen?.(); }} style={{ minWidth: 30, minHeight: 30, ...(penOn ? { background: "var(--paper-050)", color: "var(--ink-900)" } : {}) }}><Icon n="pencil" size={16} /></button>
    </div>
    <button className="send" title="Send" onClick={() => setText("")}><Icon n="send" size={17} /></button>
  </div>;
}

/** The notes a viewer may see: a Guest reviewer sees public notes only (Note visibility). */
function visibleNotes(role) { return role === "guest" ? NOTES.filter((n) => !n.internal) : NOTES; }
/** Open notes on the latest Version, among the notes the viewer may see (glossary: Open note). */
function openCount(role) { return visibleNotes(role).filter((n) => !n.done).length; }

/** A status dot, coloured by Review status. */
function StatusDot({ status = "in_review" }) {
  const c = { in_review: "var(--tone-info)", approved_internal: "var(--tone-positive)", published: "var(--greige-300)" }[status];
  return <span title={STATUS[status][0]} style={{ width: 7, height: 7, borderRadius: 4, background: c, flex: "none", display: "inline-block" }}></span>;
}

/** The iOS keyboard, as a grey block with key rows. Static. */
function Keyboard() {
  const row = (n, inset = 0) => <div style={{ display: "flex", gap: 6, padding: `0 ${inset}px` }}>{Array.from({ length: n }, (_, i) => <span key={i} style={{ flex: 1, height: 42, borderRadius: 5, background: "#5a5a5e" }}></span>)}</div>;
  return <div style={{ height: 291, flex: "none", background: "#2b2b2d", padding: "8px 4px", display: "grid", alignContent: "start", gap: 11 }}>
    {row(10)}{row(9, 18)}{row(7, 52)}
    <div style={{ display: "flex", gap: 6 }}><span style={{ width: 90, height: 42, borderRadius: 5, background: "#444447" }}></span><span style={{ flex: 1, height: 42, borderRadius: 5, background: "#5a5a5e" }}></span><span style={{ width: 90, height: 42, borderRadius: 5, background: "#444447" }}></span></div>
  </div>;
}

function DeliveryPanel() {
  return <div style={{ padding: 16, display: "grid", gap: 14 }}>
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 13, color: "var(--fg2)" }}>Client decision on v3</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="pill tone-caution"><span className="dot"></span>Awaiting decision</span></div>
    </div>
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 13, color: "var(--fg2)" }}>Release</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="ibtn solid">Release v3 to client</button><button className="ibtn outline">Mark premium</button></div>
    </div>
    <div style={{ fontSize: 13, color: "var(--fg2)" }}>Payment reference, decision notes and the release history sit here as today.</div>
  </div>;
}

function PhoneFrame({ children, land, safari = "full", time = "8:55" }) {
  return <div className={`phone${land ? " land" : ""}`}>
    <div className="phone-screen" data-surface="inverse">
      <div className="phone-status"><span>{time}</span><span className="phone-island"></span><span style={{ fontSize: 12, letterSpacing: 1 }}>●●● ▮</span></div>
      <div className="phone-body">{children}</div>
      {safari === "full" && <div className="safari"><span className="safari-btn"></span><span className="safari-pill">quincy.flamingfire.my</span><span className="safari-btn"></span></div>}
      {safari === "compact" && <div className="safari compact">quincy.flamingfire.my</div>}
      <span className="phone-home"></span>
    </div>
  </div>;
}

/** Bottom action sheet inside a phone. */
function ActionSheet({ title, rows, onClose }) {
  return <div className="scrim" onClick={onClose}>
    <div className="asheet" onClick={(e) => e.stopPropagation()}>
      {title && <div className="asheet-title">{title}</div>}
      {rows.map((r, i) => r === "-" ? <div key={i} className="asep"></div> : <button key={i} className="arow" onClick={() => { r.onClick?.(); onClose(); }} style={r.danger ? { color: "var(--tone-critical)" } : null}>{r.icon && <Icon n={r.icon} size={19} />}<span>{r.label}</span>{r.sub && <span className="sub">{r.sub}</span>}{r.check && <Icon n="check" size={18} style={{ marginLeft: r.sub ? 8 : "auto" }} />}</button>)}
    </div>
  </div>;
}

/** Vertical drag on a handle: reports a px delta from where the drag began. */
function useDrag(onMove, onEnd) {
  const start = useRef(null);
  return {
    onPointerDown: (e) => { start.current = e.clientY; e.currentTarget.setPointerCapture?.(e.pointerId); },
    onPointerMove: (e) => { if (start.current !== null) onMove(e.clientY - start.current); },
    onPointerUp: () => { if (start.current !== null) { start.current = null; onEnd(); } },
    onPointerCancel: () => { start.current = null; onEnd(); },
  };
}

Object.assign(window, { Icon, tc, short, FILM, NOTES, STATUS, usePlayback, Film, Scrubber, StatusPill, StatusDot, NoteItem, NotesFilter, Composer, DeliveryPanel, PhoneFrame, ActionSheet, useDrag, visibleNotes, openCount, Keyboard });
