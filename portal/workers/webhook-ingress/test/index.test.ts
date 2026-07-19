import { describe, expect, it } from "vitest";
import worker from "../src/index";

const baseEnv = {
  APP_ENV: "production",
  DB: {} as D1Database,
  BACKGROUND: {} as Fetcher,
};

describe("webhook ingress", () => {
  it("reports health", async () => {
    const response = await worker.request("https://webhook.test/health", {}, baseEnv);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "quincy-webhook-ingress" });
  });

  it("echoes the Dropbox verification challenge without a secret", async () => {
    const response = await worker.request("https://webhook.test/webhooks/dropbox?challenge=quincy-test", {}, baseEnv);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("quincy-test");
  });

  it("fails closed when Dropbox posts before its secret is configured", async () => {
    const response = await worker.request("https://webhook.test/webhooks/dropbox", { method: "POST", body: "{}" }, baseEnv);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Dropbox webhook is not configured");
  });
});
