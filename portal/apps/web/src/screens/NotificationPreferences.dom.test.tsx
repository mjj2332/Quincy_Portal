import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { NotificationPreferences } from "./NotificationPreferences";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPatchMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPatch: (path: string, body: unknown) => apiPatchMock(path, body) };
});

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

beforeEach(() => {
  apiGetMock.mockReset().mockResolvedValue({ projectDeadlineReminderEmails: true });
  apiPatchMock.mockReset().mockResolvedValue({ projectDeadlineReminderEmails: false });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; document.body.replaceChildren();
});

describe("NotificationPreferences", () => {
  it("loads the default and states that in-app reminders are mandatory", async () => {
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    expect(apiGetMock).toHaveBeenCalledWith("/api/notification-preferences");
    expect(host.textContent).toContain("Project deadline reminder emails");
    expect(host.textContent).toContain("In-app Deadline reminders are always delivered.");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  });

  it("rolls an optimistic toggle back to the authoritative value when saving fails", async () => {
    apiPatchMock.mockRejectedValueOnce(new ApiError("Preference save failed", 500));
    const host = document.body.firstElementChild as HTMLElement;
    await act(async () => { root!.render(<NotificationPreferences />); await Promise.resolve(); });
    await flush();
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); await Promise.resolve(); });
    expect(apiPatchMock).toHaveBeenCalledWith("/api/notification-preferences", { projectDeadlineReminderEmails: false });
    await flush();
    expect(checkbox.checked).toBe(true);
    expect(host.textContent).toContain("Preference save failed");
  });
});
