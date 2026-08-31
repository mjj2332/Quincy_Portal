import { stageTransportKeyForRole, type ProjectDeadlineSchedule, type Role, type StageTransportKey } from "@quincy/shared";
import type { ProjectDetail } from "./project-data";

export type OverviewPresentation = {
  address: Pick<ProjectDetail, "street" | "suburb" | "postcode">;
  summary: Pick<ProjectDetail, "shootDate" | "timeWindow" | "agencyName" | "agentName" | "productionNotes"> & {
    collections: ProjectDetail["collections"];
  };
  stageKey: StageTransportKey;
  priority?: number;
  team: ProjectDetail["members"];
  deadline: Pick<ProjectDeadlineSchedule, "deadline" | "state" | "nextOccurrence" | "reminderOffsetsMinutes" | "skippedReminderOffsetsMinutes">;
};

function rolePresentedStageKey(stageKey: ProjectDetail["stageKey"], role: Role): StageTransportKey {
  // Non-admin detail responses already contain the neutral `editing` key. Keep it
  // neutral here, while still applying the shared transport helper to canonical keys.
  return stageKey === "editing" ? stageKey : stageTransportKeyForRole(stageKey, role);
}

export function overviewPresentation(detail: ProjectDetail, role: Role): OverviewPresentation {
  const presentation: OverviewPresentation = {
    address: { street: detail.street, suburb: detail.suburb, postcode: detail.postcode },
    summary: {
      shootDate: detail.shootDate,
      timeWindow: detail.timeWindow ?? null,
      agencyName: detail.agencyName,
      agentName: detail.agentName,
      productionNotes: detail.productionNotes ?? null,
      collections: detail.collections,
    },
    stageKey: rolePresentedStageKey(detail.stageKey, role),
    team: detail.members,
    deadline: {
      deadline: detail.deadlineSchedule.deadline,
      state: detail.deadlineSchedule.state,
      nextOccurrence: detail.deadlineSchedule.nextOccurrence,
      reminderOffsetsMinutes: detail.deadlineSchedule.reminderOffsetsMinutes,
      skippedReminderOffsetsMinutes: detail.deadlineSchedule.skippedReminderOffsetsMinutes,
    },
  };

  if (role !== "external_editor" && detail.priority !== null && detail.priority !== undefined) {
    presentation.priority = detail.priority;
  }
  return presentation;
}
