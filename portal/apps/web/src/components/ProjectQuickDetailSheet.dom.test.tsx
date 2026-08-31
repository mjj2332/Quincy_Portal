import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectQuickDetailSheet, type ProjectQuickDetailView } from "./ProjectQuickDetailSheet";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/project-data", () => ({ useProjectDetailQuery: queryMock }));
vi.mock("./ProjectOverviewView", () => ({
  ProjectOverviewView: () => {
    const [draft, setDraft] = useState("");
    return <section aria-label="Project overview"><button type="button" data-testid="set-overview-draft" onClick={() => setDraft("kept")}>Set overview draft</button><label>Overview draft<input data-testid="overview-draft" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} /></label></section>;
  },
}));
vi.mock("./ProjectActivityView", () => ({
  ProjectActivityView: () => {
    const [draft, setDraft] = useState("");
    return <section aria-label="Project activity"><label>Activity draft<input data-testid="activity-draft" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} /></label></section>;
  },
}));
vi.mock("./ProjectDiscussionThread", () => ({
  ProjectDiscussionThread: ({ children, onUnreadCountChange }: { children: (value: { content: ReactNode; project: undefined; scrollRootRef: () => void }) => ReactNode; onUnreadCountChange?: (count: number) => void }) => {
    useEffect(() => { onUnreadCountChange?.(3); }, [onUnreadCountChange]);
    return children({ content: <section aria-label="Project discussion">Discussion draft</section>, project: undefined, scrollRootRef: () => undefined });
  },
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const workspaceHref = `/projects/${projectId}`;
let root: Root;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(value: React.ReactNode) {
  act(() => { root.render(value); });
}

function sheetProps(overrides: Partial<React.ComponentProps<typeof ProjectQuickDetailSheet>> = {}) {
  return { projectId, title: "72 Discussion Lane", activeView: "overview" as ProjectQuickDetailView, onViewChange: vi.fn(), onRequestClose: vi.fn(), role: "editor" as const, workspaceHref, ...overrides };
}

beforeEach(() => {
  queryMock.mockReset().mockReturnValue({ data: undefined, isPending: true, error: null, refetch: vi.fn(() => Promise.resolve()) });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); document.body.style.overflow = ""; document.body.style.paddingRight = ""; });

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

describe("ProjectQuickDetailSheet", () => {
  it("renders modal semantics, focuses into the sheet, exposes the Workspace anchor, and locks scroll", async () => {
    document.body.style.overflow = "scroll";
    document.body.style.paddingRight = "4px";
    render(<ProjectQuickDetailSheet {...sheetProps()} />); await flush();
    const dialog = document.querySelector('[data-testid="project-quick-detail-sheet"]') as HTMLElement;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.activeElement === dialog.querySelector("h2") || document.activeElement === dialog.querySelector(".project-quick-detail-sheet__close")).toBe(true);
    expect(document.querySelector<HTMLAnchorElement>(`a[href="${workspaceHref}"]`)).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");
    act(() => root.unmount());
    expect(document.body.style.overflow).toBe("scroll");
    expect(document.body.style.paddingRight).toBe("4px");
    root = createRoot(host);
  });

  it("keeps scroll locked and scrollbar-compensated while any overlapping sheet mount is still active", async () => {
    const innerWidthSpy = vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    const clientWidthSpy = vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1009);
    document.body.style.overflow = "auto";
    document.body.style.paddingRight = "0px";
    const hostB = document.createElement("div"); document.body.append(hostB);
    const rootB = createRoot(hostB);
    render(<ProjectQuickDetailSheet {...sheetProps()} />); await flush();
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.paddingRight).toBe("15px");
    act(() => { rootB.render(<ProjectQuickDetailSheet {...sheetProps()} />); }); await flush();
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.paddingRight).toBe("15px");
    act(() => root.unmount());
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.paddingRight).toBe("15px");
    act(() => { rootB.unmount(); });
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.paddingRight).toBe("0px");
    hostB.remove();
    innerWidthSpy.mockRestore(); clientWidthSpy.mockRestore();
    root = createRoot(host);
  });

  it("closes on Escape unless a nested editor or confirmation owns it", () => {
    const onRequestClose = vi.fn();
    render(<ProjectQuickDetailSheet {...sheetProps({ onRequestClose })} />);
    (document.querySelector("h2") as HTMLElement).focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(onRequestClose).toHaveBeenCalledOnce();

    onRequestClose.mockClear();
    render(<ProjectQuickDetailSheet {...sheetProps({ onRequestClose, escapeDisabled: true })} />);
    (document.querySelector("h2") as HTMLElement).focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it("uses roving arrow-key tabs and keeps each child mounted across view changes", async () => {
    function Harness() {
      const [view, setView] = useState<ProjectQuickDetailView>("overview");
      return <ProjectQuickDetailSheet {...sheetProps({ activeView: view, onViewChange: setView })} />;
    }
    render(<Harness />); await flush();
    const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    act(() => { (document.querySelector<HTMLButtonElement>('[data-testid="set-overview-draft"]')!).click(); });
    tabs()[0]!.focus();
    act(() => { tabs()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[1]);
    expect(document.querySelector('[data-testid="overview-draft"]')).not.toBeNull();
    act(() => { tabs()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    expect(tabs()[2]!.getAttribute("aria-selected")).toBe("true");
    act(() => { tabs()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); });
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    act(() => { tabs()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); });
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect((document.querySelector('[data-testid="overview-draft"]') as HTMLInputElement).value).toBe("kept");
    act(() => { tabs()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    act(() => { tabs()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); });
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    act(() => { tabs()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); });
    expect(tabs()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[2]);
    act(() => { tabs()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })); });
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[0]);
  });

  it("shows a textual unread badge on Discussion", async () => {
    render(<ProjectQuickDetailSheet {...sheetProps()} />); await flush();
    const discussionTab = document.querySelector<HTMLButtonElement>('[role="tab"][id^="project-quick-detail-tab-discussion"]')!;
    expect(discussionTab.textContent).toContain("Discussion");
    expect(discussionTab.textContent).toContain("3");
    expect(discussionTab.querySelector(".project-quick-detail-sheet__unread")?.getAttribute("aria-label")).toBe("3 unread comments");
  });
});
