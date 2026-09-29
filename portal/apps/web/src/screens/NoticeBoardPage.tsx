/**
 * The Notice board's own page (#334). A thin screen: the frame and header follow the other
 * capped pages (`Notifications.tsx`), and everything else is the existing `NoticeBoard`.
 *
 * Access is gated by the route leaf (`lib/app-router.tsx`) and, authoritatively, by the API.
 * `currentUserId` is the shell's effective principal, so an impersonating Admin acts as the
 * impersonated user for the author-only rules, exactly as on the Dashboard before.
 */
import { NoticeBoard } from "../components/NoticeBoard";

const PAGE = "page !max-w-[var(--container-md)]";
const HEAD = "flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]";
const H1 = "[font:var(--type-h1)] tracking-[var(--tracking-tight)] m-0";
const LEDE = "mt-[var(--space-3)] mb-0 max-w-[46ch] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "text-foreground-secondary";

export function NoticeBoardPage({ currentUserId }: { currentUserId: string }) {
  return (
    <main className={PAGE}>
      <header className={HEAD}>
        <div>
          <h1 className={H1}>Notice board</h1>
          <p className={LEDE}>Messages for the production desk.</p>
        </div>
      </header>
      <NoticeBoard currentUserId={currentUserId} />
    </main>
  );
}
