import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionState = vi.hoisted(() => ({ role: "photographer" as const }));
vi.mock("./lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "photographer-a", name: "Photographer", role: sessionState.role, authorizationEpoch: 0 } }, isPending: false }),
  consumeSignInDestination: () => null,
  stopImpersonating: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("./lib/capabilities", () => ({ useCapabilities: () => ({ role: sessionState.role, capabilities: [], can: () => false }) }));
vi.mock("./lib/api", () => ({ apiGet: vi.fn(async () => ({ notifications: [], unreadCount: 0 })), apiPost: vi.fn(async () => ({})), apiDelete: vi.fn(async () => ({})) }));
vi.mock("./lib/stages", () => ({ StagesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("./lib/query-client", () => ({ QuincyQueryProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./components/quincy/RailedShell", () => ({ RailedShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./screens/Dashboard", () => ({ Dashboard: () => <main data-testid="dashboard-leaf">Dashboard</main> }));
vi.mock("./screens/ProjectWorkspace", () => ({ ProjectWorkspace: () => <main>Project</main> }));
vi.mock("./screens/Admin", () => ({ Admin: () => <main>Admin</main> }));
vi.mock("./screens/CreateProject", () => ({ CreateProject: () => <main>Create</main> }));
vi.mock("./screens/EditProject", () => ({ EditProject: () => <main>Edit</main> }));
vi.mock("./screens/NotificationPreferences", () => ({ NotificationPreferences: () => <main>Preferences</main> }));
vi.mock("./screens/Notifications", () => ({ Notifications: () => <main>Notifications</main> }));
vi.mock("./screens/SignIn", () => ({ SignIn: () => <main>Sign in</main> }));

import App from "./App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
  window.history.replaceState(null, "", "/?view=calendar&q=smith");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

describe("unauthorized Calendar redirect with Dashboard search (#217)", () => {
  it("falls back to the Dashboard while retaining q", async () => {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?q=smith");
  });
});
