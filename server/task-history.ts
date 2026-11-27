import { withReworkStatus } from "../shared/rework-status.ts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, transaction } from "./db.ts";
import { AppError, type Task } from "./types.ts";

type HistoryRecord = Record<string, any>;
const changedFields: Record<string, string> = {
  customerName: "客户昵称",
  memberName: "会员名",
  email: "邮箱",
  wechat: "微信 / 联系方式",
  kind: "任务类型",
  softwareName: "制作名称",
  intakeName: "录入名称",
  originalName: "原软件名称",
  notes: "备注",
  purchasedAt: "购买日期",
  amount: "金额",
  needsSubmission: "需要代提交",
  completed: "完成状态",
  completionMethod: "交付方式",
  parentId: "关联上一阶段",
  customerId: "客户归属",
  archived: "归档状态",
  cancelledAt: "补正撤销时间",
  imageIds: "来源截图",
};
const decode = (value: any) =>
  typeof value === "string" ? JSON.parse(value) : value;
function comparable(value: any) {
  return JSON.stringify(value ?? null);
}
export function historyChanges(audit: HistoryRecord) {
  const before = decode(audit.before_data) || {},
    after = decode(audit.after_data) || {};
  return Object.entries(changedFields)
    .filter(([key]) => comparable(before[key]) !== comparable(after[key]))
    .map(([key, label]) => ({
      key,
      label,
      before: before[key] ?? null,
      after: after[key] ?? null,
    }));
}
const chronology = (a: HistoryRecord, b: HistoryRecord) =>
  String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
  String(a.id).localeCompare(String(b.id));

/** The whole connected project, including archived stages and repeated rework. */
export function projectTaskIds(
  taskId: string,
  tasks: HistoryRecord[],
): string[] {
  const selected = tasks.find((t) => t.id === taskId);
  if (!selected) throw new AppError(404, "任务不存在");
  const ids = new Set<string>([taskId]);
  if (selected.projectId)
    for (const t of tasks)
      if (t.projectId === selected.projectId) ids.add(t.id);
  for (let added = true; added;) {
    added = false;
    for (const t of tasks) {
      if (t.parentId && (ids.has(t.id) || ids.has(t.parentId))) {
        for (const id of [t.id, t.parentId]) {
          if (!ids.has(id) && tasks.some((candidate) => candidate.id === id)) {
            ids.add(id);
            added = true;
          }
        }
      }
    }
  }
  return [...ids];
}

export function buildTaskHistory(
  taskId: string,
  tasks: HistoryRecord[],
  deliveries: HistoryRecord[],
  audits: HistoryRecord[],
  mailMessages: HistoryRecord[] = [],
) {
  const ids = new Set(projectTaskIds(taskId, tasks));
  const members = withReworkStatus(tasks)
    .filter((t) => ids.has(t.id))
    .sort(chronology);
  const ordered: { task: HistoryRecord; depth: number }[] = [];
  const visited = new Set<string>();
  const walk = (task: HistoryRecord, depth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    ordered.push({ task, depth });
    for (const child of members.filter((t) => t.parentId === task.id))
      walk(child, depth + 1);
  };
  for (const root of members.filter((t) => !ids.has(t.parentId))) walk(root, 0);
  // Tolerate old malformed cyclic records without hiding them or looping.
  for (const remaining of members) walk(remaining, 0);
  const relevantDeliveries = deliveries.filter((d) => ids.has(d.taskId));
  const relevantMail = mailMessages.filter((m) =>
    (m.taskIds || []).some((id: string) => ids.has(id)),
  );
  let correction = 0;
  const stages = ordered.map(({ task, depth }, index) => ({
    task,
    depth,
    sequence: index + 1,
    label: task.kind === "new" ? "新单" : `第 ${++correction} 次补正 / 返工`,
    parentName:
      members.find((t) => t.id === task.parentId)?.softwareName || null,
    deliveries: relevantDeliveries
      .filter((d) => d.taskId === task.id)
      .sort((a, b) =>
        String(b.sentAt || b.createdAt).localeCompare(
          String(a.sentAt || a.createdAt),
        ),
      ),
    audits: audits
      .filter((a) => a.record_id === task.id)
      .sort(
        (a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)) ||
          Number(b.id) - Number(a.id),
      )
      .map((a) => ({ ...a, changes: historyChanges(a) })),
    mailMessages: relevantMail
      .filter((m) => m.taskIds.includes(task.id))
      .sort((a, b) =>
        String(b.date || b.createdAt).localeCompare(
          String(a.date || a.createdAt),
        ),
      ),
  }));
  return {
    taskId,
    projectId: members.find((t) => t.id === taskId)?.projectId || null,
    stages,
    summary: {
      stages: stages.length,
      completed: members.filter((t) => t.completed).length,
      archived: members.filter((t) => t.archived).length,
      deliveries: relevantDeliveries.length,
      successfulDeliveries: relevantDeliveries.filter((d) =>
        ["sent", "external"].includes(d.status),
      ).length,
      changes: stages.reduce((count, stage) => count + stage.audits.length, 0),
      mailMessages: relevantMail.length,
    },
  };
}

export async function getTaskHistory(taskId: string) {
  return transaction(async (c) => {
    const tasks = await all<Task>("task", c);
    const ids = projectTaskIds(taskId, tasks);
    const placeholders = ids.map(() => "?").join(",");
    // Preserve delivery bodies only for this project; mailbox history needs
    // summaries, so unrelated messages and their full bodies stay in MySQL.
    const mailFields = [
      "taskIds",
      "folder",
      "from",
      "to",
      "subject",
      "snippet",
      "date",
      "createdAt",
      "remoteMissing",
    ];
    const [[deliveryRows], [mailRows], [audits]] = await Promise.all([
      c.query<any[]>(
        `SELECT id,payload,revision FROM records WHERE kind='delivery' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.taskId')) IN (${placeholders}) AND JSON_EXTRACT(payload,'$.deletedAt') IS NULL`,
        ids,
      ),
      c.query<any[]>(
        `SELECT id,revision,JSON_OBJECT(${mailFields.map((field) => `'${field}',JSON_EXTRACT(payload,'$.${field}')`).join(",")}) AS payload FROM records WHERE kind='mailmessage' AND JSON_EXTRACT(payload,'$.duplicateOf') IS NULL AND (${ids.map(() => "JSON_CONTAINS(JSON_EXTRACT(payload,'$.taskIds'),JSON_QUOTE(?))").join(" OR ")})`,
        ids,
      ),
      c.query<any[]>(
        `SELECT id,record_id,action,before_data,after_data,created_at FROM audit_log WHERE kind=? AND record_id IN (${placeholders}) ORDER BY id DESC`,
        ["task", ...ids],
      ),
    ]);
    const records = (rows: any[]) =>
      rows.map((row) => ({
        ...decode(row.payload),
        id: row.id,
        revision: row.revision,
      }));
    return buildTaskHistory(
      taskId,
      tasks,
      records(deliveryRows),
      audits.map((a) => ({
        ...a,
        created_at:
          a.created_at instanceof Date
            ? a.created_at.toISOString()
            : a.created_at,
      })),
      records(mailRows),
    );
  });
}

export function registerTaskHistoryRoutes(app: FastifyInstance) {
  app.get("/api/v1/tasks/:id/history", async (req) =>
    getTaskHistory(
      z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
    ),
  );
}
