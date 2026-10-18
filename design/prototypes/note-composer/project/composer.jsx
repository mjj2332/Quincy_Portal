/* The note composer (Frame.io-style box). Live: type, select text for the bubble, press in/out, add media, draw, pick visibility, send. */
const VIS = {
  internal: { label: "Internal", icon: "lock", desc: "Studio only — never shown on the client link." },
  public: { label: "Client-visible", icon: "globe", desc: "Shown to the client on the review link." },
};
const FMT = [
  ["bold", "Bold (⌘B)", "bold"], ["italic", "Italic (⌘I)", "italic"], ["strike", "Strikethrough (⌘⇧X)", "strikeThrough"], ["link", "Link (⌘K)", "createLink"],
  "|", ["list", "Bulleted list", "insertUnorderedList"], ["list-ordered", "Numbered list", "insertOrderedList"],
];
const PENS = [["#e64b3c", "Red"], ["#f0a020", "Amber"], ["#3f8f5a", "Green"], ["#2f6df0", "Blue"], ["#ffffff", "White"], ["#0a0a0a", "Black"]];
const TOOLS = [["freehand", "Pen", "pencil"], ["arrow", "Arrow", "arrow-up-right"], ["line", "Line", "minus"], ["rectangle", "Rectangle", "square"]];
const KIND_ICON = { image: "image", video: "film" };
const size = (b) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;

/** The drawing on the frame: tool, colour, strokes, undo / redo. Shared by the film's layer and the composer's drawing row. */
function useMarkup(init = {}) {
  const [on, setOn] = useState(!!init.on);
  const [tool, setTool] = useState(init.tool || "freehand");
  const [color, setColor] = useState(init.color || "#e64b3c");
  const [strokes, setStrokes] = useState(init.strokes || []);
  const [undone, setUndone] = useState([]);
  return {
    on, setOn, tool, setTool, color, setColor, strokes,
    add: (s) => { setStrokes((x) => [...x, s]); setUndone([]); },
    undo: () => { if (!strokes.length) return; setUndone([...undone, strokes[strokes.length - 1]]); setStrokes(strokes.slice(0, -1)); },
    redo: () => { if (!undone.length) return; setStrokes([...strokes, undone[undone.length - 1]]); setUndone(undone.slice(0, -1)); },
    clear: () => { setStrokes([]); setUndone([]); },
    canUndo: strokes.length > 0, canRedo: undone.length > 0,
  };
}

/** The film as the canvas while the pen is on. Coordinates are percentages of the layer. */
function DrawLayer({ mk }) {
  const ref = useRef(null);
  const [live, setLive] = useState(null);
  const at = (e) => { const r = ref.current.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100]; };
  const down = (e) => { if (!mk.on) return; e.stopPropagation(); ref.current.setPointerCapture?.(e.pointerId); const p = at(e); setLive({ tool: mk.tool, color: mk.color, pts: [p, p] }); };
  const move = (e) => { if (!live) return; const p = at(e); setLive((s) => ({ ...s, pts: s.tool === "freehand" ? [...s.pts, p] : [s.pts[0], p] })); };
  const up = () => { if (live) { mk.add(live); setLive(null); } };
  const all = live ? [...mk.strokes, live] : mk.strokes;
  return <svg ref={ref} className="draw-layer" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ pointerEvents: mk.on ? "auto" : "none", cursor: mk.on ? "crosshair" : "default" }}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onClick={(e) => mk.on && e.stopPropagation()}>
    {all.map((s, i) => {
      if (!s.pts?.length) return null;
      const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
      const common = { stroke: s.color, strokeWidth: 3, fill: "none", vectorEffect: "non-scaling-stroke", strokeLinecap: "round", strokeLinejoin: "round" };
      if (s.tool === "freehand") return <polyline key={i} points={s.pts.map((p) => p.join(",")).join(" ")} {...common} />;
      if (s.tool === "rectangle") return <rect key={i} x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} {...common} />;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), h = 3.2;
      return <g key={i}><line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...common} />
        {s.tool === "arrow" && <polyline points={`${b[0] - h * Math.cos(ang - 0.5)},${b[1] - h * Math.sin(ang - 0.5)} ${b[0]},${b[1]} ${b[0] - h * Math.cos(ang + 0.5)},${b[1] - h * Math.sin(ang + 0.5)}`} {...common} />}</g>;
    })}
  </svg>;
}

/** The formatting bubble. Desktop: floats above the selection. Phone: docks to the box's top edge, clear of iOS's own Copy / Paste callout. */
function Bubble({ pos, docked, onCmd, active = {} }) {
  const style = docked ? { left: 0, bottom: "calc(100% + 8px)" } : { left: pos.left, top: pos.top };
  return <div className="cmp-bubble" role="toolbar" aria-label="Format text" style={style} onMouseDown={(e) => e.preventDefault()}>
    {FMT.map((f, i) => f === "|" ? <span key={i} className="sep"></span>
      : <button key={f[0]} title={f[1]} aria-label={f[1]} aria-pressed={!!active[f[0]]} onClick={() => onCmd(f)}><Icon n={f[0]} size={docked ? 18 : 16} /></button>)}
  </div>;
}

/** The pen colours. On a phone the row has no room for Clear, so it lives here, under the swatches. */
function Palette({ mk, phone, onClose }) {
  return <div className="cmp-palette" role="dialog" aria-label="Pen colour">
    <div className="sws">{PENS.map(([c, n]) => <button key={c} className="sw-btn" title={n} aria-label={n} aria-pressed={mk.color === c} onClick={() => { mk.setColor(c); onClose(); }}><span className="sw" style={{ background: c }}></span></button>)}</div>
    {phone && <button className="pal-clear" disabled={!mk.canUndo} onClick={() => { mk.clear(); onClose(); }}><Icon n="trash" size={16} />Clear drawing</button>}
  </div>;
}

/**
 * variant: "staff" | "guest" (no visibility) | "reply" (media + Send only) | "edit" (static visibility, Cancel / Save).
 * pb: the playback clock. mk: the markup state when the film's layer shares it. floating: Full screen's box over the film.
 * demo: a starting state for a frame — { html, marks, files, visibility, menu, palette, focus, markup, sel: { html, bubble, active } }.
 */
function NoteComposer({ pb, variant = "staff", phone = false, floating = false, demo = {}, mk: mkProp, placeholder }) {
  const own = useMarkup(demo.markup);
  const mk = mkProp || own;
  const [marks, setMarks] = useState(demo.marks || { in: null, out: null });
  const [files, setFiles] = useState(demo.files || []);
  const [vis, setVis] = useState(demo.visibility || "internal");
  const [menu, setMenu] = useState(!!demo.menu);
  const [palette, setPalette] = useState(!!demo.palette);
  const [empty, setEmpty] = useState(!(demo.html || demo.sel));
  const [anchor, setAnchor] = useState(demo.html || demo.sel || demo.files || demo.markup ? 5 : null);
  const [bubble, setBubble] = useState(demo.sel ? { ...demo.sel.bubble, fake: true } : null);
  const [active, setActive] = useState(demo.sel?.active || {});
  const box = useRef(null), ed = useRef(null), fileIn = useRef(null);
  const t = pb.t;
  const reply = variant === "reply", edit = variant === "edit";
  const ph = placeholder ?? (reply ? "Reply…" : phone ? "Add a note…" : "Add a note at this frame… Use @ to mention a colleague.");

  useEffect(() => { if (ed.current && (demo.html || demo.sel)) ed.current.innerHTML = demo.sel ? demo.sel.html : demo.html; }, []);

  // The live bubble: shown while a non-empty selection sits inside the field.
  useEffect(() => {
    if (demo.sel) return undefined;
    const onSel = () => {
      const s = document.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount || !ed.current?.contains(s.anchorNode)) { setBubble(null); return; }
      const r = s.getRangeAt(0).getBoundingClientRect(), b = box.current.getBoundingClientRect();
      const w = 230;
      setBubble({ left: Math.max(0, Math.min(b.width - w, r.left - b.left + r.width / 2 - w / 2)), top: r.top - b.top - 44 });
      setActive({ bold: document.queryCommandState("bold"), italic: document.queryCommandState("italic"), strike: document.queryCommandState("strikeThrough"), list: document.queryCommandState("insertUnorderedList"), "list-ordered": document.queryCommandState("insertOrderedList") });
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const drawn = mk.strokes.length > 0;
  const onInput = () => {
    const has = ed.current.textContent.trim() !== "" || ed.current.querySelector("li");
    if (!has && ed.current.innerHTML !== "") ed.current.innerHTML = "";
    setEmpty(!has);
    if (has && anchor === null) { setAnchor(t); pb.setPlaying?.(false); }
  };
  const cmd = ([name, , exec]) => {
    if (bubble?.fake) return;
    if (name === "link") document.execCommand("createLink", false, "https://"); else document.execCommand(exec);
    onInput();
  };

  // In / out: first press marks In at the playhead (Out follows the playhead), second marks Out, third clears. I and O still work from the keyboard.
  const inOut = () => {
    pb.setPlaying?.(false);
    if (marks.in === null) setMarks({ in: t, out: null });
    else if (marks.out === null) setMarks(t < marks.in ? { in: t, out: marks.in } : { in: marks.in, out: t });
    else setMarks({ in: null, out: null });
  };
  const ranged = marks.in !== null;
  const pencil = drawn ? <Icon n="pencil" size={11} stroke={2.25} /> : null;
  const chip = reply ? null : ranged
    ? <span className="cmp-chip" contentEditable={false}>{pencil}{tc(marks.in)} → <span className={marks.out === null ? "live" : ""}>{tc(marks.out ?? Math.max(t, marks.in))}</span>
      <button className="x" title="Clear in / out" aria-label="Clear in and out" onMouseDown={(e) => e.preventDefault()} onClick={() => setMarks({ in: null, out: null })}><Icon n="close" size={11} stroke={2.25} /></button></span>
    : <span className="cmp-chip" title={anchor === null && !drawn ? "Follows the playhead until you start the note" : "The note is stamped here"}>{pencil}{tc(anchor ?? t)}</span>;

  const pen = () => { pb.setPlaying?.(false); if (anchor === null) setAnchor(t); setMenu(false); mk.setOn(true); };
  const pickFiles = (e) => { const list = [...e.target.files].map((f, i) => ({ id: `${Date.now()}-${i}`, name: f.name, kind: f.type.startsWith("video/") ? "video" : "image", size: size(f.size) })); setFiles((x) => [...x, ...list]); if (anchor === null) setAnchor(t); e.target.value = ""; };
  const canSend = !empty || files.length > 0 || drawn;
  const send = () => { if (!canSend) return; ed.current.innerHTML = ""; setEmpty(true); setFiles([]); mk.clear(); mk.setOn(false); setMarks({ in: null, out: null }); setAnchor(null); setVis("internal"); setBubble(null); };
  const v = VIS[vis];
  const ic = phone ? 20 : 18;

  const normalRow = <div className="cmp-row">
    {!reply && <button className="cmp-tool" title={ranged ? (marks.out === null ? "Set out (O)" : "Clear in / out") : "Set in (I)"} aria-label="In and out points" aria-pressed={ranged} onClick={inOut}><Icon n="in-out" size={ic} /></button>}
    <button className="cmp-tool" title="Add photos or videos" aria-label="Add photos or videos" onClick={() => fileIn.current.click()}><Icon n="paperclip" size={ic} /></button>
    {!reply && <button className="cmp-tool" title="Draw on the frame" aria-label="Draw on the frame" onClick={pen}><Icon n="pencil" size={ic} /></button>}
    <span className="cmp-sp"></span>
    {variant === "staff" && <span style={{ position: "relative" }}>
      <button className="cmp-vis" aria-haspopup="menu" aria-expanded={menu} title="Who can see this note" onClick={() => setMenu(!menu)}><Icon n={v.icon} size={14} />{v.label}<Icon n="chevron-down" size={12} /></button>
      {menu && <div className="cmp-menu" role="menu">
        {Object.entries(VIS).map(([k, o]) => <button key={k} className="cmp-opt" role="menuitemradio" aria-checked={vis === k} onClick={() => { setVis(k); setMenu(false); }}>
          <Icon n={o.icon} size={16} /><div><b>{o.label}</b><span>{o.desc}</span></div>{vis === k ? <Icon n="check" size={16} /> : <i></i>}
        </button>)}
      </div>}
    </span>}
    {edit && <span className="cmp-vis static" title="Visibility can't change once posted"><Icon n={v.icon} size={14} />{v.label}</span>}
    {edit
      ? <><button className="cmp-text-btn">Cancel</button><button className="cmp-save" disabled={!canSend}>Save</button></>
      : <button className="cmp-send" title="Post (⌘↵)" aria-label={reply ? "Send reply" : "Post note"} disabled={!canSend} onClick={send}><Icon n="send" size={phone ? 17 : 15} /></button>}
  </div>;

  // The drawing row replaces the tools while the pen is on (Frame.io). Visibility and Send hide; the text stays editable.
  const drawRow = <div className="cmp-row cmp-draw" role="toolbar" aria-label="Drawing">
    <button className="cmp-tool" title="Done drawing (Esc)" aria-label="Done drawing" onClick={() => { mk.setOn(false); setPalette(false); }}><Icon n="chevron-left" size={ic} /></button>
    <span className="cmp-sep"></span>
    <span role="radiogroup" aria-label="Drawing tool" className="grp">{TOOLS.map(([k, l, i]) => <button key={k} className="cmp-tool" role="radio" aria-checked={mk.tool === k} title={l} aria-label={l} onClick={() => mk.setTool(k)}><Icon n={i} size={ic} /></button>)}</span>
    <span className="cmp-sep"></span>
    <span style={{ position: "relative" }}>
      <button className="cmp-tool" title="Pen colour" aria-label="Pen colour" aria-expanded={palette} onClick={() => setPalette(!palette)}><span className="sw" style={{ background: mk.color }}></span></button>
      {palette && <Palette mk={mk} phone={phone} onClose={() => setPalette(false)} />}
    </span>
    <span className="cmp-sep"></span>
    <button className="cmp-tool" title="Undo (⌘Z)" aria-label="Undo" disabled={!mk.canUndo} onClick={mk.undo}><Icon n="undo" size={ic} /></button>
    <button className="cmp-tool" title="Redo (⇧⌘Z)" aria-label="Redo" disabled={!mk.canRedo} onClick={mk.redo}><Icon n="redo" size={ic} /></button>
    {!phone && <button className="cmp-tool" title="Clear drawing" aria-label="Clear drawing" disabled={!mk.canUndo} onClick={mk.clear}><Icon n="trash" size={ic} /></button>}
  </div>;

  return <div className={`cmp-wrap${phone ? " cmp-phone" : ""}${floating ? " cmp-floating" : ""}`}>
    <div ref={box} className={`cmp${demo.focus ? " focus" : ""}`}>
      {bubble && <Bubble pos={bubble} docked={phone} onCmd={cmd} active={active} />}
      <div className="cmp-text">
        {chip}
        <div ref={ed} className="cmp-edit" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={reply ? "Reply" : "Add a note"} data-ph={ph}
          onInput={onInput} onFocus={() => pb.setPlaying?.(false)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } if (e.key === "Escape" && mk.on) mk.setOn(false); }}></div>
      </div>
      {files.length > 0 && <div className="cmp-files">
        {files.map((f) => <span key={f.id} className="cmp-file" title={f.name}><span className="thumb"><Icon n={KIND_ICON[f.kind]} size={15} /></span><span className="nm">{f.name}</span><span className="meta">{f.size}</span><button className="rm" title="Remove" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}><Icon n="close" size={14} /></button></span>)}
      </div>}
      {mk.on ? drawRow : normalRow}
      <input ref={fileIn} type="file" multiple accept="image/*,video/*" hidden onChange={pickFiles} />
    </div>
  </div>;
}

/** The desktop player bar, minus the in/out and pen buttons (they live in the composer now). `fullscreen` adds Add note. */
function PlayerBar({ pb, fullscreen, addNote, onAddNote }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <button className="ibtn sm" title="Previous frame (←)"><Icon n="step-back" size={17} /></button>
    <button className="ibtn sm" title="Play (Space)" onClick={pb.toggle} style={{ background: "var(--paper-050)", color: "var(--ink-900)", minWidth: 44, borderRadius: 10 }}><Icon n={pb.playing ? "pause" : "play"} size={17} /></button>
    <button className="ibtn sm" title="Next frame (→)"><Icon n="step-forward" size={17} /></button>
    <span className="tc" style={{ fontSize: 14, padding: "0 8px" }}>{tc(pb.t)} <span style={{ color: "var(--fg2)" }}>/ {tc(pb.duration)}</span></span>
    <div className="hints" style={{ marginLeft: 6 }}>
      <span><i className="kbd">J</i><i className="kbd">K</i><i className="kbd">L</i>shuttle</span>
      <span><i className="kbd">←</i><i className="kbd">→</i>frame</span>
      <span><i className="kbd">Space</i>play</span>
      <span><i className="kbd">I</i><i className="kbd">O</i>in/out</span>
      <span><i className="kbd">F</i>full screen</span>
    </div>
    <span style={{ flex: 1 }}></span>
    <button className="ibtn sm" title="Mute (M)"><Icon n="volume-2" size={17} /></button>
    <button className="ibtn sm" title={fullscreen ? "Exit full screen (F)" : "Full screen (F)"}><Icon n={fullscreen ? "minimize" : "maximize"} size={17} /></button>
    {fullscreen && <button className="ibtn outline" aria-pressed={addNote} onClick={onAddNote}><Icon n="square-pen" size={16} />Add note</button>}
  </div>;
}

Object.assign(window, { NoteComposer, PlayerBar, DrawLayer, useMarkup, VIS });
