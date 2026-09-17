import type { ProxyOptions } from "vite";

/** The local `wrangler dev` worker. Its APP_ORIGIN is this value (`workers/app/.dev.vars.example`). */
export const DEV_API_ORIGIN = "http://localhost:8787";

/**
 * Proxy options for forwarding the Vite dev server's `/api` and `/media` to the worker.
 *
 * The worker's `requireAppOrigin` rejects every mutation whose `Origin` is not exactly APP_ORIGIN.
 * A page on the Vite server sends its own origin (`http://localhost:5173`), so without this every
 * POST/PUT/PATCH/DELETE from `npm run dev` returned 403. The rewrite applies only when the Origin is
 * the dev server itself (it matches the request's `Host`). A cross-site page keeps its own Origin,
 * so the worker still rejects it.
 */
export function devApiProxy(target: string): ProxyOptions {
  return {
    target,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq, req) => {
        if (isSameOrigin(req.headers.origin, req.headers.host)) proxyReq.setHeader("origin", target);
      });
    },
  };
}

function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host || !URL.canParse(origin)) return false;
  const url = new URL(origin);
  return (url.protocol === "http:" || url.protocol === "https:") && url.host === host;
}
