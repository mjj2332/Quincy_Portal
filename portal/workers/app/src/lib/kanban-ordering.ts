import { computeInsertPosition } from "@quincy/db";

export type BoardRow = { id: string; stageKey: string; priority: number | null; boardPosition: number };

export function orderedBoardRows(rows: BoardRow[]): BoardRow[] {
  return [...rows].sort((left, right) => left.boardPosition - right.boardPosition || left.id.localeCompare(right.id));
}

export function needsPositionRenumber(position: number, before: number | null, after: number | null) {
  return (before !== null && position === before) || (after !== null && position === after);
}

export function priorityInsertNeighbors(rows: BoardRow[], targetId: string, priority: number | null) {
  const siblings = orderedBoardRows(rows.filter((row) => row.id !== targetId));
  if (priority === null) {
    const before = siblings.at(-1);
    return { beforeId: before?.id ?? null, afterId: null, before: before?.boardPosition ?? null, after: null };
  }
  let anchor = -1;
  for (let index = 0; index < siblings.length; index += 1) {
    const siblingPriority = siblings[index]!.priority;
    if (siblingPriority !== null && siblingPriority >= priority) anchor = index;
  }
  if (anchor < 0) {
    const first = siblings[0];
    return { beforeId: null, afterId: first?.id ?? null, before: null, after: first?.boardPosition ?? null };
  }
  const before = siblings[anchor]!;
  const after = siblings[anchor + 1];
  return { beforeId: before.id, afterId: after?.id ?? null, before: before.boardPosition, after: after?.boardPosition ?? null };
}

export function manualInsertNeighbors(rows: BoardRow[], targetId: string, direction: "up" | "down") {
  const column = orderedBoardRows(rows);
  const index = column.findIndex((row) => row.id === targetId);
  const neighborIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || neighborIndex < 0 || neighborIndex >= column.length) return null;
  const before = direction === "up" ? column[index - 2] : column[index + 1];
  const after = direction === "up" ? column[index - 1] : column[index + 2];
  return { beforeId: before?.id ?? null, afterId: after?.id ?? null, before: before?.boardPosition ?? null, after: after?.boardPosition ?? null };
}

export function renumberedInsertPosition(rows: BoardRow[], beforeId: string | null, afterId: string | null) {
  const renumbered = new Map(orderedBoardRows(rows).map((row, index) => [row.id, (index + 1) * 1024]));
  return {
    renumbered,
    position: computeInsertPosition(beforeId ? renumbered.get(beforeId) ?? null : null, afterId ? renumbered.get(afterId) ?? null : null),
  };
}
