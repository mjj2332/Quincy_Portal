import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createViteServer, loadConfigFromFile, type ViteDevServer } from "vite";
import { DEV_API_ORIGIN, devApiProxy } from "./dev-proxy";

// The worker's requireAppOrigin rejects any mutation whose Origin is not exactly APP_ORIGIN
// (http://localhost:8787 in dev). These tests drive a real Vite proxy, because the defect was
// in what the proxy forwards, not in any function on its own.

let api: Server;
let vite: ViteDevServer;
let viteOrigin: string;
let apiOrigin: string;
const seen: IncomingHttpHeaders[] = [];

beforeAll(async () => {
  api = createHttpServer((req, res) => {
    seen.push(req.headers);
    res.end("ok");
  });
  // #498: a WebSocket handshake. The worker answers 101 so the test can see what Origin it was handed.
  api.on("upgrade", (req, socket) => {
    seen.push(req.headers);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  vite = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", proxy: { "/api": devApiProxy(apiOrigin) } },
  });
  await vite.listen();
  viteOrigin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await vite?.close();
  await new Promise((resolve) => api?.close(resolve));
});

async function originSeenByApi(origin: string | undefined): Promise<string | undefined> {
  seen.length = 0;
  const res = await fetch(`${viteOrigin}/api/projects/x/stage`, {
    method: "POST",
    headers: origin === undefined ? {} : { origin },
    body: "{}",
  });
  expect(await res.text()).toBe("ok");
  expect(seen).toHaveLength(1);
  return seen[0]!.origin;
}

describe("Vite dev proxy Origin", () => {
  it("presents the dev server's own pages to the worker as the API origin", async () => {
    expect(await originSeenByApi(viteOrigin)).toBe(apiOrigin);
  });

  it("leaves a cross-site Origin alone, so the worker still rejects it", async () => {
    expect(await originSeenByApi("https://evil.example")).toBe("https://evil.example");
    expect(await originSeenByApi("http://127.0.0.1:1")).toBe("http://127.0.0.1:1");
  });

  it("does not invent an Origin the browser did not send", async () => {
    expect(await originSeenByApi(undefined)).toBeUndefined();
  });

  it("forwards a WebSocket upgrade (#498) with the same Origin rewrite as a mutation", async () => {
    async function upgradeOrigin(origin: string): Promise<string | undefined> {
      seen.length = 0;
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(`${viteOrigin}/api/projects/x/whiteboard/socket`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", Origin: origin } });
        req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(); });
        req.on("error", reject);
        req.end();
      });
      expect(seen).toHaveLength(1);
      return seen[0]!.origin;
    }
    expect(await upgradeOrigin(viteOrigin)).toBe(apiOrigin);
    expect(await upgradeOrigin("https://evil.example")).toBe("https://evil.example");
  });

  it("is what vite.config.ts proxies /api and /media through, aimed at the dev worker", async () => {
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "development" },
      fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
    );
    const proxy = loaded!.config.server!.proxy!;
    for (const path of ["/api", "/media"]) {
      const entry = proxy[path];
      expect(entry, path).toMatchObject({ target: DEV_API_ORIGIN });
      expect(typeof entry === "object" && entry.configure, path).toBeTypeOf("function");
    }
    expect(DEV_API_ORIGIN).toBe("http://localhost:8787");
  });
});
