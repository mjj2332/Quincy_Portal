/* =====================================================================
   Quincy Portal — Client delivery page  →  window.QP.Client
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState, useEffect } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  QP.Client = function Client({ project, favs, toggleFav, density, theme = "paper", captions = true, purchases = {}, onPurchase }) {
    const { Button } = DS();

    // build the delivered tab set from published collections
    const ed = QP.collOf(project, "edited");
    const vid = QP.collOf(project, "video");
    const fl = QP.collOf(project, "floorplan");
    const isLocked = (p) => p && p.premium && !purchases[p.id];

    // premium content lives in its own section, separate from the main gallery
    const galleryPhotos = ed ? ed.photos.filter((p) => !p.premium) : [];
    const premiumPhotos = ed ? ed.photos.filter((p) => p.premium) : [];
    const premiumVideos = vid ? vid.items.filter((v) => v.premium) : [];
    const hasPremium = premiumPhotos.length + premiumVideos.length > 0;
    const lockedRemaining = premiumPhotos.filter((p) => isLocked(p)).length + premiumVideos.filter((v) => !purchases[v.id]).length;

    const tabs = [];
    if (ed) tabs.push({ id: "images", name: "Gallery", kind: "photo", count: galleryPhotos.length });
    if (vid) tabs.push({ id: "video", name: "Film", kind: "video", coll: { items: vid.items.filter((v) => !v.premium) } });
    if (fl) tabs.push({ id: "floorplan", name: "Floorplan", kind: "plan", coll: fl });
    if (hasPremium) tabs.push({ id: "premium", name: "Premium", kind: "premium", count: premiumPhotos.length + premiumVideos.length });
    if (project.copy.status === "published") tabs.push({ id: "copy", name: "Copywriting", kind: "copy" });

    const [tab, setTab] = useState(tabs[0]?.id || "images");
    const [favOnly, setFavOnly] = useState(false);
    const [viewer, setViewer] = useState(null);   // { list, index } | null
    const [slideshow, setSlideshow] = useState(false);
    const [dl, setDl] = useState(null);
    const [unlock, setUnlock] = useState(null);
    const [video, setVideo] = useState(null);
    const [share, setShare] = useState(false);

    const active = tabs.find((t) => t.id === tab) || tabs[0];
    let photos = galleryPhotos;
    if (favOnly) photos = photos.filter((p) => favs[p.id]);
    const favCount = galleryPhotos.filter((p) => favs[p.id]).length;

    const openViewer = (list, i) => { setViewer({ list, index: i }); setSlideshow(false); };
    const quickDownload = (p) => { if (isLocked(p)) return setUnlock({ item: p, kind: "photo" }); QP.toast("Frame downloading", { sub: `${p.cap} · full-resolution`, icon: "download" }); };

    return (
      <div className={cx("client", theme === "ink" && "client--ink")} style={{ paddingBottom: 0 }}>
        {/* hero */}
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
              <span style={{ color: "var(--text-on-inverse-muted)" }}>{galleryPhotos.length} frames{vid ? ` · ${vid.items.length} films` : ""} · by {project.photographer}</span>
            </div>
            <div className="chero__actions">
              <Button variant="inverse" size="lg" iconLeft={<Icon name="download" size={16} />} onClick={() => setDl({ scope: "all" })}>Download all</Button>
              {ed && <Button variant="ghost" size="lg" style={{ color: "var(--paper-050)", borderColor: "rgba(246,244,239,.4)" }} iconLeft={<Icon name="play" size={15} />} onClick={() => { setViewer({ list: galleryPhotos, index: 0 }); setSlideshow(true); }}>Slideshow</Button>}
              <button className="icbtn icbtn--lg icbtn--ondark" title="Share" onClick={() => setShare(true)}><Icon name="share" size={17} /></button>
            </div>
          </div>
        </header>

        {/* sticky bar */}
        <div className="cbar">
          <div className="ctabs">
            {tabs.map((t) => (
              <div key={t.id} className={cx("ctab", tab === t.id && "is-active", t.id === "premium" && "ctab--premium")} onClick={() => { setTab(t.id); setFavOnly(false); }}>
                {t.id === "premium" && <Icon name="lock" size={13} />}
                {t.name} {t.kind !== "copy" && <span className="cnt">{t.count != null ? t.count : (t.coll.photos ? t.coll.photos.length : t.coll.items.length)}</span>}
              </div>
            ))}
          </div>
          <div className="toolbar">
            {tab === "images" && <button className={cx("chip", favOnly && "is-active")} onClick={() => setFavOnly((f) => !f)} disabled={favCount === 0 && !favOnly}>
              <Icon name="heart" size={13} fill={favOnly ? "currentColor" : "none"} /> Favourites <span className="cnt">{favCount}</span>
            </button>}
            <button className="icbtn" title="Download" onClick={() => setDl({ scope: favOnly ? "favourites" : "all" })}><Icon name="download" size={16} /></button>
            <button className="icbtn" title="Share" onClick={() => setShare(true)}><Icon name="share" size={16} /></button>
          </div>
        </div>

        {/* body */}
        <div className="cgallery">
          {active && active.kind === "photo" && (
            photos.length === 0
              ? <div className="empty"><span className="serif">No favourites yet.</span>Tap the heart on a frame to start a selection.</div>
              : <div className="grid" style={{ "--cols": density === "comfortable" ? 3 : density === "dense" ? 5 : 4, "--gap": "16px" }}>
                  {photos.map((p) => (
                    <QP.PhotoTile key={p.id} photo={p} mode="client" showCaption={captions} locked={false}
                      fav={!!favs[p.id]} onFav={() => toggleFav(p.id)} onQuickDownload={() => quickDownload(p)}
                      onOpen={() => openViewer(galleryPhotos, galleryPhotos.indexOf(p))} />
                  ))}
                </div>
          )}

          {active && active.kind === "premium" && (
            <div className="premium-wrap">
              <div className="premium-intro">
                <div>
                  <div className="ey" style={{ marginBottom: 10 }}><Icon name="lock" size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />Premium content</div>
                  <h2 className="serif premium-intro__h">Extra frames &amp; films, available to purchase</h2>
                  <p className="premium-intro__p">Preview every premium asset watermarked. Unlock any one individually to remove the watermark and download the full-resolution original.</p>
                </div>
                <div className="premium-intro__stat">
                  <div className="v serif">{lockedRemaining}</div>
                  <div className="ey">{lockedRemaining === 1 ? "item to unlock" : "items to unlock"}</div>
                </div>
              </div>

              {premiumPhotos.length > 0 && <>
                <div className="ey premium-sec">Images <span className="cnt">{premiumPhotos.length}</span></div>
                <div className="grid" style={{ "--cols": density === "comfortable" ? 3 : density === "dense" ? 5 : 4, "--gap": "16px" }}>
                  {premiumPhotos.map((p) => (
                    <QP.PhotoTile key={p.id} photo={p} mode="client" showCaption={captions} locked={isLocked(p)}
                      fav={!!favs[p.id]} onFav={() => toggleFav(p.id)} onQuickDownload={() => quickDownload(p)}
                      onOpen={() => isLocked(p) ? setUnlock({ item: p, kind: "photo" }) : openViewer(premiumPhotos, premiumPhotos.indexOf(p))} />
                  ))}
                </div>
              </>}

              {premiumVideos.length > 0 && <>
                <div className="ey premium-sec">Films <span className="cnt">{premiumVideos.length}</span></div>
                <div className="grid" style={{ "--cols": 2, "--gap": "18px" }}>
                  {premiumVideos.map((v) => {
                    const locked = !purchases[v.id];
                    return (
                      <div key={v.id} className="vtile vtile--client" onClick={() => locked ? setUnlock({ item: v, kind: "video" }) : setVideo(v)}>
                        <div className="vtile__media">
                          <img src={v.poster} alt={v.title} loading="lazy" />
                          {locked && <div className="wmark" aria-hidden="true"><span>QUINCY · PREVIEW</span><span>QUINCY · PREVIEW</span><span>QUINCY · PREVIEW</span></div>}
                          <span className="vtile__play"><Icon name={locked ? "lock" : "play"} size={20} fill={locked ? "none" : "currentColor"} /></span>
                          <span className="vtile__dur">{v.dur}</span>
                          {locked && <span className="lockbadge"><Icon name="lock" size={12} /> {QP.fmtAUD(v.price)}</span>}
                        </div>
                        <div className="vtile__body">
                          <div style={{ fontSize: 16 }} className="serif">{v.title}</div>
                          <div className="ey muted">{locked ? "Premium add-on · unlock to view & download" : "Unlocked · 4K"}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>}
            </div>
          )}

          {active && active.kind === "video" && (
            active.coll.items.length === 0
              ? <div className="empty"><span className="serif">Films are in the Premium tab.</span>The included film set is empty for this gallery.</div>
              : <div className="grid" style={{ "--cols": 2, "--gap": "18px" }}>
              {active.coll.items.map((v) => {
                return (
                  <div key={v.id} className="vtile vtile--client" onClick={() => setVideo(v)}>
                    <div className="vtile__media">
                      <img src={v.poster} alt={v.title} loading="lazy" />
                      <span className="vtile__play"><Icon name="play" size={20} fill="currentColor" /></span>
                      <span className="vtile__dur">{v.dur}</span>
                      {v.vimeo && <span className="vtile__src">Vimeo</span>}
                    </div>
                    <div className="vtile__body">
                      <div style={{ fontSize: 16 }} className="serif">{v.title}</div>
                      <div className="ey muted">Included · 4K</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {active && active.kind === "plan" && (
            <div className="grid" style={{ "--cols": 2, "--gap": "16px" }}>
              {active.coll.photos.map((p) => (
                <div key={p.id} className="tile" style={{ aspectRatio: "3 / 2", cursor: "default" }}>
                  <QP.FloorplanArt /><span className="tile__cap" style={{ opacity: .9 }}>{p.cap}</span>
                </div>
              ))}
            </div>
          )}

          {active && active.kind === "copy" && (
            <article className="copyread copyread--client">
              {project.copy.file && (
                <div className="doccard" style={{ marginBottom: 32 }}>
                  <div className="doccard__icon"><Icon name="file" size={26} /></div>
                  <div className="doccard__b">
                    <div style={{ fontSize: 15.5 }}>{project.copy.file}</div>
                    <div className="ey muted">Copywriting · PDF · {project.copy.pages || 2} pages</div>
                  </div>
                  <button className="chip" onClick={() => QP.toast("Downloading PDF", { sub: project.copy.file, icon: "download" })}><Icon name="download" size={13} /> Download</button>
                </div>
              )}
              <h2 className="serif">{project.copy.headline}</h2>
              <p>{project.copy.body}</p>
              {project.copy.features.length > 0 && (
                <>
                  <div className="ey" style={{ marginTop: 28, marginBottom: 12 }}>Key features</div>
                  <ul>{project.copy.features.map((f, i) => <li key={i}>{f}</li>)}</ul>
                </>
              )}
            </article>
          )}
        </div>

        {/* footer */}
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

        {/* viewer / slideshow */}
        {viewer !== null && ed && (
          slideshow
            ? <Slideshow photos={viewer.list} index={viewer.index} setIndex={(n) => setViewer((v) => ({ ...v, index: typeof n === "function" ? n(v.index) : n }))} project={project} onClose={() => { setSlideshow(false); setViewer(null); }} />
            : <QP.ImageViewer mode="client" project={project} photos={viewer.list} index={viewer.index}
                onIndex={(n) => setViewer((v) => ({ ...v, index: typeof n === "function" ? n(v.index) : n }))} onClose={() => setViewer(null)} isLocked={isLocked}
                favs={favs} onFav={toggleFav} onDownload={quickDownload} onOrder={(p) => { setViewer(null); setUnlock({ item: p, kind: "photo" }); }} />
        )}

        {video && (
          <QP.Modal eyebrow={project.street} title={video.title} onClose={() => setVideo(null)} wide
            footer={<Button variant="primary" size="md" iconLeft={<Icon name="download" size={15} />} onClick={() => { setVideo(null); QP.toast("Film downloading", { sub: video.title, icon: "download" }); }}>Download film</Button>}>
            <div className="videoframe"><img src={video.poster} alt="" /><span className="vtile__play vtile__play--lg"><Icon name="play" size={28} fill="currentColor" /></span></div>
            <span className="ey muted">Duration {video.dur} · 4K · H.264</span>
          </QP.Modal>
        )}

        {dl && <DownloadModal project={project} photos={galleryPhotos} scope={dl.scope} favCount={favCount} onClose={() => setDl(null)} />}
        {unlock && <UnlockModal data={unlock} project={project} onClose={() => setUnlock(null)} onPurchase={onPurchase} />}
        {share && <ShareModal project={project} onClose={() => setShare(false)} />}
      </div>
    );
  };

  /* ---- slideshow ----------------------------------------------------- */
  function Slideshow({ photos, index, setIndex, project, onClose }) {
    const [playing, setPlaying] = useState(true);
    const photo = photos[index];
    useEffect(() => { if (!playing) return; const t = setTimeout(() => setIndex((index + 1) % photos.length), 3600); return () => clearTimeout(t); }, [index, playing]);
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

  /* ---- download modal (web / full-res · all / favourites) ------------ */
  function DownloadModal({ project, photos, scope, favCount, onClose }) {
    const { Button } = DS();
    const [size, setSize] = useState("full");
    const [sc, setSc] = useState(scope);
    const [pct, setPct] = useState(null);
    const n = sc === "favourites" ? favCount : photos.length;
    const start = () => {
      setPct(0); let p = 0;
      const t = setInterval(() => { p += Math.random() * 22 + 8; if (p >= 100) { p = 100; clearInterval(t); setTimeout(() => { onClose(); QP.toast("Download ready", { sub: `${n} frames · ${size === "full" ? "Full-resolution" : "Web-size"} · .zip`, icon: "download" }); }, 450); } setPct(Math.min(100, Math.round(p))); }, 240);
    };
    return (
      <QP.Modal eyebrow={`${project.street} · ${project.suburb}`} title="Download gallery" onClose={onClose}
        footer={pct === null ? <>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" iconLeft={<Icon name="download" size={15} />} onClick={start}>Prepare {n} frames</Button>
        </> : null}>
        {pct === null ? <>
          <div className="optrow"><div className="ey">Resolution</div>
            <div className="optcards">
              <div className={cx("optcard", size === "web" && "is-on")} onClick={() => setSize("web")}><div className="t">Web-size</div><div className="d">2048px · portals &amp; socials</div></div>
              <div className={cx("optcard", size === "full" && "is-on")} onClick={() => setSize("full")}><div className="t">Full-resolution</div><div className="d">Original · for print</div></div>
            </div>
          </div>
          <div className="optrow"><div className="ey">Scope</div>
            <div className="optcards">
              <div className={cx("optcard", sc === "all" && "is-on")} onClick={() => setSc("all")}><div className="t">Entire gallery</div><div className="d">{photos.length} frames</div></div>
              <div className={cx("optcard", sc === "favourites" && "is-on")} onClick={() => favCount && setSc("favourites")} style={favCount ? null : { opacity: .45, pointerEvents: "none" }}><div className="t">Favourites only</div><div className="d">{favCount} selected</div></div>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>Premium add-ons are not included unless unlocked.</div>
        </> : (
          <div style={{ padding: "8px 0 4px" }}>
            <div className="ey" style={{ marginBottom: 12 }}>Preparing {n} frames…</div>
            <QP.PrepBar pct={pct} />
            <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>{pct < 100 ? "Zipping originals…" : "Done — starting download."}</div>
          </div>
        )}
      </QP.Modal>
    );
  }

  /* ---- unlock (paywall) modal ---------------------------------------- */
  function UnlockModal({ data, project, onClose, onPurchase }) {
    const { Button } = DS();
    const { item, kind } = data;
    const price = item.price || 60;
    return (
      <QP.Modal eyebrow="Premium content" title={kind === "video" ? item.title : `Unlock “${item.cap}”`} onClose={onClose} wide
        footer={<>
          <Button variant="ghost" size="md" onClick={onClose}>Maybe later</Button>
          <Button variant="primary" size="md" iconLeft={<Icon name="unlock" size={15} />} onClick={() => { onPurchase(item.id); onClose(); QP.toast("Unlocked", { sub: `${kind === "video" ? item.title : item.cap} · watermark removed`, icon: "unlock" }); }}>Unlock — {QP.fmtAUD(price)}</Button>
        </>}>
        <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 18 }}>
          <div className="tile" style={{ aspectRatio: kind === "video" ? "16/10" : "3/4", cursor: "default" }}>
            <img src={kind === "video" ? item.poster : item.src} alt="" style={{ objectPosition: item.pos }} />
            <div className="wmark" aria-hidden="true"><span>QUINCY · PREVIEW</span><span>QUINCY · PREVIEW</span></div>
          </div>
          <div>
            <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>
              This {kind === "video" ? "film" : "frame"} is a paid add-on. Unlock to remove the watermark and download the full-resolution {kind === "video" ? "4K file" : "original"}.
            </p>
            <div className="kv"><span className="k">Format</span><span className="vv">{kind === "video" ? "4K · H.264" : "Full-resolution JPEG"}</span></div>
            <div className="kv"><span className="k">Licence</span><span className="vv">Marketing &amp; print</span></div>
            <div className="kv"><span className="k">Price</span><span className="vv serif" style={{ fontSize: 18 }}>{QP.fmtAUD(price)}</span></div>
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
        <p style={{ fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>Anyone with the link can view and download <strong style={{ color: "var(--text-primary)" }}>{project.street}</strong>. No sign-in required. Premium add-ons stay locked until purchased.</p>
        <div className="row gap3" style={{ border: "1px solid var(--border-hairline)", padding: "12px 14px", background: "var(--paper-000)", borderRadius: "var(--radius-sm)" }}>
          <Icon name="link" size={16} style={{ color: "var(--text-muted)" }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5 }}>{link}</span>
        </div>
        <span className="ey muted">Link active · expires in 90 days</span>
      </QP.Modal>
    );
  }
})();
