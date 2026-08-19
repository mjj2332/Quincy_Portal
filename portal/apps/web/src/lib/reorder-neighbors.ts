export function reorderNeighbors(ids: string[], activeId: string, overId: string | null) {
  if (!overId || overId === activeId) return null;
  const activeIndex = ids.indexOf(activeId); const overIndex = ids.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0) return null;
  const desired = [...ids]; desired.splice(activeIndex, 1); desired.splice(overIndex, 0, activeId);
  const destinationIndex = desired.indexOf(activeId);
  return { beforeId: desired[destinationIndex - 1] ?? null, afterId: desired[destinationIndex + 1] ?? null, destinationIndex };
}
