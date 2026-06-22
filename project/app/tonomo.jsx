/* =====================================================================
   Quincy Portal — Tonomo webhook ingestion  →  window.QP
   A new booking in Tonomo fires a webhook; the portal maps the order
   payload into a Quincy project (created at "Awaiting RAW").
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  /* ---- a real sample order, as Tonomo fires it (trimmed to mapped fields) */
  QP.TONOMO_SAMPLE = {
    id: "dPLBzV433abICLEJf5Jr",
    orderId: "dPLBzV433abICLEJf5Jr",
    orderNo: "000050",
    orderStatus: "inProgress",
    paymentStatus: "unpaid",
    order_name: "29 Bay St, Mosman NSW 2088, Australia - Henriette Solheim",
    date: "Thursday, 21 May, 2026",
    scheduled_time: "10:00 am - 12:00 pm",
    when: { start_time: 1779321600, end_time: 1779328800, object: "timespan" },
    invoice_amount: 3076.43,
    isTaxInclusive: true,
    property_square_footage: "250",
    rawFolderLink: "",
    rawFolderPath: "",
    property_feature_notes: "day footage between 10am - 12pm & dusk arrival from 4:50pm for 5pm shoot.",
    entry_notes: "Agent onsite",
    coverImage: "https://firebasestorage.googleapis.com/v0/b/quincy-productions.firebasestorage.app/o/deliverables%2FdPLBzV433abICLEJf5Jr%2FWEB_2_1024x768_2y4z.webp?alt=media&token=b9e240ad-dd2f-4d84-bd0e-817d96b279b7",
    client_full_name: "Henriette",
    email: "henriette.solheim@raywhite.com",
    bookingFlow: { id: "NRVIrYOQNuvF6QEDjgf8", name: "Ray White Lower North Shore", type: "property" },
    customQuestions: [
      { label: "Listing Agent Contact Details + Site Agent Contact Details:", type: "textarea", value: "Bernard Ryan and Benoit Guittonneau" },
    ],
    property_address: {
      formatted_address: "29 Bay St, Mosman NSW 2088, Australia",
      street: "29 Bay Street", city: "Mosman", state: "New South Wales",
      zipcode: "2088", country: "AU", lat: -33.817275, lng: 151.2404818,
      timezone: "Australia/Sydney",
    },
    listingAgents: [
      { displayName: "Henriette Solheim", email: "henriette.solheim@raywhite.com", phone: "+61432809840",
        photoURL: "https://firebasestorage.googleapis.com/v0/b/quincy-productions.firebasestorage.app/o/images%2FWlH6f7AEtkTEgKoTubBPF7QJrV53?alt=media&token=90f5d536-0575-48c1-9c6c-4da3390706a4",
        uid: "WlH6f7AEtkTEgKoTubBPF7QJrV53" },
    ],
    photographers: [
      { id: "F7yieOUsvbWYfi39H0gxlda6EHn1", name: "Andrew Vassiliades", email: "andrew@quincyproductions.com.au" },
      { id: "VeBvS0E9IJezQJL4jxTrz2W01h92", name: "Igor Melo", email: "igor@quincyproductions.com.au" },
    ],
    services_a_la_cart: [
      "Listing Images", "Drone Images - Daylight", "Listing Images - Dawn/Dusk",
      "Cinematic Videography", "Social Media Cut/Reel", "2D Floorplans",
      "Copywriting - Offsite", "Dusk/Dawn Footage",
    ],
    deliverablesLinks: [
      { name: "2D Floorplans", type: "Floor Plan" },
      { name: "29 Bay Street, Mosman", type: "PDF" },
      { name: "Cinematic Videography master", type: "Video" },
      { name: "Social media cut / reel", type: "Video" },
      { name: "Listing Images", type: "Photos" },
      { name: "Drone Images - Daylight", type: "Photos" },
    ],
  };

  /* ---- a second sample: order WITH a Dropbox RAW folder -------------- */
  QP.TONOMO_SAMPLE_2 = {
    id: "HJbb9eBGIJrGFG3elwwF",
    orderId: "HJbb9eBGIJrGFG3elwwF",
    orderNo: "000078",
    orderStatus: "pending",
    paymentStatus: "unpaid",
    order_name: "17 Oxford St, Bondi Junction NSW 2022, Australia - Stephanie Farah",
    date: "Friday, 12 Jun, 2026",
    scheduled_time: "",
    when: { start_time: 1781220600, end_time: 1781234100, object: "timespan" },
    invoice_amount: 1366.85,
    isTaxInclusive: true,
    property_square_footage: "200",
    rawFolderLink: "https://www.dropbox.com/scl/fo/p4o7e98ecwkbisx80vody/AKU76O9OJgTonStLkJ4LN3M?rlkey=0xzztznpigxqdulk44failmt5&dl=0",
    rawFolderPath: "/tonomo/raw files/igor melo/12-06-2026/17 oxford st, bondi junction nsw 2022, australia",
    property_feature_notes: "--",
    entry_notes: "--",
    coverImage: "https://firebasestorage.googleapis.com/v0/b/quincy-productions.firebasestorage.app/o/deliverables%2FHJbb9eBGIJrGFG3elwwF%2FImage__1024x768_guaoi.webp?alt=media&token=b1c560d1-9d54-47c5-a0db-093c121d1104",
    client_full_name: "Stephanie Farah",
    email: "stephanie@ngfarah.com.au",
    bookingFlow: { id: "lfdgkIFXPGXCq0XSb2GR", name: "NG Farah", type: "property" },
    customQuestions: [],
    property_address: {
      formatted_address: "17 Oxford St, Bondi Junction NSW 2022, Australia",
      street: "17 Oxford Street", city: "Bondi Junction", state: "New South Wales",
      zipcode: "2022", country: "AU", lat: -33.8907542, lng: 151.2429981,
      timezone: "Australia/Sydney",
    },
    listingAgents: [
      { displayName: "Stephanie Farah", email: "stephanie@ngfarah.com.au", phone: "+61405470398",
        brokerage: "NG Farah", licenseNumber: "Partner & Sales Executive",
        uid: "VNN5hZOOOkTNarH77baS2M9LuJa2" },
    ],
    photographers: [
      { id: "VeBvS0E9IJezQJL4jxTrz2W01h92", name: "Igor Melo", email: "igor@quincyproductions.com.au" },
    ],
    services_a_la_cart: ["2D Floorplans", "Copywriting - Onsite", "Listing Images"],
    deliverablesLinks: [
      { name: "2D Floorplans", type: "Floor Plan" },
      { name: "Listing Images", type: "Photos" },
    ],
  };

  QP.TONOMO_ORDERS = [QP.TONOMO_SAMPLE_2, QP.TONOMO_SAMPLE];

  /* ---- service → which Quincy collection it maps to ------------------ */
  QP.TONOMO_SERVICES = {
    "Listing Images":            { icon: "image",  kind: "photo" },
    "Drone Images - Daylight":   { icon: "image",  kind: "photo" },
    "Listing Images - Dawn/Dusk":{ icon: "image",  kind: "photo" },
    "Cinematic Videography":     { icon: "video",  kind: "video" },
    "Social Media Cut/Reel":     { icon: "video",  kind: "video" },
    "Dusk/Dawn Footage":         { icon: "video",  kind: "video" },
    "2D Floorplans":             { icon: "folder", kind: "floorplan" },
    "Copywriting - Offsite":     { icon: "text",   kind: "copy" },
    "Copywriting - Onsite":      { icon: "text",   kind: "copy" },
  };

  const COVER_POOL = () => [QP.IMG.gale, QP.IMG.silva, QP.IMG.bronte, QP.IMG.holkham, QP.IMG.alex];

  /* ---- normalize a Tonomo order → Quincy project --------------------- */
  QP.fromTonomo = function fromTonomo(o) {
    const addr = o.property_address || {};
    const la = (o.listingAgents && o.listingAgents[0]) || {};
    const start = o.when && o.when.start_time ? new Date(o.when.start_time * 1000) : new Date();
    const shoot = start.toISOString().slice(0, 10);
    const orderId = o.orderId || o.id;
    const services = o.services_a_la_cart || [];
    const photographer = (o.photographers && o.photographers[0] && o.photographers[0].name) || "Unassigned";
    const siteQ = (o.customQuestions || []).find((q) => /site agent|agent contact/i.test(q.label || ""));
    const pool = COVER_POOL();
    const cover = pool[(orderId || "").length % pool.length];

    const hasFloor = services.some((s) => QP.TONOMO_SERVICES[s] && QP.TONOMO_SERVICES[s].kind === "floorplan");

    // a freshly-created project: empty RAW, optional floorplan placeholder, draft copy
    const collections = [
      { id: "raw", name: "RAW", kind: "photo", note: "Awaiting upload from photographer", photos: [] },
    ];
    if (hasFloor) collections.push({ id: "floorplan", name: "Floorplan", kind: "plan", note: "Ordered · 2D floorplan", photos: [] });

    return {
      id: "qp-" + orderId,
      slug: "qp-" + orderId,
      street: addr.street || (o.order_name || "").split(",")[0] || "New booking",
      suburb: addr.city || "",
      postcode: addr.zipcode || "",
      cover,
      agency: (o.bookingFlow && o.bookingFlow.name) || "—",
      agent: la.displayName || o.client_full_name || "—",
      email: la.email || o.email || "",
      shoot,
      status: "awaiting_raw",
      stage: 0,
      price: null,
      photographer,
      photographerInitials: photographer.split(" ").map((x) => x[0]).join("").slice(0, 2),
      copy: { status: "draft", headline: "", body: "", features: [] },
      editing: null,
      collections,
      allPhotos: [],
      // booking metadata carried from Tonomo
      tonomo: {
        source: "Tonomo",
        orderNo: o.orderNo,
        orderId,
        orderStatus: o.orderStatus,
        paymentStatus: o.paymentStatus,
        invoice: o.invoice_amount,
        taxInclusive: o.isTaxInclusive,
        scheduledTime: o.scheduled_time,
        dateLabel: o.date,
        sqft: o.property_square_footage,
        services,
        photographers: o.photographers || [],
        siteAgent: siteQ ? siteQ.value : "",
        agentPhone: la.phone || "",
        featureNotes: o.property_feature_notes || "",
        entryNotes: o.entry_notes || "",
        formattedAddress: addr.formatted_address || "",
        coverImage: o.coverImage || "",
        rawFolderLink: o.rawFolderLink || "",
        rawFolderPath: o.rawFolderPath || "",
      },
    };
  };

  /* small helpers for the modal */
  function field(o, path, dflt) { return path.split(".").reduce((a, k) => (a == null ? a : a[k]), o) ?? dflt; }

  /* ===================================================================
     WEBHOOK MODAL — "New booking received from Tonomo"
     =================================================================== */
  QP.TonomoModal = function TonomoModal({ orders, existingIds, onCreate, onClose }) {
    const { Button } = DS();
    const list = orders || [QP.TONOMO_SAMPLE];
    const [sel, setSel] = useState(0);
    const order = list[sel];
    const [phase, setPhase] = useState("incoming");   // incoming → mapped
    const [showRaw, setShowRaw] = useState(false);
    const mapped = QP.fromTonomo(order);
    const exists = existingIds.includes(mapped.id);
    const t = mapped.tonomo;

    React.useEffect(() => {
      setPhase("incoming");
      const id = setTimeout(() => setPhase("mapped"), 1100);
      return () => clearTimeout(id);
    }, [sel]);

    const rawJson = JSON.stringify(order, null, 2);

    const serviceList = t.services.map((s) => ({ name: s, meta: QP.TONOMO_SERVICES[s] || { icon: "info", kind: "other" } }));

    return (
      <div className="scrim" onClick={onClose}>
        <div className="modal modal--wide tmodal" onClick={(e) => e.stopPropagation()}>
          <div className="modal__head">
            <div className="ey row gap2" style={{ marginBottom: 10 }}>
              <span className="tonomo-dot" /> Webhook · Tonomo
            </div>
            <h3 className="serif">{phase === "incoming" ? "Receiving booking…" : "New booking received"}</h3>
            {list.length > 1 && (
              <div className="segment" style={{ marginTop: 14 }}>
                {list.map((o, i) => (
                  <button key={o.orderId} className={i === sel ? "is-active" : ""} onClick={() => { setSel(i); setShowRaw(false); }}>
                    Order {o.orderNo}{o.rawFolderLink ? " · RAW folder" : ""}
                  </button>
                ))}
              </div>
            )}
          </div>

          {phase === "incoming" ? (
            <div className="modal__body">
              <div className="tincoming">
                <div className="tincoming__pulse"><Icon name="arrow" size={20} /></div>
                <div>
                  <div style={{ fontSize: 15 }}>POST <span className="mono">/webhooks/tonomo/order.created</span></div>
                  <div className="ey muted" style={{ marginTop: 4 }}>Order {order.orderNo} · {field(order, "bookingFlow.name", "")}</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="modal__body">
              {exists && <div className="tbanner"><Icon name="info" size={15} /> A project for this order already exists. Creating it again will add a duplicate.</div>}

              {/* mapped preview */}
              <div className="tmap">
                <div className="tmap__cover"><img src={mapped.cover} alt="" /></div>
                <div className="tmap__head">
                  <div className="ey">{t.orderNo} · {t.formattedAddress}</div>
                  <h4 className="serif">{mapped.street}</h4>
                  <div className="ey muted">{mapped.suburb} · {mapped.postcode} NSW</div>
                </div>
              </div>

              <div className="tgrid">
                <Row k="Client" v={`${mapped.agent}`} sub={mapped.agency} />
                <Row k="Agent email" v={mapped.email} />
                <Row k="Shoot" v={t.dateLabel} sub={t.scheduledTime} />
                <Row k="Photographer" v={t.photographers.map((p) => p.name).join(" · ") || mapped.photographer} />
                <Row k="Order value" v={t.invoice != null ? QP.fmtAUD(Math.round(t.invoice)) + (t.taxInclusive ? " inc. GST" : "") : "—"} sub={t.paymentStatus} />
                <Row k="Site agent" v={t.siteAgent || "—"} />
              </div>

              {t.rawFolderLink && (
                <div className="trawfolder">
                  <Icon name="dropbox" size={16} />
                  <div style={{ minWidth: 0 }}>
                    <div className="ey" style={{ marginBottom: 3 }}>Dropbox RAW folder · from Tonomo</div>
                    <div className="mono trawfolder__path">{t.rawFolderPath}</div>
                  </div>
                  <span className="tag-sm nowrap">Sync-ready</span>
                </div>
              )}

              {(t.featureNotes || t.entryNotes) && (
                <div className="tnotes">
                  <div className="ey" style={{ marginBottom: 6 }}>Notes</div>
                  {t.featureNotes && <p>{t.featureNotes}</p>}
                  {t.entryNotes && <p className="muted">{t.entryNotes}</p>}
                </div>
              )}

              <div className="tservices">
                <div className="ey" style={{ marginBottom: 8 }}>Ordered services <span className="cnt muted">{serviceList.length}</span></div>
                <div className="row gap2" style={{ flexWrap: "wrap" }}>
                  {serviceList.map((s) => (
                    <span key={s.name} className="chip" style={{ cursor: "default" }}><Icon name={s.meta.icon} size={13} /> {s.name}</span>
                  ))}
                </div>
              </div>

              <button className="traw-toggle" onClick={() => setShowRaw((v) => !v)}>
                <Icon name={showRaw ? "down" : "right"} size={14} /> {showRaw ? "Hide" : "View"} webhook payload
              </button>
              {showRaw && <pre className="traw">{rawJson}</pre>}
            </div>
          )}

          <div className="modal__foot">
            <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="md" iconLeft={<Icon name="plus" size={15} />}
              onClick={() => onCreate(order)} disabled={phase !== "mapped"}>
              Create project
            </Button>
          </div>
        </div>
      </div>
    );

    function Row({ k, v, sub }) {
      return (
        <div className="trow">
          <div className="ey">{k}</div>
          <div className="trow__v">{v}{sub ? <span className="trow__sub"> · {sub}</span> : null}</div>
        </div>
      );
    }
  };
})();
