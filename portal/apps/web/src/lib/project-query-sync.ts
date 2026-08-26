import { createContext, createElement, useContext, type ReactNode } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { CollectionKind } from "@quincy/shared";
import { isProjectQueryLedgerPending, projectDataKeys } from "./project-data";

export const PROJECT_DATA_CHANNEL = "quincy:project-data:v1";

export type ProjectDataResource =
  | { kind: "detail" }
  | { kind: "assets"; collectionKind: CollectionKind }
  | { kind: "comments" }
  | { kind: "comment-read-marker" }
  | { kind: "collaboration-summary" };

export type ProjectDataSyncMessage =
  | {
      version: 1;
      type: "project-data-invalidated";
      sourceTabId: string;
      projectId: string;
      committedAt: string;
      resources: ProjectDataResource[];
    }
  | {
      version: 1;
      type: "project-data-removed";
      sourceTabId: string;
      projectId: string;
      committedAt: string;
    }
  | {
      version: 1;
      type: "active-project-details-invalidated";
      sourceTabId: string;
      committedAt: string;
    };

export type ProjectDataOutgoingMessage =
  | Omit<Extract<ProjectDataSyncMessage, { type: "project-data-invalidated" }>, "sourceTabId">
  | Omit<Extract<ProjectDataSyncMessage, { type: "project-data-removed" }>, "sourceTabId">
  | Omit<Extract<ProjectDataSyncMessage, { type: "active-project-details-invalidated" }>, "sourceTabId">;

type Listener = () => void;

const validCollections = new Set<CollectionKind>(["raw", "edited", "video", "floorplan", "copy"]);
const runtimes = new WeakMap<QueryClient, ProjectQueryRuntime>();

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isResource(value: unknown): value is ProjectDataResource {
  if (!value || typeof value !== "object") return false;
  const resource = value as Record<string, unknown>;
  if (resource.kind === "detail" || resource.kind === "comments" || resource.kind === "comment-read-marker" || resource.kind === "collaboration-summary") return Object.keys(resource).length === 1;
  return resource.kind === "assets" && validCollections.has(resource.collectionKind as CollectionKind) && Object.keys(resource).length === 2;
}

export function parseProjectDataSyncMessage(value: unknown): ProjectDataSyncMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.version !== 1 || !nonEmptyString(message.sourceTabId)) return null;
  if (message.type === "project-data-invalidated") {
    if (!nonEmptyString(message.projectId) || !nonEmptyString(message.committedAt) || !Array.isArray(message.resources) || message.resources.length === 0 || !message.resources.every(isResource)) return null;
    const resources = [...new Map((message.resources as ProjectDataResource[]).map((resource) => [JSON.stringify(resource), resource])).values()];
    if (Object.keys(message).some((key) => !["version", "type", "sourceTabId", "projectId", "committedAt", "resources"].includes(key))) return null;
    return { version: 1, type: message.type, sourceTabId: message.sourceTabId, projectId: message.projectId, committedAt: message.committedAt, resources };
  }
  if (message.type === "project-data-removed") {
    if (!nonEmptyString(message.projectId) || !nonEmptyString(message.committedAt)) return null;
    if (Object.keys(message).some((key) => !["version", "type", "sourceTabId", "projectId", "committedAt"].includes(key))) return null;
    return { version: 1, type: message.type, sourceTabId: message.sourceTabId, projectId: message.projectId, committedAt: message.committedAt };
  }
  if (message.type === "active-project-details-invalidated") {
    if (!nonEmptyString(message.committedAt)) return null;
    if (Object.keys(message).some((key) => !["version", "type", "sourceTabId", "committedAt"].includes(key))) return null;
    return { version: 1, type: message.type, sourceTabId: message.sourceTabId, committedAt: message.committedAt };
  }
  return null;
}

function keyString(queryKey: QueryKey): string {
  return JSON.stringify(queryKey);
}

export function projectResourceKey(projectId: string, resource: ProjectDataResource): QueryKey {
  switch (resource.kind) {
    case "detail": return projectDataKeys.detail(projectId);
    case "assets": return projectDataKeys.assets(projectId, resource.collectionKind);
    case "comments": return projectDataKeys.comments(projectId);
    case "comment-read-marker": return projectDataKeys.commentReadMarker(projectId);
    case "collaboration-summary": return projectDataKeys.collaborationSummary(projectId);
    default: return assertNever(resource);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unknown project data resource: ${JSON.stringify(value)}`);
}

export class ProjectQueryRuntime {
  private readonly listeners = new Set<Listener>();
  private readonly owners = new Map<string, number>();
  private version = 0;
  private channel: BroadcastChannel | null = null;
  private disposed = false;
  private readonly deferredInvalidations = new Map<string, QueryKey>();
  readonly removedProjectIds = new Set<string>();
  principalTerminal = false;

  constructor(readonly queryClient: QueryClient, readonly sourceTabId: string = crypto.randomUUID()) {
    runtimes.set(queryClient, this);
  }

  start() {
    this.disposed = false;
    runtimes.set(this.queryClient, this);
    if (this.channel || typeof BroadcastChannel === "undefined") return;
    try {
      this.channel = new BroadcastChannel(PROJECT_DATA_CHANNEL);
      this.channel.addEventListener("message", (event: MessageEvent<unknown>) => this.receive(event.data));
    } catch {
      this.channel = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.channel?.close();
    this.channel = null;
    this.owners.clear();
    this.deferredInvalidations.clear();
    this.listeners.clear();
    runtimes.delete(this.queryClient);
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.version;

  notify() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  isProjectRemoved(projectId: string) {
    return this.principalTerminal || this.removedProjectIds.has(projectId);
  }

  markProjectRemoved(projectId: string) {
    if (this.removedProjectIds.has(projectId)) return false;
    this.removedProjectIds.add(projectId);
    this.notify();
    return true;
  }

  markPrincipalTerminal() {
    if (this.principalTerminal) return false;
    this.principalTerminal = true;
    this.notify();
    return true;
  }

  isOwned(queryKey: QueryKey) {
    return (this.owners.get(keyString(queryKey)) ?? 0) > 0;
  }

  acquireOwner(queryKey: QueryKey) {
    const key = keyString(queryKey);
    this.owners.set(key, (this.owners.get(key) ?? 0) + 1);
    this.notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.owners.get(key) ?? 1) - 1;
      if (next > 0) this.owners.set(key, next); else this.owners.delete(key);
      this.notify();
      if (next <= 0) this.flushDeferred(queryKey);
    };
  }

  flushDeferred(queryKey: QueryKey) {
    if (!this.takeDeferred(queryKey)) return;
    void this.queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" });
  }

  takeDeferred(queryKey: QueryKey) {
    const key = keyString(queryKey);
    if (this.isOwned(queryKey) || isProjectQueryLedgerPending(this.queryClient, queryKey)) return false;
    return this.deferredInvalidations.delete(key);
  }

  private invalidateOrDefer(queryKey: QueryKey) {
    if (this.isOwned(queryKey) || isProjectQueryLedgerPending(this.queryClient, queryKey)) {
      this.deferredInvalidations.set(keyString(queryKey), queryKey);
      return;
    }
    void this.queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" });
  }

  publish(message: ProjectDataOutgoingMessage) {
    if (!this.channel || this.disposed) return;
    this.channel.postMessage({ ...message, sourceTabId: this.sourceTabId });
  }

  private receive(value: unknown) {
    const message = parseProjectDataSyncMessage(value);
    if (!message || message.sourceTabId === this.sourceTabId) return;
    if (message.type === "project-data-removed") {
      if (!this.markProjectRemoved(message.projectId)) return;
      // Let the subscribed Workspace render its terminal branch and unmount its query owner
      // before the private cache is cancelled and removed.
      queueMicrotask(() => {
        void this.queryClient.cancelQueries({ queryKey: projectDataKeys.project(message.projectId) }).then(() => {
          this.queryClient.removeQueries({ queryKey: projectDataKeys.project(message.projectId) });
        });
      });
      return;
    }
    if (message.type === "active-project-details-invalidated") {
      for (const query of this.queryClient.getQueryCache().getAll()) {
        const key = query.queryKey;
        if (key.length !== 3 || key[0] !== "project-data" || key[2] !== "detail" || query.getObserversCount() === 0) continue;
        this.invalidateOrDefer(key);
      }
      return;
    }
    for (const resource of message.resources) {
      const key = projectResourceKey(message.projectId, resource);
      this.invalidateOrDefer(key);
    }
  }
}

export function getProjectQueryRuntime(queryClient: QueryClient): ProjectQueryRuntime | undefined {
  return runtimes.get(queryClient);
}

export function ProjectQueryRuntimeProvider({ runtime, children }: { runtime: ProjectQueryRuntime; children: ReactNode }) {
  return createElement(ProjectQueryRuntimeContext.Provider, { value: runtime }, children);
}

export const ProjectQueryRuntimeContext = createContext<ProjectQueryRuntime | null>(null);

export function useProjectQueryRuntime(): ProjectQueryRuntime {
  const runtime = useContext(ProjectQueryRuntimeContext);
  if (!runtime) throw new Error("Project data queries must be rendered inside QuincyQueryProvider.");
  return runtime;
}

export function createProjectDataInvalidationMessage(projectId: string, resources: ProjectDataResource[]): ProjectDataOutgoingMessage {
  return { version: 1, type: "project-data-invalidated", projectId, committedAt: new Date().toISOString(), resources: [...new Map(resources.map((resource) => [JSON.stringify(resource), resource])).values()] };
}

export function createProjectDataRemovedMessage(projectId: string): ProjectDataOutgoingMessage {
  return { version: 1, type: "project-data-removed", projectId, committedAt: new Date().toISOString() };
}

export function createActiveProjectDetailsInvalidatedMessage(): ProjectDataOutgoingMessage {
  return { version: 1, type: "active-project-details-invalidated", committedAt: new Date().toISOString() };
}
