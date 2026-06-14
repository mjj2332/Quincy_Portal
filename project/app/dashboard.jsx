/* =====================================================================
   Quincy Portal — Team dashboard  →  window.QP.Dashboard
   ===================================================================== */
(function () {
  const QP = (window.QP = window.QP || {});
  const { useState } = React;
  const Icon = QP.Icon, cx = QP.cx;
  const DS = () => window.QuincyProductionsDesignSystem_b05a1c || {};

  const STATUS_ORDER = ["all", "editing", "in_review", "client_review", "delivered"];

  QP.Dashboard = function Dashboard({ projects, states, onOpen, query }) {
    const { Button } = DS();
    const [filter, setFilter] = useStoredView("dash:filter", "all");
    const [agency, setAgency] = useState("all");
    const [view, setView] = useStoredView("dash:view", "grid");
    const [sort, setSort] = useState("recent");

    const agencies = ["all", ...Array.from(new Set(projects.map((p) => p.agency)))];

    let list = projects.filter((p) => {
      if (filter !== "all" && p.status !== filter) return false;
      if (agency !== "all" && p.agency !== agency) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!(`${p.street} ${p.suburb} ${p.agency} ${p.agent}`.toLowerCase().includes(q))) return false;
      }
      return true;
    });
    list = list.slice().sort((a, b) => sort === "recent" ? b.shoot.localeCompare(a.shoot) : a.suburb.localeCompare(b.suburb));

    const count = (s) => projects.filter((p) => p.status === s).length;
    const photosThisWeek = projects.filter((p) => p.shoot >= "2026-02-09").reduce((n, p) => n + p.collections[0].photos.length, 0);

    const stats = [
      { v: projects.filter((p) => p.status !== "delivered").length, l: "Active shoots" },
      { v: count("in_review"), l: "In studio review", accent: "var(--signal-caution)" },
      { v: count("client_review"), l: "Awaiting client", accent: "var(--signal-info)" },
      { v: count("delivered"), l: "Delivered", accent: "var(--signal-positive)" },
    ];

    return (
      <div className="page">
        <div className="pagehead">
          <div>
            <div className="ey" style={{ marginBottom: 14 }}>Quincy Portal · Studio</div>
            <h1 className="serif">Projects</h1>
          </div>
          <div className="toolbar">
            <Button variant="secondary" size="sm" iconLeft={<Icon name="calendar" size={15} />}>Schedule</Button>
            <Button variant="primary" size="sm" iconLeft={<Icon name="plus" size={15} />}>New shoot</Button>
          </div>
        </div>

        {/* stat strip */}
        <div className="stats">
          {stats.map((s) => (
            <div className="stat" key={s.l}>
              <div className="v">{s.accent && <span className="sdot" style={{ background: s.accent, marginRight: 2 }} />}{s.v}</div>
              <div className="l">{s.l}</div>
            </div>
          ))}
        </div>

        {/* filter bar */}
        <div className="spread" style={{ marginBottom: 20, gap: 16, flexWrap: "wrap" }}>
          <div className="toolbar">
            {STATUS_ORDER.map((s) => (
              <button key={s} className={cx("chip", filter === s && "is-active")} onClick={() => setFilter(s)}>
                {s === "all" ? "All" : QP.STATUS[s].label}
                <span className="cnt">{s === "all" ? projects.length : count(s)}</span>
              </button>
            ))}
          </div>
          <div className="toolbar">
            <div className="segment">
              <button className={sort === "recent" ? "is-active" : ""} onClick={() => setSort("recent")}>Recent</button>
              <button className={sort === "suburb" ? "is-active" : ""} onClick={() => setSort("suburb")}>Suburb</button>
            </div>
            <div className="segment">
              <button className={view === "grid" ? "is-active" : ""} onClick={() => setView("grid")} title="Grid"><Icon name="grid" size={14} /></button>
              <button className={view === "list" ? "is-active" : ""} onClick={() => setView("list")} title="List"><Icon name="list" size={14} /></button>
            </div>
          </div>
        </div>

        {list.length === 0 && (
          <div className="empty"><span className="serif">Nothing here yet.</span>No shoots match this filter.</div>
        )}

        {view === "grid" && list.length > 0 && (
          <div className="projects">
            {list.map((p) => <ProjectCard key={p.id} project={p} states={states} onOpen={onOpen} />)}
          </div>
        )}

        {view === "list" && list.length > 0 && (
          <div className="plist">
            <div className="prow head">
              <div></div><div>Address</div><div className="prow__c-agency">Client</div>
              <div className="prow__c-date">Shoot date</div><div className="prow__c-status">Status</div><div style={{ textAlign: "right" }}>Review</div>
            </div>
            {list.map((p) => {
              const rs = QP.reviewStats(p, states);
              return (
                <div className="prow" key={p.id} onClick={() => onOpen(p.id)}>
                  <img className="prow__thumb" src={p.cover} alt="" loading="lazy" />
                  <div>
                    <div className="serif" style={{ fontSize: 18, letterSpacing: "-0.01em" }}>{p.street}</div>
                    <div className="ey" style={{ marginTop: 4 }}>{p.suburb} · {p.postcode}</div>
                  </div>
                  <div className="prow__c-agency" style={{ fontSize: 14 }}>{p.agency}<div className="muted" style={{ fontSize: 12.5 }}>{p.agent}</div></div>
                  <div className="prow__c-date" style={{ fontSize: 14 }}>{QP.fmtShort(p.shoot)}</div>
                  <div className="prow__c-status"><QP.StatusBadge status={p.status} /></div>
                  <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 14 }}>
                    {p.status === "editing" ? <span className="muted">—</span> : `${rs.approved}/${rs.total}`}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  /* ---- project card -------------------------------------------------- */
  function ProjectCard({ project, states, onOpen }) {
    const p = project;
    const rs = QP.reviewStats(p, states);
    const photoCount = p.collections.reduce((n, c) => n + c.photos.length, 0);
    return (
      <div className="proj" onClick={() => onOpen(p.id)}>
        <div className="proj__media">
          <img src={p.cover} alt={p.street} loading="lazy" />
          <div className="proj__badges">
            <QP.StatusBadge status={p.status} style={{ background: "rgba(20,20,21,.42)", backdropFilter: "blur(6px)", padding: "5px 8px", borderRadius: 2 }} />
            <span className="cbubble"><Icon name="image" size={12} />{photoCount}</span>
          </div>
        </div>
        <div className="proj__body">
          <div className="proj__addr serif">{p.street}</div>
          <div className="proj__meta">
            <div className="ey">{p.suburb} · {p.postcode} NSW</div>
            <div style={{ fontSize: 13.5, color: "var(--text-secondary)", marginTop: 2 }}>{p.agency} · {p.agent}</div>
          </div>
          <div className="proj__foot">
            {p.status === "editing" ? (
              <span className="ey" style={{ color: "var(--text-muted)" }}>Editing in progress</span>
            ) : (
              <>
                <div className="meter" title={`${rs.approved} approved`}><i style={{ width: rs.pct + "%" }} /></div>
                <span className="ey nowrap" style={{ marginLeft: 12, color: "var(--text-secondary)" }}>{rs.approved}/{rs.total} {p.status === "delivered" ? "delivered" : "approved"}</span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // local persisted view helper (reuses QP.useStored but as a hook wrapper)
  function useStoredView(key, init) { return QP.useStored(key, init); }
})();
