import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { checkVendorChunk, VENDOR_MODULE_PATTERN, vendorChunkGuard, type VendorGuardChunk } from "./vendor-chunk-guard";

const NM = "/repo/portal/node_modules";
const APP = "/repo/portal/apps/web/src";

function context() {
  return { error(message: string): never { throw new Error(message); } };
}

function chunk(overrides: Partial<VendorGuardChunk>): VendorGuardChunk {
  return { type: "chunk", name: "x", fileName: "assets/x.js", isEntry: false, moduleIds: [], ...overrides };
}

describe("VENDOR_MODULE_PATTERN", () => {
  it.each([
    `${NM}/react/index.js`,
    `${NM}/react-dom/client.js`,
    `${NM}/scheduler/index.js`,
    `${NM}/@tanstack/react-router/dist/esm/index.js`,
    `${NM}/@tanstack/react-query/build/modern/index.js`,
    `${NM}/@base-ui/react/menu/index.js`,
    "C:\\repo\\node_modules\\react\\index.js",
  ])("matches %s", (id) => expect(VENDOR_MODULE_PATTERN.test(id)).toBe(true));

  it.each([`${APP}/App.tsx`, `${NM}/date-fns/index.js`, `${NM}/react-day-picker/index.js`, `${NM}/@tiptap/react/index.js`])(
    "does not match %s", (id) => expect(VENDOR_MODULE_PATTERN.test(id)).toBe(false),
  );
});

describe("checkVendorChunk (#359)", () => {
  it("passes a clean split: vendor chunk holds React, the entry holds only app code", () => {
    expect(() => checkVendorChunk(context(), {
      "assets/index.js": chunk({ name: "index", isEntry: true, moduleIds: [`${APP}/main.tsx`, `${APP}/App.tsx`] }),
      "assets/vendor.js": chunk({ name: "vendor", moduleIds: [`${NM}/react/index.js`, `${NM}/@base-ui/react/menu/index.js`] }),
      "assets/index.css": { type: "asset" },
    })).not.toThrow();
  });

  it("fails when React leaks into the entry chunk", () => {
    expect(() => checkVendorChunk(context(), {
      "assets/index.js": chunk({ name: "index", fileName: "assets/index-abc.js", isEntry: true, moduleIds: [`${APP}/main.tsx`, `${NM}/react-dom/client.js`] }),
      "assets/vendor.js": chunk({ name: "vendor", moduleIds: [`${NM}/react/index.js`] }),
    })).toThrow(/entry chunk assets\/index-abc\.js contains 1 vendor module/u);
  });

  it.each([
    ["TanStack Router", `${NM}/@tanstack/react-router/dist/esm/index.js`],
    ["Base UI", `${NM}/@base-ui/react/dialog/index.js`],
  ])("fails when %s leaks into the entry chunk", (_name, id) => {
    expect(() => checkVendorChunk(context(), {
      "assets/index.js": chunk({ name: "index", isEntry: true, moduleIds: [id] }),
      "assets/vendor.js": chunk({ name: "vendor", moduleIds: [] }),
    })).toThrow(/vendor module/u);
  });

  it("fails when no chunk is named vendor", () => {
    expect(() => checkVendorChunk(context(), {
      "assets/index.js": chunk({ name: "index", isEntry: true, moduleIds: [`${APP}/main.tsx`] }),
    })).toThrow(/no chunk named "vendor"/u);
  });

  it("ignores vendor modules in non-entry chunks", () => {
    expect(() => checkVendorChunk(context(), {
      "assets/index.js": chunk({ name: "index", isEntry: true, moduleIds: [`${APP}/main.tsx`] }),
      "assets/vendor.js": chunk({ name: "vendor", moduleIds: [`${NM}/react/index.js`] }),
      "assets/field.js": chunk({ name: "field", moduleIds: [`${NM}/@base-ui/react/field/index.js`] }),
    })).not.toThrow();
  });
});

describe("vendorChunkGuard plugin", () => {
  it("is a build-only plugin whose generateBundle runs the check", () => {
    const plugin = vendorChunkGuard();
    expect(plugin.apply).toBe("build");
    const hook = plugin.generateBundle as unknown as (this: unknown, options: unknown, bundle: unknown) => void;
    expect(() => hook.call(context(), {}, { "a.js": chunk({ isEntry: true, moduleIds: [`${NM}/react/index.js`] }) })).toThrow();
  });

  it("is registered as a direct element of plugins in the real vite.config.ts", () => {
    const source = readFileSync(fileURLToPath(new URL("../../vite.config.ts", import.meta.url)), "utf8");
    const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
    const exportDefault = ast.program.body.find((node) => node.type === "ExportDefaultDeclaration") as any;
    const config = exportDefault.declaration.arguments[0];
    const plugins = config.properties.find((p: any) => p.key?.name === "plugins")?.value;
    expect(plugins?.type).toBe("ArrayExpression");
    expect(plugins.elements.some((el: any) => el?.type === "CallExpression" && el.callee.name === "vendorChunkGuard")).toBe(true);
    const groups = source.includes("codeSplitting") && source.includes("VENDOR_MODULE_PATTERN");
    expect(groups, "vite.config.ts must define the vendor codeSplitting group").toBe(true);
  });
});
