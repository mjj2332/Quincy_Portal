import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "./chunk-load-error";

const URL_SUFFIX = ": https://x/assets/ProductionGantt-OLD.js";

describe("isChunkLoadError (#292)", () => {
  it.each([
    ["Chromium", new TypeError(`Failed to fetch dynamically imported module${URL_SUFFIX}`)],
    ["Safari", new TypeError(`Importing a module script failed${URL_SUFFIX}`)],
    ["Firefox", new TypeError(`error loading dynamically imported module${URL_SUFFIX}`)],
    ["Vite CSS preload", new Error(`Unable to preload CSS for /assets/ProductionGantt-OLD.css`)],
  ])("recognises the %s message", (_engine, error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    ["a plain Error", new Error("boom")],
    ["an unrelated TypeError", new TypeError("Cannot read properties of undefined (reading 'id')")],
    ["a string", `Failed to fetch dynamically imported module${URL_SUFFIX}`],
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["a non-string message", { message: 42 }],
  ])("rejects %s", (_label, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});
