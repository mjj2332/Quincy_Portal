// workers-types does not declare `node:zlib`. This covers only `crc32`, which the Workers runtime
// provides under `nodejs_compat` (compat date >= 2026-07-01). Same approach as node-async-hooks.d.ts.
declare module "node:zlib" {
  export function crc32(data: string | ArrayBufferView, value?: number): number;
}
