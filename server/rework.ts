import type { PoolConnection } from "mysql2/promise";
import { get, save, transaction } from "./db.ts";
import { AppError, type Task } from "./types.ts";

export { withReworkStatus } from "../shared/rework-status.ts";
export async function assertOperable(task: Task, c: PoolConnection) {
  if (task.cancelledAt)
    throw new AppError(409, "补正已撤销，请在原任务继续操作");
  const [rows] = await c.query<any[]>(
    `SELECT id FROM records WHERE kind='task' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.parentId'))=? AND JSON_EXTRACT(payload,'$.cancelledAt') IS NULL FOR UPDATE`,
    [task.id],
  );
  if (rows.length)
    throw new AppError(409, "此任务已进入返工，请在补正任务操作");
}
export async function assertCanRework(task: Task, c: PoolConnection) {
  await assertOperable(task, c);
  const [pending] = await c.query<any[]>(
    `SELECT id FROM records WHERE kind='delivery' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.taskId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status')) IN ('queued','sending','uncertain') AND JSON_EXTRACT(payload,'$.deletedAt') IS NULL FOR UPDATE`,
    [task.id],
  );
  if (pending.length)
    throw new AppError(409, "请先确认原任务的邮件发送结果，再返工");
}
export async function cancelCorrection(id: string, revision: number) {
  return transaction(async (c) => {
    const task = await get<Task>("task", id, c, true);
    if (!task) throw new AppError(404, "任务不存在");
    if (task.kind !== "correction" || !task.parentId)
      throw new AppError(400, "独立补正不能恢复原单");
    await assertCanRework(task, c);
    const parent = await get<Task>("task", task.parentId, c, true);
    if (!parent) throw new AppError(409, "原任务不存在");
    const result = await save(
      "task",
      { ...task, cancelledAt: new Date().toISOString(), archived: true },
      revision,
      c,
      "撤销补正并恢复原任务",
    );
    await save(
      "task",
      { ...parent, archived: false },
      parent.revision,
      c,
      "恢复原任务（保留原交付状态）",
    );
    return result;
  });
}
