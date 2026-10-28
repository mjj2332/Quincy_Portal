import { describe, expect, it } from "vitest";
import guide from "../../../../docs/Guides/MCP.md?raw";
import { MCP_TOOLS, toolsFor } from "../src/mcp/tools/registry";

/**
 * docs/Guides/MCP.md states how many tools each role sees with every scope granted, and the total. Those numbers drift whenever a
 * tool lands, so they are checked against the registry here (review fix S1, spec #959).
 */
const ROLES = { Admin: "admin", Photographer: "photographer", Editor: "editor", "External editor": "external_editor" } as const;
type Counts = { roles: Record<string, number>; total: number };

/** The role table's rows (`| Role | N |`) and the "**N tools** in total" line, as written in the guide. */
function guideCounts(text: string): Counts {
  const roles: Record<string, number> = {};
  for (const label of Object.keys(ROLES)) {
    const row = new RegExp(`^\\| ${label} \\| (\\d+) \\|$`, "m").exec(text);
    expect(row, `the guide's role table has a row for ${label}`).not.toBeNull();
    roles[label] = Number(row![1]);
  }
  const total = /\*\*(\d+) tools\*\* in total/.exec(text);
  expect(total, "the guide states the total").not.toBeNull();
  return { roles, total: Number(total![1]) };
}

const registryCounts = (): Counts => ({
  roles: Object.fromEntries(Object.entries(ROLES).map(([label, role]) => [label, toolsFor(role, ["read", "write", "admin"]).length])),
  total: MCP_TOOLS.length,
});

describe("docs/Guides/MCP.md tool counts match the registry", () => {
  it("each role's count and the total equal toolsFor(role, every scope) and MCP_TOOLS", () => {
    expect(guideCounts(guide)).toEqual(registryCounts());
  });

  it("a wrong number in the guide is caught", () => {
    const bump = (text: string, pattern: RegExp) => text.replace(pattern, (_, before: string, n: string, after: string) => `${before}${Number(n) + 1}${after}`);
    expect(guideCounts(bump(guide, /^(\| Editor \| )(\d+)( \|)$/m))).not.toEqual(registryCounts());
    expect(guideCounts(bump(guide, /(\*\*)(\d+)( tools\*\* in total)/))).not.toEqual(registryCounts());
  });
});
