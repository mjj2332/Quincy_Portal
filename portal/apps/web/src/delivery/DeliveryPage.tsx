import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RENDITION_SPECS, DELIVERY_RENDITION_SPECS, type DeliveryItemDto, type DeliveryPageDto } from "@quincy/shared";
import { LockIcon, PlayIcon } from "lucide-react";
import { EmptyState } from "../components/quincy/EmptyState";
import { Eyebrow } from "../components/quincy/Eyebrow";
import { Button } from "../components/reui/button";
import { Frame, FramePanel } from "../components/reui/frame";
import { Separator } from "../components/reui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/reui/tabs";
import { heroMetaOf, heroOf, slideshowPhotosOf, tabsOf, type DeliveryHrefs, type DeliveryTab, type DeliveryTabId, type UnlockStates } from "./delivery-model";
import { DeliveryShareButton } from "./DeliveryShareButton";
import { DocRows } from "./DocRows";
import { FilmList } from "./FilmList";
import { returnTargetOf } from "./film-return";
import { PhotoGrid, ProcessingTile, type OpenViewer } from "./PhotoGrid";
import { STUDIO_EMAIL, STUDIO_NAME, STUDIO_WEBSITE, studioEmailHref } from "./studio";
import { TOUCH } from "./UnlockControl";

// Loaded on first open: embla ships with the viewer and nothing else (`build/vendor-chunk-guard.ts`).
const DeliveryLightbox = lazy(() => import("./DeliveryLightbox").then((module) => ({ default: module.DeliveryLightbox })));

/** A viewer chunk that cannot load (a deploy replaced it) must not blank the page: say so inline, and a reload is the person's to press. */
class ViewerBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div role="alert" data-testid="delivery-viewer-failed" className="mt-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-3)] [font:var(--type-body)]">
      The photo viewer couldn't load. The page may have been updated.
      <Button type="button" variant="outline" className={TOUCH} onClick={() => { window.location.reload(); }}>Reload</Button>
      <Button type="button" variant="ghost" className={TOUCH} onClick={this.props.onClose}>Dismiss</Button>
    </div>;
  }
}

export type DeliveryPageProps = {
  dto: DeliveryPageDto;
  /** The page's own address segment (#882): a film tile's review link carries it so the review's Back returns here. Absent in Preview. */
  pageSlug?: string | null;
  /** Item links. `null` (Preview) offers no download of any kind. */
  hrefs: DeliveryHrefs | null;
  onRequestUnlock: (handle: string) => void;
  unlockState: UnlockStates;
  /** The hero's action (Download all). Nothing is rendered or requested without it. */
  downloadAllSlot?: ReactNode;
  /** The page's own public address, for the hero's Share (#837). Absent in Preview, which is not published and has nothing to share. */
  shareUrl?: string;
  /** The film the viewer is coming back from (#882, `film-return.ts`): its tab opens and its tile is brought into view and focused, once, on the first render. */
  returnToVideo?: string | null;
};

type Viewer = { items: DeliveryItemDto[]; index: number; opener: HTMLElement; mode: "photo" | "slideshow" };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The hero's photo scrim sits under the text (no Q watermark: removed at the owner's request); `data-surface="inverse"` gives the ink ground, the paper text and the paper focus ring (`styles/tokens/inverse.css`). */
function Hero({ dto, hero, action }: { dto: DeliveryPageDto; hero: DeliveryItemDto | null; action: ReactNode }) {
  const { street } = dto.property;
  const { eyebrow, agency, frames, films } = heroMetaOf(dto);
  const counts = [frames > 0 ? count(frames, "frame", "frames") : null, films > 0 ? count(films, "film", "films") : null].filter((part) => part !== null).join(" · ");
  const [failed, setFailed] = useState(false);
  return <header data-testid="delivery-hero" data-surface="inverse" className="relative flex min-h-[min(78svh,880px)] items-end overflow-clip bg-background text-foreground @max-[721px]:min-h-[min(78svh,560px)]">
    {hero && hero.url !== null && !failed && <img
      data-testid="delivery-hero-photo" src={hero.url} alt={hero.label} fetchPriority="high" onError={() => { setFailed(true); }}
      srcSet={hero.thumbUrl ? `${hero.thumbUrl} ${RENDITION_SPECS.thumb.maxEdge}w, ${hero.url} ${DELIVERY_RENDITION_SPECS.delivery_web.maxEdge}w` : undefined}
      sizes="100vw" className="absolute inset-0 size-full object-cover" />}
    <div aria-hidden className="pointer-events-none absolute inset-0 bg-[image:var(--scrim-hero)]" />
    <div data-testid="delivery-hero-credit" aria-hidden className="pointer-events-none absolute top-[var(--space-7)] right-[var(--space-7)] z-10 @max-[721px]:hidden">
      <img src="/brand/quincy-wordmark-white.png" alt="" className="h-[var(--space-5)] w-auto select-none" />
    </div>
    <div className="relative z-10 mx-auto w-full max-w-[var(--container-page)] px-[var(--space-7)] pt-[var(--space-9)] pb-[var(--space-8)] @max-[721px]:px-[var(--space-4)] @max-[721px]:pt-[var(--space-7)] @max-[721px]:pb-[var(--space-6)]">
      {eyebrow.length > 0 && <p data-testid="delivery-hero-eyebrow" className="m-0 mb-[var(--space-4)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-on-inverse-muted">{eyebrow.join(" · ")}</p>}
      <h1 className="m-0 max-w-[14ch] [font:400_clamp(var(--text-3xl),6cqw,var(--text-5xl))/0.98_var(--font-display)] tracking-[var(--tracking-tightest)] text-balance">{street}</h1>
      {(agency !== null || counts !== "") && <p data-testid="delivery-hero-meta" className="m-0 mt-[var(--space-5)] flex flex-wrap items-center gap-[var(--space-4)] [font:var(--type-body-lg)]">
        {agency !== null && <span>{agency}</span>}
        {agency !== null && counts !== "" && <span aria-hidden className="opacity-40">—</span>}
        {counts !== "" && <span className="text-on-inverse-muted">{counts}</span>}
      </p>}
      {action !== undefined && action !== null && <div className="mt-[var(--space-7)] flex flex-wrap gap-[var(--space-3)]">{action}</div>}
    </div>
  </header>;
}

/** The pieces of one kind, in published order. The Premium tab uses the same pieces, grouped by kind. */
function Groups({ items, props, onOpen, headings }: { items: DeliveryItemDto[]; props: DeliveryPageProps; onOpen: OpenViewer; headings: boolean }) {
  const { hrefs, onRequestUnlock, unlockState } = props;
  const of = (kind: DeliveryItemDto["kind"]) => items.filter((item) => item.kind === kind);
  const photos = of("photo"); const films = of("video"); const plans = of("floorplan"); const copy = of("copy");
  const heading = (text: string, n: number) => headings ? <h3 className="m-0 mb-[var(--space-3)] flex items-baseline gap-[var(--space-2)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">{text}<span className="tabular-nums">{n}</span></h3> : null;
  return <div className="grid gap-[var(--space-6)]">
    {photos.length > 0 && <section aria-label="Photos">{heading("Photos", photos.length)}<PhotoGrid items={photos} hrefs={hrefs} unlock={unlockState} onRequestUnlock={onRequestUnlock} onOpen={onOpen} /></section>}
    {films.length > 0 && <section aria-label="Film">{heading("Film", films.length)}<FilmList items={films} hrefs={hrefs} unlock={unlockState} onRequestUnlock={onRequestUnlock} pageSlug={props.pageSlug ?? null} /></section>}
    {plans.length > 0 && <section aria-label="Floorplan">{heading("Floorplan", plans.length)}<DocRows items={plans} hrefs={hrefs} unlock={unlockState} onRequestUnlock={onRequestUnlock} label="Floorplan" /></section>}
    {copy.length > 0 && <section aria-label="Copywriting">{heading("Copywriting", copy.length)}<DocRows items={copy} hrefs={hrefs} unlock={unlockState} onRequestUnlock={onRequestUnlock} label="Copywriting" /></section>}
  </div>;
}

/** The Premium tab's lead-in (the prototype's `.premium-intro`): what Premium is, and how many extras are still locked. One Frame (ADR 0014). */
function PremiumIntro({ items }: { items: DeliveryItemDto[] }) {
  const lockedCount = items.filter((item) => item.locked).length;
  return <Frame className="mb-[var(--space-6)]"><FramePanel className="flex flex-wrap items-end justify-between gap-[var(--space-6)]">
    <div className="grid gap-[var(--space-2)]">
      <Eyebrow>Premium</Eyebrow>
      <h2 className="m-0 [font:var(--type-h1)] tracking-[var(--tracking-tight)] text-pretty">Paid extras</h2>
      <p className="m-0 max-w-[60ch] [font:var(--type-body)] text-foreground-secondary">Extras from the studio. A locked extra shows a preview; ask the studio to unlock it.</p>
    </div>
    <div className="text-right @max-[721px]:text-left">
      <p className="m-0 [font:var(--type-h1)] tabular-nums">{lockedCount}</p>
      <p className="m-0 [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">{lockedCount === 1 ? "item to unlock" : "items to unlock"}</p>
    </div>
  </FramePanel></Frame>;
}

function Panel({ tab, props, onOpen }: { tab: DeliveryTab; props: DeliveryPageProps; onOpen: OpenViewer }) {
  return <TabsContent value={tab.id} data-testid={`delivery-panel-${tab.id}`}>
    {tab.id === "premium" && <PremiumIntro items={tab.items} />}
    <Groups items={tab.items} props={props} onOpen={onOpen} headings={tab.id === "premium"} />
  </TabsContent>;
}

/** The inverse band at the foot: the studio's wordmark and name, its email (a mailto carrying the street) and website, and the copyright line. */
function Footer({ street }: { street: string }) {
  const link = "text-on-inverse-muted no-underline hover:text-on-inverse";
  return <footer data-testid="delivery-footer" data-surface="inverse" className="mt-[var(--space-9)] bg-background text-foreground">
    <div className="mx-auto grid w-full max-w-[var(--container-page)] gap-[var(--space-6)] px-[var(--space-7)] pt-[var(--space-8)] pb-[var(--space-6)] @max-[721px]:px-[var(--space-4)]">
      <div className="flex flex-wrap items-end justify-between gap-[var(--space-6)]">
        <div><img src="/brand/quincy-wordmark-white.png" alt="" aria-hidden className="h-[22px] w-auto" /><span className="sr-only">{STUDIO_NAME}</span></div>
        <div className="grid gap-[var(--space-2)] [font:var(--type-body-sm)] sm:text-right">
          <a href={studioEmailHref(street)} className={link}>{STUDIO_EMAIL}</a>
          <a href={STUDIO_WEBSITE} target="_blank" rel="noopener noreferrer" className={link}>{STUDIO_WEBSITE.replace("https://", "")}</a>
        </div>
      </div>
      <Separator />
      <Eyebrow className="text-on-inverse-muted">{`© ${STUDIO_NAME} ${new Date().getFullYear()}`}</Eyebrow>
    </div>
  </footer>;
}

/**
 * The Client Delivery page (#787 slice 9, PRD 6.7; redesigned in #836 to the prototype's Client view), as pure presentation: a full-bleed hero, an underlined tab bar, the panels, the lightbox and the footer. It owns only what a viewer does to it
 * (which tab, which photo is open); the data, the links and the unlock requests come in as props, so the same component is the public page (`DeliveryApp`) and slice 10's staff Preview. It is sized by CONTAINER queries (`@container`),
 * not the window, so it holds its layout at 720 px in a dialog. Tabs: Gallery, Film, Floorplan, Copywriting, and Premium when anything is a paid extra; empty ones are left out. State is in memory only.
 */
export function DeliveryPage(props: DeliveryPageProps) {
  const { dto } = props;
  const tabs = useMemo(() => tabsOf(dto), [dto]);
  const hero = useMemo(() => heroOf(dto), [dto]);
  // Read once: a later refetch (an unlock) must not pull the viewer back to the tile.
  const [returning] = useState(() => returnTargetOf(tabs, props.returnToVideo ?? null));
  const [chosen, setChosen] = useState<DeliveryTabId | null>(returning?.tab ?? null);
  const page = useRef<HTMLElement | null>(null);
  // Back from a review lands on the tile it opened: a jump, not an animated scroll (the page sets no smooth scroll-behavior, so there is no motion for reduced motion to stop), the TILE centred (not its title link, which sits at the tile's foot) so the sticky tab bar never covers its poster, then focus on its open link without a second
  // scroll (the browser's own `:focus-visible` draws the ring).
  useEffect(() => {
    if (returning === null) return;
    const item = [...(page.current?.querySelectorAll<HTMLElement>('[data-testid="delivery-film-item"]') ?? [])].find((element) => element.dataset.handle === returning.handle);
    const open = item?.querySelector<HTMLElement>('[data-testid="delivery-film-open"]');
    if (!item || !open) return;
    item.scrollIntoView({ block: "center" });
    open.focus({ preventScroll: true });
  }, [returning]);
  const active = tabs.some((tab) => tab.id === chosen) ? chosen : (tabs[0]?.id ?? null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback<OpenViewer>((items, index, element) => { opener.current = element; setViewer({ items, index, opener: element, mode: "photo" }); }, []);
  /** The slideshow runs over the active tab's unlocked photos (never a locked one, though an unlocked Premium photo belongs). */
  const activeItems = useMemo(() => tabs.find((entry) => entry.id === active)?.items ?? [], [tabs, active]);
  const slideshowItems = useMemo(() => slideshowPhotosOf(activeItems), [activeItems]);
  const startSlideshow = useCallback((items: DeliveryItemDto[], index: number, element: HTMLElement) => {
    const photos = slideshowPhotosOf(items);
    if (photos.length === 0) return;
    opener.current = element;
    setViewer({ items: photos, index, opener: element, mode: "slideshow" });
  }, []);
  // The open viewer shows the CURRENT items for its handles, so a refetch (an unlock) updates it in place.
  const viewerItems = useMemo(() => {
    if (!viewer) return null;
    const current = new Map(dto.items.map((item) => [item.handle, item]));
    const now = viewer.items.flatMap((item) => current.get(item.handle) ?? []);
    return viewer.mode === "slideshow" ? slideshowPhotosOf(now) : now;
  }, [viewer, dto]);
  // A refetch that leaves nothing to show closes the viewer through the normal path, so focus returns to where it opened.
  const emptied = viewer !== null && viewerItems !== null && viewerItems.length === 0;
  useEffect(() => { if (emptied) setViewer(null); }, [emptied]);
  const { street } = dto.property;
  const heroHasAction = slideshowItems.length > 0 || (props.downloadAllSlot !== undefined && props.downloadAllSlot !== null) || props.shareUrl !== undefined;
  return <article ref={page} aria-label={`Delivery: ${street}`} data-testid="delivery-page" className="@container w-full bg-background text-foreground">
    <Hero key={hero?.url ?? ""} dto={dto} hero={hero} action={heroHasAction ? <>
      {props.downloadAllSlot}
      {slideshowItems.length > 0 && <Button type="button" variant="outline" size="lg" data-testid="delivery-slideshow" className={TOUCH} onClick={(event) => { startSlideshow(slideshowItems, 0, event.currentTarget); }}><PlayIcon aria-hidden />Slideshow</Button>}
      {props.shareUrl !== undefined && <DeliveryShareButton url={props.shareUrl} title={street} />}
    </> : undefined} />
    {active === null
      ? <div className="mx-auto w-full max-w-[var(--container-page)] px-[var(--space-7)] py-[var(--space-7)] @max-[721px]:px-[var(--space-4)]"><EmptyState data-testid="delivery-empty" title="Nothing here yet.">The studio hasn't added anything to this page.</EmptyState></div>
      : <Tabs value={active} onValueChange={(value) => { setChosen(value as DeliveryTabId); }}>
        <div data-testid="delivery-tabs-bar" className="sticky top-0 z-20 border-0 border-b border-solid border-[var(--border-hairline)] bg-[color-mix(in_srgb,var(--paper-050)_90%,transparent)] backdrop-blur-[8px]">
          <div className="mx-auto w-full max-w-[var(--container-page)] px-[var(--space-7)] pt-[var(--space-4)] pb-[var(--space-2)] @max-[721px]:px-[var(--space-4)] @max-[721px]:pt-[var(--space-2)]">
            <TabsList variant="line" data-testid="delivery-tabs-list" aria-label="Delivery sections" className="h-auto max-w-full group-data-[orientation=horizontal]/tabs:h-auto flex-nowrap justify-start gap-[var(--space-3)] overflow-x-auto pb-[var(--space-2)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden @max-[721px]:[mask-image:linear-gradient(to_right,black_calc(100%-var(--space-6)),transparent)]">
              {tabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id} className={`h-auto shrink-0 flex-none gap-[var(--space-2)] px-[var(--space-2)] [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary data-active:text-foreground ${TOUCH}`}>
                {tab.id === "premium" && <LockIcon aria-hidden className="size-3.5" />}
                <span data-testid="delivery-tab-label">{tab.label}</span>
                <span data-testid="delivery-tab-count" className="tabular-nums text-muted-foreground">{tab.items.length}</span>
              </TabsTrigger>)}
            </TabsList>
          </div>
        </div>
        <div className="mx-auto w-full max-w-[var(--container-page)] p-[var(--space-7)] @max-[721px]:p-[var(--space-4)]">
          {tabs.map((tab) => <Panel key={tab.id} tab={tab} props={props} onOpen={open} />)}
        </div>
      </Tabs>}
    <Footer street={street} />
    {viewer && viewerItems && viewerItems.length > 0 && <ViewerBoundary onClose={() => { setViewer(null); }}>
      <Suspense fallback={null}>
        <DeliveryLightbox
          key={viewer.mode} mode={viewer.mode} title={street} items={viewerItems} startIndex={viewer.index}
          onStartSlideshow={(handle) => { const at = slideshowPhotosOf(viewerItems).findIndex((item) => item.handle === handle); startSlideshow(viewerItems, Math.max(at, 0), opener.current ?? viewer.opener); }} hrefs={props.hrefs} unlock={props.unlockState} onRequestUnlock={props.onRequestUnlock}
          returnFocus={() => opener.current} onClose={() => { setViewer(null); }} />
      </Suspense>
    </ViewerBoundary>}
  </article>;
}
