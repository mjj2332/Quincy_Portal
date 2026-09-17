import { expect, it } from "vitest";

it("runs", () => { expect(1).toBe(1); });
it.skip("does not", () => { expect(1).toBe(1); });
