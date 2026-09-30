import { describe, expect, it } from "vitest";
import {
  adminProductionGanttResponseSchema,
  editorProductionGanttResponseSchema,
  decodeGanttChildCursor,
  decodeGanttProjectCursor,
  encodeGanttChildCursor,
  encodeGanttProjectCursor,
  ganttChildCursorSchema,
  ganttProjectCursorSchema,
  ganttTeamMemberSchema,
  externalParticipantSchema,
  externalProductionGanttSchema,
  productionGanttChildPageSchema,
  PRODUCTION_GANTT_DRAW_CAP,
  PRODUCTION_GANTT_ZONE,
  type GanttChildCursor,
  type GanttProjectCursor,
  type ProductionGanttResponse,
} from "../src";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodedJson(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

describe("Gantt project cursor", () => {
  it("round-trips the canonical unpadded base64url cursor", () => {
    const cursor: GanttProjectCursor = { startDate: "2026-08-27", id };
    const encoded = encodeGanttProjectCursor(cursor);
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(decodeGanttProjectCursor(encoded)).toEqual(cursor);
    expect(encoded).toBe(encodedJson(`{"startDate":"2026-08-27","id":"${id}"}`));
    expect(ganttProjectCursorSchema.safeParse(cursor).success).toBe(true);
  });

  it("rejects wrong key order", () => {
    expect(decodeGanttProjectCursor(encodedJson(`{"id":"${id}","startDate":"2026-08-27"}`))).toBeNull();
  });

  it("rejects a padded base64 value", () => {
    const withPadding = `${encodeGanttProjectCursor({ startDate: "2026-08-27", id })}=`;
    expect(decodeGanttProjectCursor(withPadding)).toBeNull();
  });

  it("rejects an oversize payload", () => {
    expect(decodeGanttProjectCursor(base64Url(new Uint8Array(257).fill(97)))).toBeNull();
    expect(decodeGanttProjectCursor(base64Url(new Uint8Array(513).fill(97)))).toBeNull();
  });

  it("rejects a non-lowercase UUID", () => {
    expect(decodeGanttProjectCursor(encodedJson('{"startDate":"2026-08-27","id":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}'))).toBeNull();
  });

  it("rejects a non-canonical calendar date", () => {
    expect(decodeGanttProjectCursor(encodedJson(`{"startDate":"2026-13-40","id":"${id}"}`))).toBeNull();
    expect(() => encodeGanttProjectCursor({ startDate: "2026-13-40", id })).toThrow();
  });

  it("rejects an extra key", () => {
    expect(decodeGanttProjectCursor(encodedJson(`{"startDate":"2026-08-27","id":"${id}","extra":1}`))).toBeNull();
  });
});

describe("Gantt child cursor", () => {
  it("round-trips the canonical unpadded base64url cursor", () => {
    const cursor: GanttChildCursor = { projectId: id, position: 3, id, completed: true };
    const encoded = encodeGanttChildCursor(cursor);
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(decodeGanttChildCursor(encoded)).toEqual(cursor);
    expect(encoded).toBe(encodedJson(`{"projectId":"${id}","position":3,"id":"${id}","completed":true}`));
    expect(ganttChildCursorSchema.safeParse(cursor).success).toBe(true);
  });

  it("carries the completed visibility mode distinctly from position/id", () => {
    const incomplete = encodeGanttChildCursor({ projectId: id, position: 3, id, completed: false });
    const complete = encodeGanttChildCursor({ projectId: id, position: 3, id, completed: true });
    expect(incomplete).not.toBe(complete);
    expect(decodeGanttChildCursor(incomplete)).toEqual({ projectId: id, position: 3, id, completed: false });
    expect(decodeGanttChildCursor(complete)).toEqual({ projectId: id, position: 3, id, completed: true });
  });

  it("rejects wrong key order", () => {
    expect(decodeGanttChildCursor(encodedJson(`{"id":"${id}","projectId":"${id}","position":3,"completed":false}`))).toBeNull();
    expect(decodeGanttChildCursor(encodedJson(`{"projectId":"${id}","position":3,"completed":false,"id":"${id}"}`))).toBeNull();
  });

  it("rejects a padded base64 value", () => {
    const withPadding = `${encodeGanttChildCursor({ projectId: id, position: 0, id, completed: false })}=`;
    expect(decodeGanttChildCursor(withPadding)).toBeNull();
  });

  it("rejects an oversize payload", () => {
    expect(decodeGanttChildCursor(base64Url(new Uint8Array(257).fill(97)))).toBeNull();
  });

  it("rejects a non-lowercase UUID on either id field", () => {
    expect(decodeGanttChildCursor(encodedJson(`{"projectId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","position":0,"id":"${id}","completed":false}`))).toBeNull();
    expect(decodeGanttChildCursor(encodedJson(`{"projectId":"${id}","position":0,"id":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","completed":false}`))).toBeNull();
  });

  it("rejects a non-integer position", () => {
    expect(decodeGanttChildCursor(encodedJson(`{"projectId":"${id}","position":1.5,"id":"${id}","completed":false}`))).toBeNull();
    expect(() => encodeGanttChildCursor({ projectId: id, position: 1.5, id, completed: false })).toThrow();
  });

  it("rejects a missing or non-boolean completed field", () => {
    expect(decodeGanttChildCursor(encodedJson(`{"projectId":"${id}","position":0,"id":"${id}"}`))).toBeNull();
    expect(decodeGanttChildCursor(encodedJson(`{"projectId":"${id}","position":0,"id":"${id}","completed":1}`))).toBeNull();
  });

  it("rejects an extra key", () => {
    expect(decodeGanttChildCursor(encodedJson(`{"projectId":"${id}","position":0,"id":"${id}","completed":false,"extra":1}`))).toBeNull();
  });
});

function baseRow() {
  return {
    id,
    street: "1 Gantt Street",
    suburb: "Suburb",
    agencyName: null,
    agentName: null,
    stageKey: "awaiting_raw" as const,
    delivered: false,
    shootDate: "2026-08-27",
    shootDateCivil: "2026-08-27",
    createdAt: "2026-08-01T00:00:00.000Z",
    barStartDate: "2026-08-27",
    deadline: null,
    deadlineVersion: 0,
    editors: [],
    checklist: { completed: 0, total: 0 },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
  };
}

function baseResponse(): ProductionGanttResponse {
  return {
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: [baseRow()],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: 1, drawCap: PRODUCTION_GANTT_DRAW_CAP, tooManyToDraw: false },
  };
}

describe("response schema", () => {
  it("parses a well-formed admin response", () => {
    expect(() => adminProductionGanttResponseSchema.parse(baseResponse())).not.toThrow();
  });

  // #274: the Editor field's options, opt-in (`facets=1`) so an old bundle's strict decoder never sees the key.
  it("parses a response with and without filterFacets.people, and rejects an unknown key inside it", () => {
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "Alice Editor", roleLabel: "Editor", isExternal: false, active: true };
    expect(() => adminProductionGanttResponseSchema.parse(baseResponse())).not.toThrow();
    expect(() => adminProductionGanttResponseSchema.parse({ ...baseResponse(), filterFacets: { people: [person] } })).not.toThrow();
    expect(() => editorProductionGanttResponseSchema.parse({ ...baseResponse(), filterFacets: { people: [] } })).not.toThrow();
    expect(() => adminProductionGanttResponseSchema.parse({ ...baseResponse(), filterFacets: { people: [person], extra: 1 } })).toThrow();
    expect(() => adminProductionGanttResponseSchema.parse({ ...baseResponse(), filterFacets: null })).toThrow();
  });

  it("rejects an unknown top-level field (.strict())", () => {
    expect(() => adminProductionGanttResponseSchema.parse({ ...baseResponse(), extra: true })).toThrow();
  });

  // #372: a Subtask row carries its assignee list, a hidden count, the version and the edit permission.
  describe("Subtask assignees (#372)", () => {
    const person = { id: "11111111-1111-4111-8111-111111111111", name: "Alice Editor", roleLabel: "Editor", isExternal: false, active: true };
    const schedule = { state: "range" as const, version: 1, zone: PRODUCTION_GANTT_ZONE, start: { kind: "date" as const, localCivil: "2026-08-27", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, end: { kind: "date" as const, localCivil: "2026-08-27", instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const }, due: "2026-08-27" };
    const row = () => ({ id, projectId: id, title: "Task", done: false, position: 0, assignee: person, assignees: [person], otherAssigneeCount: 2, assignmentVersion: 3, schedule, permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true } });
    const withRow = (value: unknown) => ({ ...baseResponse(), projects: [{ ...baseRow(), children: { rows: [value], total: 1, returned: 1, truncated: false, nextCursor: null } }] });

    it("parses a row with several assignees, a hidden count and canEditAssignees", () => {
      const parsed = adminProductionGanttResponseSchema.parse(withRow(row()));
      expect(parsed.projects[0]!.children.rows[0]).toMatchObject({ assignees: [person], otherAssigneeCount: 2, assignmentVersion: 3, permissions: { canEditAssignees: true } });
    });

    it("rejects a row missing any of the new fields, or with a bad count or version", () => {
      for (const key of ["assignees", "otherAssigneeCount", "assignmentVersion"] as const) {
        const { [key]: _omitted, ...rest } = row();
        expect(() => adminProductionGanttResponseSchema.parse(withRow(rest)), key).toThrow();
      }
      expect(() => adminProductionGanttResponseSchema.parse(withRow({ ...row(), otherAssigneeCount: -1 }))).toThrow();
      expect(() => adminProductionGanttResponseSchema.parse(withRow({ ...row(), assignmentVersion: 1.5 }))).toThrow();
      expect(() => adminProductionGanttResponseSchema.parse(withRow({ ...row(), permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true } }))).toThrow();
    });

    it("parses the child-page and external shapes with the same row", () => {
      expect(() => productionGanttChildPageSchema.parse({ projectId: id, children: { rows: [row()], total: 1, returned: 1, truncated: false, nextCursor: null } })).not.toThrow();
      expect(() => externalProductionGanttSchema.parse(withRow(row()))).not.toThrow();
    });
  });

  it("rejects an unknown field on a project row (.strict())", () => {
    const response = baseResponse();
    response.projects[0] = { ...response.projects[0], extra: true } as never;
    expect(() => adminProductionGanttResponseSchema.parse(response)).toThrow();
  });

  it("rejects an unknown field on the children block (.strict())", () => {
    const response = baseResponse();
    response.projects[0] = { ...response.projects[0], children: { ...response.projects[0].children, extra: true } } as never;
    expect(() => adminProductionGanttResponseSchema.parse(response)).toThrow();
  });

  it("still requires deadlineVersion when deadline is null", () => {
    const response = baseResponse();
    const { deadlineVersion: _drop, ...withoutVersion } = response.projects[0];
    response.projects[0] = withoutVersion as never;
    expect(() => adminProductionGanttResponseSchema.parse(response)).toThrow();
  });
});

// #365: the row's Project team (display-only) and its edit permission, both opt-in (`team=1`).
describe("response schema: Project team (#365)", () => {
  const member = { id: "11111111-1111-4111-8111-111111111111", name: "Alice Editor", roleLabel: "Editor", isExternal: false, active: true, roleOnProject: "editor" as const };
  function withTeam(team: unknown, canEditTeam: unknown): ProductionGanttResponse {
    const response = baseResponse();
    response.projects[0] = { ...response.projects[0], team, permissions: { canEditDeadline: true, canEditChildren: true, canEditTeam } } as never;
    return response;
  }
  const schemas = [
    ["admin", adminProductionGanttResponseSchema],
    ["editor", editorProductionGanttResponseSchema],
    ["external", externalProductionGanttSchema],
  ] as const;

  for (const [name, schema] of schemas) {
    it(`S1 parses a row with team + canEditTeam (${name})`, () => {
      expect(() => schema.parse(withTeam([member], true))).not.toThrow();
      expect(() => schema.parse(withTeam([], false))).not.toThrow();
    });
    it(`S2 still parses a legacy row with neither key (${name})`, () => {
      expect(() => schema.parse(baseResponse())).not.toThrow();
    });
    it(`S3 requires team and canEditTeam together (${name})`, () => {
      const teamOnly = baseResponse();
      teamOnly.projects[0] = { ...teamOnly.projects[0], team: [member] } as never;
      expect(() => schema.parse(teamOnly)).toThrow();
      const permOnly = baseResponse();
      permOnly.projects[0] = { ...permOnly.projects[0], permissions: { canEditDeadline: true, canEditChildren: true, canEditTeam: true } } as never;
      expect(() => schema.parse(permOnly)).toThrow();
    });
    it(`S4 rejects picker-only fields on a team entry (${name})`, () => {
      for (const extra of [{ email: "a@b.co" }, { membershipCycleId: id }, { globalRole: "editor" }, { assignedSubtaskCount: 1 }]) {
        expect(() => schema.parse(withTeam([{ ...member, ...extra }], true))).toThrow();
      }
    });
  }

  it("S5 contract fence: the team entry is the external participant minus email and membershipCycleId", () => {
    const expected = Object.keys(externalParticipantSchema.shape).filter((key) => key !== "email" && key !== "membershipCycleId").sort();
    expect(Object.keys(ganttTeamMemberSchema.shape).sort()).toEqual(expected);
  });
});
