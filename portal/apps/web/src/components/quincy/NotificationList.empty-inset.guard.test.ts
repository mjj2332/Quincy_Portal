/**
 * Empty-state ghost-button inset guard (#619) — the Unread empty state's ghost `Button size="sm"`
 * has its own horizontal padding, which pushed its label off the column the heading, tabs, copy
 * and footer share. Pinned as SOURCE TEXT (happy-dom does no layout, and `.dom.test.tsx` files may
 * not assert classes — see `test-seam.guard.test.ts`): the button pulls itself back by exactly the
 * `sm` size variant's own horizontal padding token, so its hover background keeps its room.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const list = readFileSync(join(here, "NotificationList.tsx"), "utf8");
const button = readFileSync(join(here, "../reui/button.tsx"), "utf8");

describe("NotificationList empty-state ghost button inset", () => {
  it("negates the sm button's horizontal padding so its label sits on the text column", () => {
    const sm = button.match(/\bsm:\s*"([^"]*)"/)?.[1] ?? "";
    const pad = sm.match(/(?<![\w-:])px-([\d.]+)/)?.[1];
    expect(pad).toBeDefined();
    const tag = list.match(/<Button[^>]*data-testid="rail-notifications-show-all"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('size="sm"');
    expect(tag).toMatch(new RegExp(`className="[^"]*(?<![\\w-])-ms-${pad!.replace(".", "\\.")}(?![\\w.])`));
  });
});
