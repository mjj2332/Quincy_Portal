import { expect, it } from "vitest";

it.skip("never runs", () => { expect(1).toBe(1); });
it.skip("never runs either", () => { expect(1).toBe(1); });
