import { Component, lazy, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { RENDITION_SPECS, DELIVERY_RENDITION_SPECS, type DeliveryItemDto, type DeliveryPageDto } from "@quincy/shared";
import { EmptyState } from "../components/quincy/EmptyState";
import { SectionHead } from "../components/quincy/SectionHead";
import { buttonVariants, Button } from "../components/reui/button";
import { Frame, FramePanel } from "../components/reui/frame";
import { Separator } from "../components/reui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/reui/tabs";
import { formatDelivered, heroOf, tabsOf, type DeliveryHrefs, type DeliveryTab, type DeliveryTabId, type UnlockStates } from "./delivery-model";
import { DocRows } from "./DocRows";
import { FilmList } from "./FilmList";
import { PhotoGrid, ProcessingTile, type OpenViewer } from "./PhotoGrid";
import { askTheStudioHref } from "./studio";
import { StudioCredit } from "./StudioCredit";
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
  /** Item links. `null` (Preview) offers no download of any kind. */
  hrefs: DeliveryHrefs | null;
  onRequestUnlock: (handle: string) => void;
  unlockState: UnlockStates;
  /** Beside the Photos heading. Slice 7 fills it; until then nothing is rendered and nothing is requested. */
  downloadAllSlot?: ReactNode;
};

type Viewer = { items: DeliveryItemDto[]; index: number; opener: HTMLElement };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Hero({ dto, hero }: { dto: DeliveryPageDto; hero: DeliveryItemDto | null }) {
  const { street, suburb } = dto.property;
  const delivered = formatDelivered(dto.publishedAt);
  const [failed, setFailed] = useState(false);
  return <header data-testid="delivery-hero" className="grid gap-[var(--space-5)]">
    {hero && hero.url !== null && (failed
      ? <div className="aspect-[16/9] @max-[721px]:aspect-[4/3]"><ProcessingTile label={hero.label} /></div>
      : <div className="aspect-[16/9] overflow-hidden bg-surface-sunken @max-[721px]:aspect-[4/3]">
        <img
          src={hero.url} alt={hero.label} fetchPriority="high" onError={() => { setFailed(true); }}
          srcSet={hero.thumbUrl ? `${hero.thumbUrl} ${RENDITION_SPECS.thumb.maxEdge}w, ${hero.url} ${DELIVERY_RENDITION_SPECS.delivery_web.maxEdge}w` : undefined}
          sizes="(min-width: 1280px) 1280px, 100vw" className="size-full object-cover" />
      </div>)}
    <div className="grid gap-[var(--space-2)]">
      <h1 className="m-0 [font:var(--type-h1)] tracking-[var(--tracking-tight)] text-pretty">{suburb ? `${street}, ${suburb}` : street}</h1>
      {delivered !== null && <p className="m-0 [font:var(--type-body)] text-foreground-secondary">{`Delivered ${delivered}`}</p>}
      <div><a href={askTheStudioHref(street)} className={buttonVariants({ variant: "secondary", className: `w-fit ${TOUCH}` })}>Ask the studio</a></div>
    </div>
  </header>;
}

/** The pieces of one kind, in published order. The Premium tab uses the same pieces, grouped by kind. */
function Groups({ items, props, onOpen, headings }: { items: DeliveryItemDto[]; props: DeliveryPageProps; onOpen: OpenViewer; headings: boolean }) {
  const { hrefs, onRequestUnlock, unlockState } = props;
  const of = (kind: DeliveryItemDto["kind"]) => items.filter((item) => item.kind === kind);
  const photos = of("photo"); const films = of("video"); const plans = of("floorplan"); const copy = of("copy");
  const heading = (text: string) => headings ? <h3 className="m-0 mb-[var(--space-3)] [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">{text}</h3> : null;
  return <div className="grid gap-[var(--space-6)]">
    {photos.length > 0 && <section aria-label="Photos">{heading("Photos")}<PhotoGrid items={photos} hrefs={hrefs} unlock={unlockState} onRequestUnlock={onRequestUnlock} onOpen={onOpen} /></section>}
    {films.length > 0 && <section aria-label="Film">{heading("Film")}<FilmList items={films} hrefs={hrefs} unlock={unlockState} onRequestUnlock={onRequestUnlock} /></section>}
    {plans.length > 0 && <section aria-label="Floorplan">{heading("Floorplan")}<DocRows items={plans} hrefs={hrefs} unlock={unlockState} onRequestUnlock={onRequestUnlock} label="Floorplan" /></section>}
    {copy.length > 0 && <section aria-label="Description">{heading("Description")}<DocRows items={copy} hrefs={hrefs} unlock={unlockState} onRequestUnlock={onRequestUnlock} label="Description" /></section>}
  </div>;
}

function Panel({ tab, props, onOpen }: { tab: DeliveryTab; props: DeliveryPageProps; onOpen: OpenViewer }) {
  const noun: Record<DeliveryTabId, string> = { photos: count(tab.items.length, "photo", "photos"), film: count(tab.items.length, "film", "films"), floorplan: count(tab.items.length, "floorplan", "floorplans"), description: count(tab.items.length, "document", "documents"), premium: count(tab.items.length, "extra", "extras") };
  return <TabsContent value={tab.id} data-testid={`delivery-panel-${tab.id}`} className="pt-[var(--space-5)]">
    <Frame><FramePanel>
      <SectionHead eyebrow={noun[tab.id]} actions={tab.id === "photos" ? props.downloadAllSlot : undefined}>{tab.label}</SectionHead>
      {tab.id === "premium" && <p className="m-0 mb-[var(--space-5)] max-w-[60ch] [font:var(--type-body)] text-foreground-secondary">Extras from the studio. A locked extra shows a preview; ask the studio to unlock it.</p>}
      <Groups items={tab.items} props={props} onOpen={onOpen} headings={tab.id === "premium"} />
    </FramePanel></Frame>
  </TabsContent>;
}

/**
 * The Client Delivery page (#787 slice 9, PRD 6.7), as pure presentation: hero, tabs, lightbox, footer. It owns only what a viewer does to it (which tab, which photo is open); the data, the links and the unlock
 * requests come in as props, so the same component is the public page (`DeliveryApp`) and slice 10's staff Preview. It is sized by CONTAINER queries (`@container`), not the window, so it holds its layout at 720 px in a dialog.
 * Tabs: Photos, Film, Floorplan, Description, and Premium when anything is a paid extra; empty ones are left out. State is in memory only.
 */
export function DeliveryPage(props: DeliveryPageProps) {
  const { dto } = props;
  const tabs = useMemo(() => tabsOf(dto), [dto]);
  const hero = useMemo(() => heroOf(dto), [dto]);
  const [chosen, setChosen] = useState<DeliveryTabId | null>(null);
  const active = tabs.some((tab) => tab.id === chosen) ? chosen : (tabs[0]?.id ?? null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback<OpenViewer>((items, index, element) => { opener.current = element; setViewer({ items, index, opener: element }); }, []);
  // The open viewer shows the CURRENT items for its handles, so a refetch (an unlock) updates it in place.
  const viewerItems = useMemo(() => {
    if (!viewer) return null;
    const current = new Map(dto.items.map((item) => [item.handle, item]));
    return viewer.items.flatMap((item) => current.get(item.handle) ?? []);
  }, [viewer, dto]);
  const { street } = dto.property;
  return <article aria-label={`Delivery: ${street}`} data-testid="delivery-page" className="@container w-full bg-background text-foreground">
    <div className="mx-auto grid w-full max-w-[var(--container-page)] gap-[var(--space-6)] px-[var(--space-4)] py-[var(--space-5)]">
      <Hero key={hero?.url ?? ""} dto={dto} hero={hero} />
      {active === null
        ? <EmptyState data-testid="delivery-empty" title="Nothing here yet.">The studio hasn't added anything to this page.</EmptyState>
        : <Tabs value={active} onValueChange={(value) => { setChosen(value as DeliveryTabId); }}>
          <TabsList variant="line" data-testid="delivery-tabs-list" aria-label="Delivery sections" className="h-auto max-w-full group-data-[orientation=horizontal]/tabs:h-auto flex-wrap justify-start gap-[var(--space-1)]">
            {tabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id} className={`flex-none px-[var(--space-3)] ${TOUCH}`}>{tab.label}</TabsTrigger>)}
          </TabsList>
          {tabs.map((tab) => <Panel key={tab.id} tab={tab} props={props} onOpen={open} />)}
        </Tabs>}
      <footer data-testid="delivery-footer" className="grid gap-[var(--space-4)]">
        <Separator />
        <StudioCredit href={askTheStudioHref(street)} data-testid="delivery-footer-credit" />
      </footer>
    </div>
    {viewer && viewerItems && viewerItems.length > 0 && <ViewerBoundary onClose={() => { setViewer(null); }}>
      <Suspense fallback={null}>
        <DeliveryLightbox
          title={street} items={viewerItems} startIndex={viewer.index} hrefs={props.hrefs} unlock={props.unlockState} onRequestUnlock={props.onRequestUnlock}
          returnFocus={() => opener.current} onClose={() => { setViewer(null); }} />
      </Suspense>
    </ViewerBoundary>}
  </article>;
}
