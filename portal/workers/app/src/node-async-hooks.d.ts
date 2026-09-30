// The Worker compiles against @cloudflare/workers-types only (no @types/node), but wrangler's
// `nodejs_compat` flag provides this module at runtime. Declare just the surface #361 uses.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
