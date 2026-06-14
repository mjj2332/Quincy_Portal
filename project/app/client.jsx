/* =====================================================================
   Quincy Portal — Client gallery (delivery)  →  window.QP.Client
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState, useEffect, useRef } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  QP.Client = function Client({ project, favs, toggleFav, density, theme = "paper", captions = true }) {
    const { Button } = DS();
    const [coll, setColl] = useState("web");
    const [favOnly, setFavOnly] = useState(false);
    const [viewer, setViewer] = useState(null);
    const [slideshow, setSlideshow] = useState(false);
    const [dl, setDl] = useState(null);     // download modal {scope}
    const [order, setOrder] = useState(null); // order modal {photo}
    const [share, setShare] = useState(false);
    const [scrolled, setScrolled] = useState(false);

    const collection = project.collections.find((c) => c.id === coll);
    let photos = collection.photos;
    if (favOnly) photos = photos.filter((p) => favs[p.id]);
    const favCount = project.allPhotos.filter((p) => favs[p.id]).length;

    useEffect(() => {
      const fn = () => setScrolled(window.scrollY > 80);
      window.addEventListener("scroll", fn); return () => window.removeEventListener("scroll", fn);
    }, []);

    const quickDownload = (p) => QP.toast("Frame downloading", { sub: `${p.cap} · ${coll === "print" ? "Full-res" : "Web-size"}`, icon: "download" });

    return (
      <div className={cx("client", theme === "ink" && "client--ink")} style={{ paddingBottom: 0 }}>
        {/* ---- hero ---- */}
        <header className="chero">
          <div className="chero__bg"><img src={project.cover} alt={project.street} /></div>
          <div className="chero__scrim" />
          <a className="chero__credit" href="#"><img src={QP.res("wmWhite", "assets/logos/quincy-wordmark-white.png")} alt="Quincy Productions" /></a>
          <div className="chero__inner">
            <div className="chero__eyebrow">{project.suburb} · {project.postcode} · {QP.fmtDate(project.shoot)}</div>
            <h1 className="chero__title">{project.street}</h1>
            <div className="chero__sub">
              <span>{project.agency}</span>
              <span style={{ opacity: .4 }}>—</span>
              <span style={{ color: "var(--text-on-inverse-muted)" }}>{collection.photos.length} frames · captured by {project.photographer}</span>
            </div>
            <div className="chero__actions">
              <Button variant="inverse" size="lg" iconLeft={<Icon name="download" size={16} />} onClick={() => setDl({ scope: "all" })}>Download all</Button>
              <Button variant="ghost" size="lg" style={{ color: "var(--paper-050)", borderColor: "rgba(246,244,239,.4)" }} iconLeft={<Icon name="play" size={15} />} onClick={() => { setViewer(0); setSlideshow(true); }}>Slideshow</Button>
              <button className="icbtn icbtn--lg icbtn--ondark" title="Share" onClick={() => setShare(true)}><Icon name="share" size={17} /></button>
            </div>
          </div>
        </header>

        {/* ---- sticky collection bar ---- */}
        <div className="cbar">
          <div className="ctabs">
            {project.collections.map((c) => (
              <div key={c.id} className={cx("ctab", coll === c.id && "is-active")} onClick={() => { setColl(c.id); setFavOnly(false); }}>
                {c.name} <span className="cnt">{c.photos.length}</span>
              </div>
            ))}
          </div>
          <div className="toolbar">
            <button className={cx("chip", favOnly && "is-active")} onClick={() => setFavOnly((f) => !f)} disabled={favCount === 0 && !favOnly}>
              <Icon name="heart" size={13} fill={favOnly ? "currentColor" : "none"} /> Favourites <span className="cnt">{favCount}</span>
            </button>
            <button className="icbtn" title="Slideshow" onClick={() => { setViewer(0); setSlideshow(true); }}><Icon name="play" size={16} /></button>
            <button className="icbtn" title="Download" onClick={() => setDl({ scope: favOnly ? "favourites" : "all" })}><Icon name="download" size={16} /></button>
            <button className="icbtn" title="Share" onClick={() => setShare(true)}><Icon name="share" size={16} /></button>
          </div>
        </div>

        {/* ---- gallery ---- */}
        <div className="cgallery">
          {photos.length === 0
            ? <div className="empty"><span className="serif">No favourites yet.</span>Tap the heart on a frame to start a selection.</div>
            : (
              <div className="grid" style={{ "--cols": density === "comfortable" ? 3 : density === "dense" ? 5 : 4, "--gap": "16px" }}>
                {photos.map((p) => (
                  <QP.PhotoTile key={p.id} photo={p} mode="client" showCaption={captions}
                    fav={!!favs[p.id]} onFav={() => toggleFav(p.id)} onQuickDownload={() => quickDownload(p)}
                    onOpen={() => { setViewer(collection.photos.indexOf(p)); setSlideshow(false); }} />
                ))}
              </div>
            )}
        </div>

        {/* ---- footer ---- */}
        <footer className="cfoot">
          <div className="cfoot__top">
            <div>
              <img src={QP.res("wmWhite", "assets/logos/quincy-wordmark-white.png")} alt="Quincy Productions" />
              <p style={{ marginTop: 16, maxWidth: 360, fontSize: 14, lineHeight: 1.6 }}>Luxury real estate &amp; architectural media. Sydney's Eastern Suburbs.</p>
            </div>
            <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 8, fontSize: 13.5 }}>
              <a href="#">info@quincyproductions.com.au</a>
              <a href="#">quincyproductions.com.au</a>
              <div className="ey" style={{ marginTop: 10, color: "var(--greige-400)" }}>Instagram · Vimeo · LinkedIn</div>
            </div>
          </div>
          <hr className="hairline" style={{ borderColor: "rgba(246,244,239,.14)", margin: "32px 0 18px" }} />
          <div className="cfoot__top" style={{ fontSize: 12 }}>
            <span className="ey" style={{ color: "var(--greige-400)" }}>© Quincy Productions 2026</span>
            <span className="ey" style={{ color: "var(--greige-400)" }}>Delivered with the Quincy Portal</span>
          </div>
        </footer>

        {/* lightbox / slideshow */}
        {viewer !== null && (
          slideshow
            ? <Slideshow photos={collection.photos} index={viewer} setIndex={setViewer} project={project} onClose={() => { setSlideshow(false); setViewer(null); }} />
            : <QP.ImageViewer mode="client" project={project} photos={collection.photos} index={viewer}
                onIndex={setViewer} onClose={() => setViewer(null)}
                favs={favs} onFav={toggleFav} onDownload={quickDownload} onOrder={(p) => { setViewer(null); setOrder({ photo: p }); }} />
        )}

        {dl && <DownloadModal project={project} coll={coll} scope={dl.scope} favCount={favCount} onClose={() => setDl(null)} />}
        {order && <OrderModal project={project} photo={order.photo} onClose={() => setOrder(null)} />}
        {share && <ShareModal project={project} onClose={() => setShare(false)} />}
      </div>
    );
  };

  /* ---- slideshow (auto-advancing fullscreen) ------------------------- */
  function Slideshow({ photos, index, setIndex, project, onClose }) {
    const [playing, setPlaying] = useState(true);
    const photo = photos[index];
    useEffect(() => {
      if (!playing) return;
      const t = setTimeout(() => setIndex((index + 1) % photos.length), 3600);
      return () => clearTimeout(t);
    }, [index, playing]);
    useEffect(() => {
      const fn = (e) => { if (e.key === "Escape") onClose(); if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); } if (e.key === "ArrowRight") setIndex((index + 1) % photos.length); if (e.key === "ArrowLeft") setIndex((index - 1 + photos.length) % photos.length); };
      window.addEventListener("keydown", fn); return () => window.removeEventListener("keydown", fn);
    });
    return (
      <div className="viewer no-panel" style={{ gridTemplateRows: "1fr" }}>
        <div className="viewer__stage">
          <button className="icbtn icbtn--ondark viewer__close" onClick={onClose}><Icon name="x" size={18} /></button>
          <div className="viewer__meta"><div className="a serif">{project.street}</div><div className="b">{photo.cap} · {String(index + 1).padStart(2,"0")} / {photos.length}</div></div>
          <div className="viewer__imgwrap" style={{ padding: 0 }}>
            <img key={photo.id} className="viewer__img" src={photo.src} alt={photo.cap} style={{ objectPosition: photo.pos, animation: "fade 800ms ease" }} />
          </div>
          <div style={{ position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 5, display: "flex", gap: 10 }}>
            <button className="icbtn icbtn--ondark" onClick={() => setIndex((index - 1 + photos.length) % photos.length)}><Icon name="left" size={18} /></button>
            <button className="icbtn icbtn--ondark icbtn--lg" onClick={() => setPlaying((p) => !p)}><Icon name={playing ? "compare" : "play"} size={18} /></button>
            <button className="icbtn icbtn--ondark" onClick={() => setIndex((index + 1) % photos.length)}><Icon name="right" size={18} /></button>
          </div>
        </div>
      </div>
    );
  }

  /* ---- download modal ------------------------------------------------ */
  function DownloadModal({ project, coll, scope, favCount, onClose }) {
    const { Button } = DS();
    const [size, setSize] = useState(coll === "print" ? "full" : "web");
    const [sc, setSc] = useState(scope);
    const [pct, setPct] = useState(null);
    const collObj = project.collections.find((c) => c.id === coll);
    const n = sc === "favourites" ? favCount : collObj.photos.length;

    const start = () => {
      setPct(0);
      let p = 0;
      const t = setInterval(() => { p += Math.random() * 22 + 8; if (p >= 100) { p = 100; clearInterval(t); setTimeout(() => { onClose(); QP.toast("Download ready", { sub: `${n} frames · ${size === "full" ? "Full-resolution" : "Web-size"} · .zip`, icon: "download" }); }, 450); } setPct(Math.min(100, Math.round(p))); }, 240);
    };

    return (
      <QP.Modal eyebrow={`${project.street} · ${project.suburb}`} title="Download gallery" onClose={onClose}
        footer={pct === null ? <>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" iconLeft={<Icon name="download" size={15} />} onClick={start}>Prepare {n} frames</Button>
        </> : null}>
        {pct === null ? (
          <>
            <div className="optrow">
              <div className="ey">Resolution</div>
              <div className="optcards">
                <div className={cx("optcard", size === "web" && "is-on")} onClick={() => setSize("web")}><div className="t">Web-size</div><div className="d">2048px · for portals &amp; socials</div></div>
                <div className={cx("optcard", size === "full" && "is-on")} onClick={() => setSize("full")}><div className="t">Full-resolution</div><div className="d">Original · for print</div></div>
              </div>
            </div>
            <div className="optrow">
              <div className="ey">Scope</div>
              <div className="optcards">
                <div className={cx("optcard", sc === "all" && "is-on")} onClick={() => setSc("all")}><div className="t">Entire collection</div><div className="d">{collObj.photos.length} frames</div></div>
                <div className={cx("optcard", sc === "favourites" && "is-on")} onClick={() => favCount && setSc("favourites")} style={favCount ? null : { opacity: .45, pointerEvents: "none" }}><div className="t">Favourites only</div><div className="d">{favCount} selected</div></div>
              </div>
            </div>
          </>
        ) : (
          <div style={{ padding: "8px 0 4px" }}>
            <div className="ey" style={{ marginBottom: 12 }}>Preparing {n} frames…</div>
            <QP.PrepBar pct={pct} />
            <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>{pct < 100 ? "Zipping originals…" : "Done — starting download."}</div>
          </div>
        )}
      </QP.Modal>
    );
  }

  /* ---- order print modal --------------------------------------------- */
  function OrderModal({ project, photo, onClose }) {
    const { Button } = DS();
    const [pick, setPick] = useState("a3");
    const prod = QP.PRINTS.find((p) => p.id === pick);
    return (
      <QP.Modal eyebrow="Order a print" title={photo.cap} onClose={onClose} wide
        footer={<>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" iconLeft={<Icon name="bag" size={15} />} onClick={() => { onClose(); QP.toast("Added to cart", { sub: `${prod.name} · ${prod.size} · ${QP.fmtAUD(prod.price)}`, icon: "bag" }); }}>Add — {QP.fmtAUD(prod.price)}</Button>
        </>}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 18 }}>
          <div className="tile" style={{ aspectRatio: "3/4", cursor: "default" }}>
            <div className="tile__ph"><img src={QP.res("qpWhite", "assets/logos/quincy-qp-white.png")} alt="" /></div>
            <img src={photo.src} alt="" style={{ objectPosition: photo.pos }} />
          </div>
          <div className="optrow">
            <div className="ey">Format</div>
            {QP.PRINTS.map((p) => (
              <div key={p.id} className={cx("optcard", pick === p.id && "is-on")} onClick={() => setPick(p.id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div><div className="t">{p.name}</div><div className="d">{p.size}</div></div>
                <div className="serif" style={{ fontSize: 18 }}>{QP.fmtAUD(p.price)}</div>
              </div>
            ))}
          </div>
        </div>
      </QP.Modal>
    );
  }

  /* ---- share modal --------------------------------------------------- */
  function ShareModal({ project, onClose }) {
    const { Button } = DS();
    const link = `quincyportal.com.au/g/${project.slug}`;
    return (
      <QP.Modal eyebrow="Share gallery" title="Send this gallery" onClose={onClose}
        footer={<Button variant="primary" size="md" iconLeft={<Icon name="copy" size={15} />} onClick={() => { onClose(); QP.toast("Gallery link copied", { sub: link, icon: "link" }); }}>Copy link</Button>}>
        <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>Anyone with the link can view and download <strong style={{ color: "var(--text-primary)" }}>{project.street}</strong>. No sign-in required.</p>
        <div className="row gap3" style={{ border: "1px solid var(--border-hairline)", padding: "12px 14px", background: "var(--paper-000)", borderRadius: "var(--radius-sm)" }}>
          <Icon name="link" size={16} style={{ color: "var(--text-muted)" }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5 }}>{link}</span>
        </div>
        <div className="row gap3" style={{ marginTop: 4 }}>
          <QP.Stars value={0} /><span className="ey muted">Link active · expires in 90 days</span>
        </div>
      </QP.Modal>
    );
  }
})();
