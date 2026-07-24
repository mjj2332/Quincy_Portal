import { parseStaffPathname, safeStaffDestination, staffPathFor, type StaffRoute } from "@quincy/shared";

export { parseStaffPathname, safeStaffDestination, staffPathFor, type StaffRoute };

export type HistorySource = {
  location: Pick<Location, "pathname">;
  history: Pick<History, "pushState" | "replaceState">;
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
};

export function createHistoryAdapter(source: HistorySource) {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const onPopState = () => notify();

  return {
    getPathname: () => source.location.pathname,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) source.addEventListener("popstate", onPopState);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) source.removeEventListener("popstate", onPopState);
      };
    },
    push(pathname: string) {
      const destination = safeStaffDestination(pathname) ?? "/";
      source.history.pushState(null, "", destination);
      notify();
    },
    replace(pathname: string) {
      const destination = safeStaffDestination(pathname) ?? "/";
      source.history.replaceState(null, "", destination);
      notify();
    },
  };
}

const browserHistory = typeof window === "undefined" ? null : createHistoryAdapter(window);

export function locationStore() {
  if (!browserHistory) throw new Error("Browser history is unavailable.");
  return browserHistory;
}

export type LinkClick = {
  button: number;
  detail: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  currentTarget: { href: string; target: string; download: string };
};

/** Keyboard-generated anchor clicks have detail 0 and must retain native behavior. */
export function shouldInterceptInternalLink(event: LinkClick, origin: string): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.detail === 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const anchor = event.currentTarget;
  if (anchor.target || anchor.download) return false;
  try {
    const url = new URL(anchor.href, origin);
    return url.origin === origin && safeStaffDestination(url.pathname) !== null;
  } catch {
    return false;
  }
}
