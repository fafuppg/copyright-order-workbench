/** Group for presentation only. Names alone never establish customer identity. */
export function groupTasks<T extends Record<string, any>>(tasks: T[]) {
  const groups = new Map<
    string,
    { key: string; date: string; completed: boolean; tasks: T[] }
  >();
  for (const task of tasks) {
    const date = task.purchasedAt || "";
    const identity = task.customerId
      ? `customer:${task.customerId}`
      : task.orderId
        ? `order:${task.orderId}`
        : `task:${task.id}`;
    const key = JSON.stringify([!!task.completed, date, identity]);
    const group = groups.get(key) || {
      key,
      date,
      completed: !!task.completed,
      tasks: [] as T[],
    };
    group.tasks.push(task);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.tasks.sort(
      (a, b) =>
        String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
        String(a.id).localeCompare(String(b.id)),
    );
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.completed) - Number(b.completed) ||
      (a.date || "9999").localeCompare(b.date || "9999") ||
      String(a.tasks[0].createdAt || "").localeCompare(
        String(b.tasks[0].createdAt || ""),
      ) ||
      a.key.localeCompare(b.key),
  );
}

/** Keep complete customer groups while budgeting rows, rather than group count. */
export function paginateTaskGroups<T extends { tasks: unknown[] }>(
  groups: T[],
  rowLimit: number,
): T[][] {
  const pages: T[][] = [];
  let page: T[] = [],
    rows = 0;
  for (const group of groups) {
    if (page.length && rows + group.tasks.length > rowLimit) {
      pages.push(page);
      page = [];
      rows = 0;
    }
    page.push(group);
    rows += group.tasks.length;
  }
  if (page.length) pages.push(page);
  return pages;
}
