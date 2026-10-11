import { useSyncExternalStore } from "react";

/**
 * Where the single toast viewport renders (#776 E). A modal dialog traps focus, so a toast left in the page behind it holds an action (Undo) the keyboard cannot reach. A modal that
 * stays open over the page registers an element inside itself; `ToastViewport` then portals into the latest one registered, and back into the page when it unregisters. There is still
 * exactly one viewport, so nothing is announced twice.
 */
let hosts: HTMLElement[] = [];
const listeners = new Set<() => void>();
const notify = () => { listeners.forEach((listener) => { listener(); }); };

export function registerToastHost(element: HTMLElement): () => void {
  hosts = [...hosts, element];
  notify();
  return () => { hosts = hosts.filter((candidate) => candidate !== element); notify(); };
}

const current = (): HTMLElement | null => hosts.at(-1) ?? null;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useToastHost = (): HTMLElement | null => useSyncExternalStore(subscribe, current, current);
