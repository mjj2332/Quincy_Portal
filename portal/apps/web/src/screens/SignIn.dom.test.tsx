import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signInMock = vi.hoisted(() => vi.fn<(pathname: string) => Promise<void>>());
vi.mock("../lib/auth", () => ({ signIn: signInMock }));

import { SignIn } from "./SignIn";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  signInMock.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host.remove();
});

describe("SignIn", () => {
  it("calls signIn with the pathname the screen was given", async () => {
    signInMock.mockResolvedValue(undefined);
    await act(async () => { root!.render(<SignIn pathname="/projects/target" />); });

    const button = host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { button.click(); });
    await flush();

    expect(signInMock).toHaveBeenCalledWith("/projects/target");
  });

  it("shows a disabled Connecting… button while sign-in is pending", async () => {
    let resolveSignIn!: () => void;
    signInMock.mockImplementation(() => new Promise<void>((resolve) => { resolveSignIn = resolve; }));
    await act(async () => { root!.render(<SignIn pathname="/" />); });

    const button = host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { button.click(); });

    expect(button.textContent).toBe("Connecting…");
    expect(button.disabled).toBe(true);

    resolveSignIn();
    await flush();
  });

  it("renders a rejection message in [role=alert] and re-enables the button", async () => {
    signInMock.mockRejectedValue(new Error("Google sign-in could not be started."));
    await act(async () => { root!.render(<SignIn pathname="/" />); });

    const button = host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { button.click(); });
    await flush();

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Google sign-in could not be started.");
    // Re-query rather than reusing the pre-click node: if the error render ever remounted the
    // button, the detached original would still read `disabled === false` and this assertion
    // would pass without proving anything.
    const settled = host.querySelector<HTMLButtonElement>("button")!;
    expect(settled.isConnected).toBe(true);
    expect(settled.disabled).toBe(false);
  });
});
