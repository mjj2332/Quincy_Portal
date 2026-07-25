import { describe, expect, it } from "vitest";
import { DropboxRateLimitError, canRecoverDropboxError, classifyDropboxError, formatDropboxError } from "../src/dropbox/client";

describe("Dropbox health classification", () => {
  it("keeps auth/configuration failures sticky and classifies them in the existing error field", () => {
    expect(classifyDropboxError(new Error("Dropbox shared-link resolution failed; the Dropbox sharing.read scope may be missing"))).toBe("sharing_read");
    expect(classifyDropboxError(new Error("Dropbox folder not found: /bad — check the path in the project's Dropbox settings"))).toBe("folder_path");
    expect(classifyDropboxError(new Error("Dropbox token refresh failed (401)"))).toBe("credentials");
    expect(classifyDropboxError(new Error("Dropbox /users/get_current_account failed (403): scope missing"))).toBe("configuration");
    expect(formatDropboxError(new Error("Dropbox token refresh failed (401)"))).toMatch(/^\[dropbox:credentials\]/);
  });

  it("only clears a sticky error after a success exercised that capability", () => {
    const sharingError = "[dropbox:sharing_read] Dropbox shared-link resolution failed";
    expect(canRecoverDropboxError(sharingError, ["credentials", "current_account", "list_folder"])).toBe(false);
    expect(canRecoverDropboxError(sharingError, ["sharing_read"])).toBe(true);
    const pathError = "[dropbox:folder_path] Dropbox folder not found";
    expect(canRecoverDropboxError(pathError, ["credentials", "current_account", "list_folder"])).toBe(false);
    expect(canRecoverDropboxError(pathError, ["folder_path", "list_folder"])).toBe(true);
    const credentialsError = "[dropbox:credentials] Dropbox token refresh failed";
    expect(canRecoverDropboxError(credentialsError, ["credentials"])).toBe(true);
    expect(canRecoverDropboxError("[dropbox:transient] network error", ["list_folder"])).toBe(true);
    expect(canRecoverDropboxError("[dropbox:rate_limited] Dropbox is rate-limiting this app", [])).toBe(true);
  });

  it("classifies Dropbox 429 errors as automatically recoverable rate limits", () => {
    expect(classifyDropboxError(new DropboxRateLimitError("Dropbox files/download rate-limited (429), retry-after=63s", 63))).toBe("rate_limited");
    expect(classifyDropboxError(new Error("Dropbox files/download rate-limited (429), retry-after=unknowns"))).toBe("rate_limited");
  });
});
