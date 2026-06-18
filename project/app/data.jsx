/* =====================================================================
   Quincy Portal — data, roles, icons, helpers  →  window.QP
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
  const POOL = [IMG.kings, IMG.moverly, IMG.holkham, IMG.alex, IMG.varna, IMG.bronte, IMG.silva, IMG.gale];
  QP.IMG = IMG;

  /* ===================================================================
     ROLES — drive access gating across the app
     =================================================================== */
  QP.ROLES = {
    admin: {
      id: "admin", label: "Admin", who: "Jordan Quincy", initials: "JQ", role: "Quincy · Admin",
      tabs: ["raw", "edited", "floorplan", "copy", "video"],
      seesAll: true, canUploadRaw: true, canSelectForEdit: true, canQAEdited: true,
      canManageExtras: true, canPublish: true, canCompare: true,
    },
    photographer: {
      id: "photographer", label: "Photographer", who: "Daniel Reyes", initials: "DR", role: "Quincy · Photographer",
      tabs: ["raw"],                       // RAW only — nothing else
      seesAll: false, canUploadRaw: true, canSelectForEdit: false, canQAEdited: false,
      canManageExtras: false, canPublish: false, canCompare: true,
    },
    editor: {
      id: "editor", label: "Editor / QA", who: "Mia Albright", initials: "MA", role: "Quincy · Editor & QA",
      tabs: ["raw", "edited", "floorplan", "copy", "video"],
      seesAll: true, canUploadRaw: true, canSelectForEdit: true, canQAEdited: true,
      canManageExtras: true, canPublish: true, canCompare: true,
    },
    client: {
      id: "client", label: "Client", who: "Agent", initials: "AG", role: "Client",
      tabs: [], seesAll: false,
    },
  };

  /* ===================================================================
     PIPELINE STATUSES
     =================================================================== */
  QP.STATUS = {
    awaiting_raw:  { label: "Awaiting RAW",   tone: "outline",  dot: "var(--greige-300)", stage: 0 },
    raw_review:    { label: "RAW review",     tone: "caution",  dot: "var(--signal-caution)", stage: 1 },
    editing:       { label: "Editing · autoHDR", tone: "info",  dot: "var(--signal-info)", stage: 2 },
    edited_review: { label: "Edited review",  tone: "caution",  dot: "var(--signal-caution)", stage: 3 },
    client_review: { label: "Client review",  tone: "info",     dot: "var(--signal-info)", stage: 4 },
    delivered:     { label: "Delivered",      tone: "positive", dot: "var(--signal-positive)", stage: 5 },
  };
  QP.STAGE_ORDER = ["awaiting_raw", "raw_review", "editing", "edited_review", "client_review", "delivered"];

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

  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  const ROOMS = ["Facade","Entry","Living","Living — aspect","Kitchen","Dining","Master suite","Ensuite","Bedroom 2","Bedroom 3","Bathroom","Study","Terrace","Pool","Garden","Twilight","Aerial","Detail"];

  function makePhotos(seed, coll, count, coverFirst) {
    const r = rng(seed); const out = [];
    for (let i = 0; i < count; i++) {
      const src = coverFirst && i === 0 ? coverFirst : POOL[Math.floor(r() * POOL.length)];
      out.push({
        id: `${coll}-${seed}-${i}`, n: i + 1, src, coll,
        cap: ROOMS[i % ROOMS.length],
        pos: `${Math.round(20 + r() * 60)}% ${Math.round(20 + r() * 60)}%`,
      });
    }
    return out;
  }

  /* ---- projects ------------------------------------------------------ */
  // status drives which collections are populated (RAW always; edited/video/copy
  // appear once a shoot reaches editing+).
  const RAW = [
    { id: "p-alex", street: "27/10 Alexander Street", suburb: "Coogee", postcode: "2034", cover: IMG.alex,
      agency: "NGFarah", agent: "Andrew Liveris", email: "andrew@ngfarah.com.au",
      shoot: "2026-06-16", status: "raw_review", price: 1895000, seed: 88, photographer: "Daniel Reyes" },
    { id: "p-bronte", street: "4/188 Bronte Road", suburb: "Waverley", postcode: "2024", cover: IMG.bronte,
      agency: "The Agency Eastern Suburbs", agent: "Ben Collier", email: "ben.collier@theagency.com.au",
      shoot: "2026-06-14", status: "editing", price: 1620000, seed: 99, photographer: "Daniel Reyes" },
    { id: "p-kings", street: "9 Kings Road", suburb: "Vaucluse", postcode: "2030", cover: IMG.kings,
      agency: "Sotheby's International", agent: "Michael Pallier", email: "m.pallier@sothebys.com.au",
      shoot: "2026-06-10", status: "edited_review", price: 14250000, seed: 31, photographer: "Daniel Reyes" },
    { id: "p-moverly", street: "22 Moverly Road", suburb: "Maroubra", postcode: "2035", cover: IMG.moverly,
      agency: "McGrath Coogee", agent: "Bethwyn Richards", email: "bethwyn@mcgrath.com.au",
      shoot: "2026-06-04", status: "client_review", price: 3680000, seed: 67, photographer: "Elise Moreau" },
    { id: "p-holkham", street: "2/2 Holkham Avenue", suburb: "Randwick", postcode: "2031", cover: IMG.holkham,
      agency: "Ray White Eastern Beaches", agent: "Tony Tannous", email: "tony.t@raywhite.com",
      shoot: "2026-05-28", status: "delivered", price: 2150000, seed: 12, photographer: "Daniel Reyes", delivered: "2026-05-30" },
    { id: "p-varna", street: "1/61–67 Varna Street", suburb: "Clovelly", postcode: "2024", cover: IMG.varna,
      agency: "Bresic Whitney", agent: "Adrian Tsavalas", email: "adrian@bresicwhitney.com.au",
      shoot: "2026-05-26", status: "delivered", price: 2740000, seed: 45, photographer: "Elise Moreau", delivered: "2026-05-28" },
  ];

  const COPY_SAMPLES = {
    "p-kings": { status: "published", file: "9-kings-road-vaucluse-copy.pdf", pages: 2, headline: "An architectural landmark above Sydney Harbour",
      body: "Set behind private gates in Vaucluse's tightly held lower slopes, 9 Kings Road is a study in restraint and light. Floor-to-ceiling glazing dissolves the line between the living pavilion and the harbour beyond, while honed travertine and American oak carry a warm, tactile calm through every room. A whole-floor master wing, infinity pool and self-contained guest accommodation complete a residence built for the long view.",
      features: ["Uninterrupted harbour and city-skyline outlook", "Whole-floor master retreat with dressing room", "Infinity-edge pool and travertine terrace", "Off-street parking for five vehicles"] },
    "p-moverly": { status: "published", file: "22-moverly-road-maroubra-copy.pdf", pages: 1, headline: "Coastal calm, minutes from Maroubra Beach",
      body: "A relaxed family home rebuilt for indoor–outdoor living, 22 Moverly Road pairs a north-facing rear garden with a generous open kitchen and a flexible downstairs retreat. Quietly positioned yet moments from the sand, transport and the village.",
      features: ["North-facing landscaped rear garden", "Stone island kitchen with butler's pantry", "Four bedrooms plus downstairs flexi-room"] },
    "p-bronte": { status: "draft", headline: "", body: "", features: [] },
  };

  const VIDEO_SAMPLES = {
    "p-kings": [
      { id: "v-kings-1", title: "Cinematic property film", dur: "1:48", poster: IMG.kings, vimeo: "vimeo.com/quincy/9kingsroad", premium: false },
      { id: "v-kings-2", title: "Twilight aerial — drone", dur: "0:42", poster: IMG.silva, vimeo: "vimeo.com/quincy/9kingsroad-aerial", premium: true, price: 350 },
      { id: "v-kings-3", title: "Agent walk-through", dur: "2:30", poster: IMG.holkham, vimeo: "vimeo.com/quincy/9kingsroad-walk", premium: false },
    ],
    "p-moverly": [
      { id: "v-mov-1", title: "Property highlight reel", dur: "1:12", poster: IMG.moverly, vimeo: "vimeo.com/quincy/22moverly", premium: false },
      { id: "v-mov-2", title: "Social vertical cut", dur: "0:30", poster: IMG.varna, vimeo: "vimeo.com/quincy/22moverly-social", premium: true, price: 180 },
    ],
  };

  QP.PROJECTS = RAW.map((p) => {
    const st = p.status, stage = QP.STATUS[st].stage;
    const rawCount = 32, edCount = 24;
    const raw = makePhotos(p.seed, "raw", rawCount, p.cover);
    const edited = stage >= 2 ? makePhotos(p.seed + 500, "edited", edCount, p.cover) : [];
    // premium add-on frames on the edited set (twilight / aerial / detail extras)
    edited.forEach((ph) => { if (["Twilight", "Aerial", "Detail"].includes(ph.cap)) { ph.premium = true; ph.price = 60; } });
    const floor = makePhotos(p.seed + 900, "floorplan", 2).map((f) => ({ ...f, floorplan: true, cap: "Floorplan" }));
    const videos = VIDEO_SAMPLES[p.id] || (stage >= 2 ? [{ id: p.id + "-v1", title: "Property film", dur: "1:20", poster: p.cover, vimeo: "vimeo.com/quincy/" + p.id, premium: false }] : []);

    const collections = [
      { id: "raw", name: "RAW", kind: "photo", note: `Camera RAW · ${rawCount} frames · unedited`, photos: raw },
    ];
    if (stage >= 2) collections.push({ id: "edited", name: "Edited", kind: "photo", note: `autoHDR · retouched · ${edCount} frames`, photos: edited });
    if (stage >= 2) collections.push({ id: "video", name: "Video", kind: "video", note: "Cinematic film & social cuts", items: videos });
    collections.push({ id: "floorplan", name: "Floorplan", kind: "plan", note: "Vector PDF + JPEG", photos: floor });

    // autoHDR editing state
    let editing = null;
    if (st === "editing") editing = { sent: 26, returned: 0, status: "processing", sentAt: "2026-06-15T16:20:00" };
    else if (stage >= 3) editing = { sent: edCount, returned: edCount, status: "returned", sentAt: p.shoot + "T18:00:00" };

    return {
      ...p, slug: p.id, stage,
      photographerInitials: p.photographer.split(" ").map((x) => x[0]).join(""),
      copy: COPY_SAMPLES[p.id] || { status: "draft", headline: "", body: "", features: [] },
      editing,
      collections,
      allPhotos: collections.filter((c) => c.photos).flatMap((c) => c.photos),
    };
  });
  QP.projectById = (id) => QP.PROJECTS.find((p) => p.id === id);
  QP.collOf = (project, id) => project.collections.find((c) => c.id === id);

  /* ---- seeded state -------------------------------------------------- */
  // states[photoId] = { selected, state, rating, label }
  //   RAW frames use `selected` (chosen to send to autoHDR)
  //   Edited frames use `state`/`rating`/`label` (QA decision)
  function seedReview() {
    const states = {}, comments = {}, favs = {}, purchases = {};
    QP.PROJECTS.forEach((p) => {
      const r = rng(p.seed + 7);
      // RAW selections (for projects at raw_review and beyond)
      const raw = QP.collOf(p, "raw");
      if (raw && p.stage >= 1) raw.photos.forEach((ph, i) => {
        const roll = r();
        states[ph.id] = {
          selected: p.stage >= 2 ? roll < 0.75 : roll < 0.5,
          rating: roll < 0.3 ? 5 : roll < 0.6 ? 4 : 0,
          pick: p.id === "p-alex" ? roll < 0.45 : (p.stage === 1 ? roll < 0.2 : false),
        };
      });
      // Edited QA states
      const ed = QP.collOf(p, "edited");
      if (ed) ed.photos.forEach((ph, i) => {
        const roll = r();
        const st = p.stage >= 4 ? "approved" : roll < 0.6 ? "approved" : roll < 0.72 ? "flagged" : null;
        states[ph.id] = { state: st, rating: roll < 0.4 ? 5 : roll < 0.7 ? 4 : 0,
          label: roll < 0.18 ? "hero" : roll < 0.32 ? "select" : null };
        if (p.id === "p-moverly" && (i === 1 || i === 4)) favs[ph.id] = true;
      });
    });

    // RAW annotations — photographer + QA dialogue (this is the photographer demo)
    const aRaw = QP.collOf(QP.projectById("p-alex"), "raw").photos;
    comments[aRaw[0].id] = [
      { id: "ca1", who: "Daniel Reyes", role: "Photographer", text: "Bracketed 5-stop for HDR — this is the hero facade angle the agent asked for.", drawing: [{ color: "#e64b3c", width: 4, points: [{x:30,y:24},{x:70,y:24},{x:70,y:72},{x:30,y:72},{x:30,y:24}] }], at: "2026-06-16T17:30:00" },
    ];
    comments[aRaw[2].id] = [
      { id: "ca2", who: "Daniel Reyes", role: "Photographer", text: "Two options for the living — prefer this one, the light's cleaner.", at: "2026-06-16T17:34:00" },
      { id: "ca3", who: "Mia Albright", role: "Editor & QA", text: "Agreed, selecting this for edit. Holding the other.", at: "2026-06-17T09:10:00" },
    ];
    comments[aRaw[5].id] = [
      { id: "ca4", who: "Daniel Reyes", role: "Photographer", text: "Reshoot if needed — slight reflection in the splashback, marked it.", drawing: [{ color: "#f0a020", width: 5, points: [{x:58,y:44},{x:66,y:40},{x:72,y:46}] }], at: "2026-06-16T17:40:00" },
    ];

    // Edited QA dialogue on Kings Road
    const kEd = QP.collOf(QP.projectById("p-kings"), "edited").photos;
    comments[kEd[0].id] = [
      { id: "ck1", who: "Mia Albright", role: "Editor & QA", text: "autoHDR came back clean. Pushed the twilight sky a touch warmer — approving.", drawing: [{ color: "#e64b3c", width: 4, points: [{x:74,y:30},{x:72,y:40},{x:67,y:47},{x:60,y:50},{x:53,y:47},{x:48,y:40},{x:46,y:30},{x:48,y:20},{x:53,y:13},{x:60,y:10},{x:67,y:13},{x:72,y:20},{x:74,y:30}] }], at: "2026-06-12T11:12:00" },
    ];
    comments[kEd[3].id] = [
      { id: "ck2", who: "Mia Albright", role: "Editor & QA", text: "Downpipe still showing on the left — flagging for a re-edit before publish.", drawing: [{ color: "#f0a020", width: 5, points: [{x:13,y:22},{x:13,y:40},{x:14,y:58},{x:13,y:74}] }], at: "2026-06-12T11:40:00" },
    ];
    return { states, comments, favs, purchases };
  }
  QP.seedReview = seedReview;

  /* aggregate selection (RAW) + QA (edited) stats */
  QP.rawStats = (project, states) => {
    const raw = QP.collOf(project, "raw"); if (!raw) return { total: 0, selected: 0, pct: 0 };
    const total = raw.photos.length;
    const selected = raw.photos.filter((p) => states[p.id]?.selected).length;
    return { total, selected, pct: Math.round((selected / total) * 100) };
  };
  QP.reviewStats = (project, states) => {
    const ed = QP.collOf(project, "edited");
    if (!ed) { const rs = QP.rawStats(project, states); return { total: rs.total, approved: rs.selected, flagged: 0, pending: rs.total - rs.selected, pct: rs.pct, raw: true }; }
    let approved = 0, flagged = 0, pending = 0;
    ed.photos.forEach((p) => { const s = states[p.id]?.state; if (s === "approved") approved++; else if (s === "flagged") flagged++; else pending++; });
    return { total: ed.photos.length, approved, flagged, pending, pct: Math.round((approved / ed.photos.length) * 100), raw: false };
  };
  QP.mediaCount = (project) => project.collections.reduce((n, c) => n + (c.photos ? c.photos.length : (c.items ? c.items.length : 0)), 0);

  /* ===================================================================
     ICONS
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
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="1"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    flag: '<path d="M4 21V4m0 1h13l-2.5 4L17 13H4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
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
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    video: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="m16 10 6-3v10l-6-3z"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="4" y="10" width="16" height="11" rx="1"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
    cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.4 12.5a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.2L22 7H6"/>',
    text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    wand: '<path d="M15 4V2M15 10V8M11 6H9M21 6h-2M18.5 3.5 17 5M18.5 8.5 17 7M13 9 3 19l2 2L15 11z"/>',
    select: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="m9 12 2 2 4-4"/>',
    check2: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
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
