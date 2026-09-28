import { Component, type ReactNode } from "react";
import { isChunkLoadError } from "../lib/chunk-load-error";
import { Button } from "./quincy/Button";
import { EmptyState } from "./quincy/EmptyState";
import { Notice } from "./quincy/Notice";

type ViewLoadBoundaryProps = {
  /** Names the view in the fallback copy ("… open the Gantt."). */
  viewLabel: string;
  /** Seam for tests: happy-dom cannot observe a real `location.reload()`. */
  reload?: () => void;
  children: ReactNode;
};

type ViewLoadBoundaryState = { error: unknown; failed: boolean };

const defaultReload = () => window.location.reload();

/**
 * #292: contains a lazy view's load (or render) failure inside the Dashboard instead of letting
 * it reach TanStack's global CatchBoundary, which replaces the whole shell. A stale hashed chunk
 * after a deploy is the expected case: React `lazy` and the browser's module map both cache the
 * rejection, so only a full reload recovers — and that reload is the user's to trigger, never
 * automatic. There is no reset key: the boundary resets by unmounting (leaving the view).
 *
 * No `componentDidCatch`: React 19's default `onCaughtError` already reports the error to
 * `console.error`, and this boundary must not hide it.
 */
export class ViewLoadBoundary extends Component<ViewLoadBoundaryProps, ViewLoadBoundaryState> {
  state: ViewLoadBoundaryState = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): ViewLoadBoundaryState {
    return { error, failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { viewLabel, reload = defaultReload } = this.props;

    if (isChunkLoadError(this.state.error)) {
      return (
        <Notice tone="caution" role="alert" data-testid="view-load-error" data-kind="chunk" className="flex items-baseline gap-[var(--space-3)] mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] before:content-['Update'] before:shrink-0 before:[font:var(--type-eyebrow)] before:uppercase before:tracking-[var(--tracking-widest)] before:text-signal-caution-text text-foreground">
          <span className="flex-1">{`The Portal may have been updated. Reload to open the ${viewLabel}.`}</span>
          <Button type="button" variant="secondary" onClick={() => reload()}>Reload</Button>
        </Notice>
      );
    }

    return (
      <EmptyState tone="error" role="alert" data-testid="view-load-error" data-kind="error" title={`The ${viewLabel} could not load.`} className="border-solid border-[length:var(--border-width-hair)] border-border bg-card [border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-destructive">
        Reload the page to try again.
        <div><Button type="button" variant="secondary" className="mt-[var(--space-4)]" onClick={() => reload()}>Reload</Button></div>
      </EmptyState>
    );
  }
}
