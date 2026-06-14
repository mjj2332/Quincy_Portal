/* =====================================================================
   Quincy Portal — data, icons, helpers  →  window.QP
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState } = React;

  /* resource resolver: prefers an inlined blob (standalone export) but falls
     back to the live path/URL so the normal app keeps working */
  QP.res = (id, fallback) => (window.__resources && window.__resources[id]) || fallback;

  /* ---- real Quincy cover photography (hotlinked from delivery CDN) ---- */
  const IMG = {
    kings:   QP.res("cover_kings",   "https://images.pixieset.com/547295311/473e55f7e7598d6cfed79dc408bc350a-cover.jpg"),
    moverly: QP.res("cover_moverly", "https://images.pixieset.com/465563901/f172680bbe83b84f44858d1635950c72-cover.jpg"),
    holkham: QP.res("cover_holkham", "https://images.pixieset.com/973503901/94ad740fc2094281fe6830be9e60a4d8-cover.jpg"),
    alex:    QP.res("cover_alex",    "https://images.pixieset.com/033503901/080b542d4029ea37cfc7bba0305e50d1-cover.jpg"),
    varna:   QP.res("cover_varna",   "https://images.pixieset.com/049542901/dccb42d8587b6522059cbc868daeb080-cover.jpg"),
    bronte:  QP.res("cover_bronte",  "https://images.pixieset.com/698542901/e58ab2e92c9e093502addf539905fe5f-cover.jpg"),
    silva:   QP.res("cover_silva",   "https://images.pixieset.com/268542901/2453f238e328a2f33561790ad5e7448c-cover.jpg"),
    gale:    QP.res("cover_gale",    "https://images.pixieset.com/884391901/34892c0a585b3b62f709d6e88c72c890-cover.jpg"),
  };
  // pooled luxury interiors used to populate gallery grids
  const POOL = [IMG.kings, IMG.moverly, IMG.holkham, IMG.alex, IMG.varna, IMG.bronte, IMG.silva, IMG.gale];
  QP.IMG = IMG;

  /* ---- status meta --------------------------------------------------- */
  QP.STATUS = {
    editing:       { label: "Editing",       tone: "ink",      dot: "var(--greige-400)" },
    in_review:     { label: "In review",     tone: "caution",  dot: "var(--signal-caution)" },
    client_review: { label: "Client review", tone: "info",     dot: "var(--signal-info)" },
    delivered:     { label: "Delivered",     tone: "positive", dot: "var(--signal-positive)" },
  };

  QP.LABELS = [
    { id: "select", name: "Select",  color: "var(--signal-positive)" },
    { id: "maybe",  name: "Maybe",   color: "var(--signal-caution)" },
    { id: "reject", name: "Cut",     color: "var(--signal-critical)" },
    { id: "hero",   name: "Hero",    color: "var(--signal-info)" },
  ];
  QP.labelById = (id) => QP.LABELS.find((l) => l.id === id);

  /* ---- helpers ------------------------------------------------------- */
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  QP.fmtDate = (iso) => { const d = new Date(iso); const n = d.getDate(); const s = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"; return `${n}${s} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  QP.fmtShort = (iso) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`; };
  QP.fmtAUD = (n) => "$" + n.toLocaleString("en-AU");
  QP.cx = (...a) => a.filter(Boolean).join(" ");

  // deterministic pseudo-random
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  const ROOMS = ["Facade","Entry","Living","Living — aspect","Kitchen","Dining","Master suite","Ensuite","Bedroom 2","Bedroom 3","Bathroom","Study","Terrace","Pool","Garden","Twilight","Aerial","Detail"];

  function makePhotos(seed, coll, count, coverFirst) {
    const r = rng(seed);
    const out = [];
    for (let i = 0; i < count; i++) {
      const src = coverFirst && i === 0 ? coverFirst : POOL[Math.floor(r() * POOL.length)];
      const ox = Math.round(20 + r() * 60), oy = Math.round(20 + r() * 60);
      out.push({
        id: `${coll}-${seed}-${i}`,
        n: i + 1,
        src,
        coll,
        cap: ROOMS[i % ROOMS.length],
        pos: `${ox}% ${oy}%`,
      });
    }
    return out;
  }

  /* ---- projects (real Quincy Eastern-Suburbs shoots) ----------------- */
  const RAW = [
    { id: "p-kings", street: "9 Kings Road", suburb: "Vaucluse", postcode: "2030", cover: IMG.kings,
      agency: "Sotheby's International", agent: "Michael Pallier", email: "m.pallier@sothebys.com.au",
      shoot: "2026-04-28", status: "in_review", price: 14250000, seed: 31 },
    { id: "p-moverly", street: "22 Moverly Road", suburb: "Maroubra", postcode: "2035", cover: IMG.moverly,
      agency: "McGrath Coogee", agent: "Bethwyn Richards", email: "bethwyn@mcgrath.com.au",
      shoot: "2026-02-12", status: "client_review", price: 3680000, seed: 67 },
    { id: "p-holkham", street: "2/2 Holkham Avenue", suburb: "Randwick", postcode: "2031", cover: IMG.holkham,
      agency: "Ray White Eastern Beaches", agent: "Tony Tannous", email: "tony.t@raywhite.com",
      shoot: "2026-02-11", status: "delivered", price: 2150000, seed: 12, delivered: "2026-02-13" },
    { id: "p-alex", street: "27/10 Alexander Street", suburb: "Coogee", postcode: "2034", cover: IMG.alex,
      agency: "NGFarah", agent: "Andrew Liveris", email: "andrew@ngfarah.com.au",
      shoot: "2026-02-11", status: "editing", price: 1895000, seed: 88 },
    { id: "p-varna", street: "1/61–67 Varna Street", suburb: "Clovelly", postcode: "2024", cover: IMG.varna,
      agency: "Bresic Whitney", agent: "Adrian Tsavalas", email: "adrian@bresicwhitney.com.au",
      shoot: "2026-02-10", status: "delivered", price: 2740000, seed: 45, delivered: "2026-02-12" },
    { id: "p-bronte", street: "4/188 Bronte Road", suburb: "Waverley", postcode: "2024", cover: IMG.bronte,
      agency: "The Agency Eastern Suburbs", agent: "Ben Collier", email: "ben.collier@theagency.com.au",
      shoot: "2026-02-10", status: "in_review", price: 1620000, seed: 99 },
  ];

  QP.PROJECTS = RAW.map((p) => {
    const web = makePhotos(p.seed, "web", 24, p.cover);
    const print = makePhotos(p.seed + 500, "print", 18, p.cover);
    const floor = makePhotos(p.seed + 900, "floorplan", 2).map((f) => ({ ...f, floorplan: true, cap: "Floorplan" }));
    return {
      ...p,
      slug: p.id,
      photographer: ["Jcourse Q.", "Daniel R.", "Elise M."][p.seed % 3],
      collections: [
        { id: "web", name: "Web", note: "Web-optimised JPEG · 2048px", photos: web },
        { id: "print", name: "Print", note: "Full-resolution · 300dpi", photos: print },
        { id: "floorplan", name: "Floorplan", note: "Vector PDF + JPEG", photos: floor },
      ],
      allPhotos: [...web, ...print, ...floor],
    };
  });
  QP.projectById = (id) => QP.PROJECTS.find((p) => p.id === id);

  /* ---- seeded review state (so the review surface looks worked-on) --- */
  // shape: { [photoId]: { state:'approved'|'flagged'|null, rating:0-5, label:id|null } }
  // comments: { [photoId]: [ {id, who, role, text, pin:{x,y}|null, at} ] }
  function seedReview() {
    const states = {}, comments = {}, favs = {};
    QP.PROJECTS.forEach((p) => {
      if (p.status === "editing") return;
      const r = rng(p.seed + 7);
      p.collections.find((c) => c.id === "web").photos.forEach((ph, i) => {
        const roll = r();
        let st = null;
        if (p.status !== "editing") {
          st = roll < 0.62 ? "approved" : roll < 0.72 ? "flagged" : null;
        }
        const rating = roll < 0.4 ? 5 : roll < 0.7 ? 4 : roll < 0.85 ? 3 : 0;
        const label = roll < 0.18 ? "hero" : roll < 0.32 ? "select" : roll > 0.9 ? "maybe" : null;
        states[ph.id] = { state: st, rating, label };
        if (p.id === "p-moverly" && (i === 1 || i === 4)) favs[ph.id] = true;
      });
    });
    // a few worked comments on the active review project
    const k = QP.projectById("p-kings").collections[0].photos;
    comments[k[0].id] = [
      { id: "c1", who: "James", role: "Quincy", text: "Hero frame — circled the twilight sky to push warmer. Top of the set.", drawing: [{ color: "#e64b3c", width: 4, points: [{x:74,y:30},{x:72,y:40},{x:67,y:47},{x:60,y:50},{x:53,y:47},{x:48,y:40},{x:46,y:30},{x:48,y:20},{x:53,y:13},{x:60,y:10},{x:67,y:13},{x:72,y:20},{x:74,y:30}] }], at: "2026-04-29T09:12:00" },
      { id: "c2", who: "Michael Pallier", role: "Sotheby's", text: "Agreed. Can we warm the sky a touch at twilight?", at: "2026-04-29T10:02:00" },
    ];
    comments[k[3].id] = [
      { id: "c3", who: "James", role: "Quincy", text: "Marked the downpipe on the left — cropping it out in the retouch.", drawing: [{ color: "#f0a020", width: 5, points: [{x:13,y:22},{x:13,y:40},{x:14,y:58},{x:13,y:74}] }], at: "2026-04-29T09:40:00" },
    ];
    comments[k[6].id] = [
      { id: "c4", who: "Michael Pallier", role: "Sotheby's", text: "Love this. Approved from our side.", pin: null, at: "2026-04-29T11:20:00" },
    ];
    const m = QP.projectById("p-moverly").collections[0].photos;
    comments[m[4].id] = [
      { id: "c5", who: "Bethwyn Richards", role: "McGrath", text: "One more wide of the living looking back to the kitchen — arrow shows the angle.", drawing: [{ color: "#2f6df0", width: 4, points: [{x:82,y:74},{x:64,y:56}] }, { color: "#2f6df0", width: 4, points: [{x:64,y:56},{x:71,y:57}] }, { color: "#2f6df0", width: 4, points: [{x:64,y:56},{x:65,y:49}] }], at: "2026-02-13T14:02:00" },
    ];
    return { states, comments, favs };
  }
  QP.seedReview = seedReview;

  /* aggregate review counts for a project's web collection */
  QP.reviewStats = (project, states) => {
    const photos = project.collections.find((c) => c.id === "web").photos;
    let approved = 0, flagged = 0, pending = 0;
    photos.forEach((ph) => {
      const s = states[ph.id]?.state;
      if (s === "approved") approved++; else if (s === "flagged") flagged++; else pending++;
    });
    return { total: photos.length, approved, flagged, pending, pct: Math.round((approved / photos.length) * 100) };
  };

  /* ---- print store products ------------------------------------------ */
  QP.PRINTS = [
    { id: "a4", name: "Fine-art print", size: "A4 · 210×297mm", price: 45 },
    { id: "a3", name: "Fine-art print", size: "A3 · 297×420mm", price: 75 },
    { id: "a2", name: "Gallery print", size: "A2 · 420×594mm", price: 140 },
    { id: "frame", name: "Framed — oak", size: "A3 · museum glass", price: 240 },
  ];

  /* ===================================================================
     ICONS — thin 1.5px line set (Lucide-style, the DS house UI set)
     =================================================================== */
  const P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    heart: '<path d="M19 14c1.5-1.5 3-3.3 3-5.5A4.5 4.5 0 0 0 12 5.7 4.5 4.5 0 0 0 2 8.5C2 12 6 15 12 20c2-1.6 4-3.3 5.5-4.8"/>',
    download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5"/>',
    play: '<path d="M6 4v16l13-8z"/>',
    comment: '<path d="M21 11.5a8 8 0 0 1-11.6 7.1L3 21l2.4-6.4A8 8 0 1 1 21 11.5z"/>',
    star: '<path d="m12 3 2.6 5.6 6 .7-4.4 4.1 1.2 6L12 16.8 6.6 19.4l1.2-6L3.4 9.3l6-.7z"/>',
    compare: '<path d="M12 3v18M3 7l4-2v14l-4-2zM21 7l-4-2v14l4-2z"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14m0 0-6-6m6 6-6 6"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    link: '<path d="M9 15l6-6M10 7l1-1a4 4 0 0 1 6 6l-1 1M14 17l-1 1a4 4 0 0 1-6-6l1-1"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="1"/><circle cx="9" cy="9" r="2"/><path d="m21 16-5-5L5 21"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    printer: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M6 14h12v7H6z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="1"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    flag: '<path d="M4 21V4m0 1h13l-2.5 4L17 13H4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    sort: '<path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/>',
    zoom: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
    bag: '<path d="M6 8h12l-1 12H7zM9 8V6a3 3 0 0 1 6 0v2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    pin: '<path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    undo: '<path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.3-9.3L3 7"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="1"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    upload: '<path d="M12 19V7m0 0 4 4m-4-4-4 4M5 3h14"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  };
  QP.Icon = function Icon({ name, size = 18, fill = "none", style, strokeWidth = 1.6 }) {
    return React.createElement("svg", {
      width: size, height: size, viewBox: "0 0 24 24", fill: fill === "none" ? "none" : "currentColor",
      stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", style,
      dangerouslySetInnerHTML: { __html: P[name] || "" },
    });
  };

  /* ---- persistence hook ---------------------------------------------- */
  QP.useStored = function (key, initial) {
    const [v, setV] = useState(() => {
      try { const raw = localStorage.getItem("qp:" + key); return raw ? JSON.parse(raw) : initial; }
      catch (e) { return initial; }
    });
    const set = (next) => setV((prev) => {
      const val = typeof next === "function" ? next(prev) : next;
      try { localStorage.setItem("qp:" + key, JSON.stringify(val)); } catch (e) {}
      return val;
    });
    return [v, set];
  };
})();
