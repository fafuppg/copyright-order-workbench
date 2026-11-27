export function withReworkStatus<T extends Record<string, any>>(tasks: T[]) {
  const parents = new Set(
    tasks.filter((t) => t.parentId && !t.cancelledAt).map((t) => t.parentId),
  );
  return tasks.map((t) => ({ ...t, inRework: parents.has(t.id) }));
}
