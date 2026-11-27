import { assertOperable, assertCanRework } from "./rework.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolConnection } from "mysql2/promise";
import { all, get, save, transaction } from "./db.ts";
import {
  candidateMatches,
  defaults,
  taskFields,
  validateTask,
  validateNewTask,
  lockTemplateCollection,
} from "./business.ts";
import { cleanHtml, fillTemplate } from "./security.ts";
import { AppError, type Doc, type RecordKind, type Task } from "./types.ts";
import { withNewPurchaseDate } from "../shared/date.ts";

const uuid = z.string().uuid();
const text = z.string().max(5000);
const imageIds = z.array(uuid).max(20).default([]);
const taskInput = taskFields.partial().extend({
  parentId: uuid.nullable().optional(),
  sources: z.array(z.any()).max(100).optional(),
  purchaseDateDefaulted: z.boolean().optional(),
});
const customerFields = z.object({
  name: z.string().max(200),
  memberName: z.string().max(200),
  email: z.string().max(320),
  wechat: z.string().max(200),
  notes: text,
});
const templateFields = z.object({
  id: uuid.optional(),
  revision: z.number().int().optional(),
  name: z.string().min(1).max(120),
  kind: z.enum(["new", "correction", "all"]),
  isDefault: z.boolean(),
  subject: z.string().min(1).max(240),
  html: z.string().max(200000),
});
export const actionTypes = [
  "create_tasks",
  "update_task",
  "link_task",
  "external_delivery",
  "reopen_task",
  "archive_tasks",
  "update_customer",
  "save_template",
  "delete_template",
  "prepare_mail",
] as const;
export type ActionType = (typeof actionTypes)[number];
export type Snapshot = { kind: RecordKind; id: string; revision: number };
export type Seen = Map<string, Snapshot>;
const labels: Record<string, string> = {
  customerName: "客户昵称",
  memberName: "会员名",
  email: "邮箱",
  wechat: "微信 / 联系方式",
  kind: "任务类型",
  softwareName: "制作名称",
  intakeName: "录入名称",
  filingAccount: "填报账号",
  filingPassword: "填报密码",
  originalName: "原软件名称",
  notes: "备注",
  purchasedAt: "购买日期",
  amount: "成交金额",
  needsSubmission: "需要代提交",
  name: "名称",
  subject: "邮件主题",
  html: "邮件正文",
  to: "收件邮箱",
  isDefault: "默认模板",
  archived: "归档",
  completed: "完成状态",
};
const friendly = (v: any) =>
  typeof v === "boolean"
    ? v
      ? "是"
      : "否"
    : v === "new"
      ? "新单"
      : v === "correction"
        ? "补正"
        : (v ?? "");
const changePreview = (before: any, after: any) =>
  Object.keys(after)
    .filter((k) => labels[k] && after[k] !== before?.[k])
    .map((k) => ({
      label: labels[k],
      before:
        k === "filingPassword"
          ? before?.[k]
            ? "已保存（隐藏）"
            : "未填写"
          : friendly(before?.[k]),
      after:
        k === "filingPassword"
          ? after[k]
            ? "已保存（隐藏）"
            : "已清空"
          : friendly(after[k]),
    }));

export async function normalizeAction(
  typeInput: string,
  raw: any,
  options: { seen?: Seen; previous?: Doc; imageIds?: string[] } = {},
) {
  const type = z.enum(actionTypes).parse(typeInput);
  const snapshots: Snapshot[] = [];
  const key = (kind: string, id: string) => kind + ":" + id;
  async function record(kind: RecordKind, id: string, observed = true) {
    const d = await get(kind, uuid.parse(id));
    if (!d) throw new AppError(404, "目标记录不存在，请重新查找");
    const previous = options.previous?.snapshots?.find(
      (s: Snapshot) => s.kind === kind && s.id === id,
    );
    const seen = options.seen?.get(key(kind, id));
    // Revisions always come from server records or an earlier server snapshot,
    // never from a model-provided number. Explicit IDs are also valid targets.
    snapshots.push({
      kind,
      id,
      revision: previous?.revision ?? seen?.revision ?? d.revision,
    });
    return d;
  }
  let payload: any,
    preview: any[] = [],
    title = "",
    candidates: any[] = [];
  const guards: Record<string, string[]> = {};
  if (type === "create_tasks") {
    payload = z
      .object({
        customerId: uuid.optional(),
        intakeId: uuid.optional(),
        imageIds,
        items: z.array(taskInput).min(1).max(30),
      })
      .parse(raw);
    // A model cannot attach screenshots that did not occur in this conversation.
    if (options.imageIds)
      payload.imageIds = [
        ...new Set([
          ...(payload.imageIds || []),
          ...(options.previous?.payload.imageIds || []),
          ...options.imageIds,
        ]),
      ];
    payload.items = payload.items.map((i: any) =>
      withNewPurchaseDate({
        ...defaults,
        ...i,
        intakeName: i.intakeName || i.softwareName || "",
      }),
    );
    if (payload.customerId) await record("customer", payload.customerId);
    if (payload.intakeId) await record("intake", payload.intakeId);
    for (const item of payload.items)
      if (item.parentId) {
        const parent = await record("task", item.parentId);
        if (item.kind !== "correction")
          throw new AppError(400, "只有补正任务可以关联原单");
        if (payload.customerId && parent.customerId !== payload.customerId)
          throw new AppError(400, "原单和客户不一致");
        payload.customerId = parent.customerId;
        await record("customer", parent.customerId, false);
      }
    title = `录入 ${payload.items.length} 项任务`;
    preview = payload.items.flatMap((item: any, index: number) => [
      { label: `软件 ${index + 1}`, after: item.softwareName || "名称待定" },
      {
        label: "客户 / 邮箱",
        after: [item.customerName, item.email].filter(Boolean).join(" · "),
      },
      {
        label: item.purchaseDateDefaulted
          ? "购买日期（默认今天，非截图事实，可修改）"
          : "购买日期",
        after: item.purchasedAt,
      },
    ]);
    candidates = candidateMatches(await all<Task>("task"), payload.items[0]);
  } else if (type === "archive_tasks") {
    payload = z
      .object({
        targets: z
          .array(
            z.object({ taskId: uuid, revision: z.number().int().optional() }),
          )
          .min(1)
          .max(100),
        archived: z.boolean(),
      })
      .parse(raw);
    if (
      new Set(payload.targets.map((t: any) => t.taskId)).size !==
      payload.targets.length
    )
      throw new AppError(400, "批量任务重复");
    for (const target of payload.targets) {
      const t = await record("task", target.taskId);
      target.revision = snapshots.at(-1)!.revision;
      preview.push({
        label: [t.customerName, t.softwareName || "名称待定"]
          .filter(Boolean)
          .join(" · "),
        before: t.archived ? "已归档" : "未归档",
        after: payload.archived ? "归档" : "恢复到工作台",
      });
    }
    title = `${payload.archived ? "归档" : "恢复"} ${payload.targets.length} 项任务`;
  } else if (type === "update_customer") {
    payload = z
      .object({
        customerId: uuid,
        fields: customerFields.partial(),
        revision: z.number().int().optional(),
      })
      .parse(raw);
    const before = await record("customer", payload.customerId);
    payload.revision = snapshots.at(-1)!.revision;
    payload.fields = customerFields.parse({ ...before, ...payload.fields });
    preview = changePreview(before, payload.fields);
    title = `修改客户 ${before.name}`;
  } else if (type === "save_template") {
    payload = templateFields.parse(raw);
    let before: any = {};
    if (payload.id) {
      before = await record("template", payload.id);
      payload.revision = snapshots.at(-1)!.revision;
    } else delete payload.revision;
    payload.html = cleanHtml(payload.html);
    fillTemplate(payload.subject, {});
    fillTemplate(payload.html, {}, true);
    preview = changePreview(before, payload);
    title = payload.id ? `修改模板 ${before.name}` : `新建模板 ${payload.name}`;
    if (payload.isDefault) {
      const defaults = (await all("template")).filter(
        (t) => t.kind === payload.kind && t.id !== payload.id && t.isDefault,
      );
      const sameSelection =
        options.previous?.payload.id === payload.id &&
        options.previous?.payload.kind === payload.kind &&
        options.previous?.payload.isDefault;
      guards.defaultTemplateIds =
        (sameSelection && options.previous?.guards?.defaultTemplateIds) ||
        defaults.map((t) => t.id).sort();
      for (const t of defaults) await record("template", t.id, false);
      if (defaults.length)
        preview.push({
          label: "原默认模板",
          before: defaults.map((t) => t.name).join("、"),
          after: "取消默认，保留模板",
        });
    }
  } else if (type === "delete_template") {
    payload = z
      .object({ id: uuid, revision: z.number().int().optional() })
      .parse(raw);
    const t = await record("template", payload.id);
    payload.revision = snapshots.at(-1)!.revision;
    title = `删除模板 ${t.name}`;
    preview = [
      { label: "模板", before: t.name, after: "删除（已发送邮件快照保留）" },
    ];
  } else {
    const common = z.object({
      taskId: uuid,
      revision: z.number().int().optional(),
    });
    if (type === "update_task")
      payload = common
        .extend({ fields: taskFields.partial(), imageIds })
        .parse(raw);
    if (type === "link_task")
      payload = common.extend({ parentId: uuid.nullable() }).parse(raw);
    if (type === "external_delivery")
      payload = common
        .extend({
          channel: z.string().min(1).max(100),
          notes: text.default(""),
        })
        .parse(raw);
    if (type === "reopen_task") payload = common.parse(raw);
    if (type === "prepare_mail")
      payload = common
        .extend({
          to: z.string().max(320),
          subject: z.string().min(1).max(240),
          html: z.string().max(200000),
          attachmentIds: z.array(uuid).max(10).default([]),
        })
        .parse(raw);
    const t = await record("task", payload.taskId);
    payload.revision = snapshots.at(-1)!.revision;
    if (type === "update_task") {
      payload.imageIds = [
        ...new Set([
          ...payload.imageIds,
          ...(options.previous?.payload.imageIds || []),
        ]),
      ];
      payload.fields = taskFields.parse({
        filingAccount: "",
        filingPassword: "",
        ...t,
        intakeName: t.intakeName ?? t.softwareName,
        ...payload.fields,
      });
      title = `更新 ${t.softwareName || "任务资料"}`;
      preview = changePreview(t, payload.fields);
      if (payload.imageIds.length)
        preview.push({
          label: "来源截图",
          after: `补充 ${payload.imageIds.length} 张，原截图保留`,
        });
    }
    if (type === "link_task") {
      if (t.kind !== "correction")
        throw new AppError(400, "只有补正任务可以关联原单");
      const parent = payload.parentId
        ? await record("task", payload.parentId)
        : null;
      const tasks = await all<Task>("task"),
        children = new Set([t.id]);
      for (let more = true; more;) {
        more = false;
        for (const child of tasks)
          if (
            child.parentId &&
            children.has(child.parentId) &&
            !children.has(child.id)
          ) {
            children.add(child.id);
            more = true;
          }
      }
      if (payload.parentId && children.has(payload.parentId))
        throw new AppError(400, "不能关联自身或形成循环");
      for (const child of tasks)
        if (child.id !== t.id && children.has(child.id))
          await record("task", child.id, false);
      guards.descendantIds =
        (options.previous?.payload.taskId === t.id &&
          options.previous?.guards?.descendantIds) ||
        [...children].sort();
      title = parent ? "关联补正原单" : "解除补正关联";
      preview = [
        { label: "补正任务", after: t.softwareName },
        {
          label: "关联原单",
          before: t.parentId || "独立任务",
          after: parent?.softwareName || "独立任务",
        },
      ];
      if (children.size > 1)
        preview.push({
          label: "后续补正",
          after: `同步 ${children.size - 1} 项后续补正的归属`,
        });
    }
    if (type === "external_delivery") {
      title = "标记已在外部发送";
      preview = [
        { label: "任务", after: t.softwareName },
        { label: "渠道", after: payload.channel },
        { label: "备注", after: payload.notes },
        {
          label: "完成状态",
          before: t.completed ? "已完成" : "未完成",
          after: "已完成",
        },
      ];
    }
    if (type === "reopen_task") {
      title = "重新打开任务";
      preview = [
        { label: "任务", after: t.softwareName },
        {
          label: "完成状态",
          before: t.completed ? "已完成" : "未完成",
          after: "未完成",
        },
      ];
    }
    if (type === "prepare_mail") {
      payload.html = cleanHtml(payload.html);
      title = "准备交付邮件";
      const draft = await get("maildraft", t.id);
      if (draft) await record("maildraft", t.id, false);
      else
        snapshots.push({
          kind: "maildraft",
          id: t.id,
          revision:
            options.previous?.snapshots?.find(
              (s: Snapshot) => s.kind === "maildraft" && s.id === t.id,
            )?.revision ?? 0,
        });
      for (const attachmentId of payload.attachmentIds) {
        const a = await record("attachment", attachmentId, false);
        if (a.taskId !== t.id || a.status !== "ready")
          throw new AppError(400, "附件不属于此任务或已不可用");
      }
      preview = [
        { label: "收件邮箱", after: payload.to },
        { label: "邮件主题", after: payload.subject },
        { label: "邮件正文", after: payload.html },
        {
          label: "发送方式",
          after: "保存草稿后打开写信窗口，确认收件人与附件后再发送",
        },
      ];
    }
  }
  const unique = [
    ...new Map(snapshots.map((s) => [key(s.kind, s.id), s])).values(),
  ];
  return {
    type,
    payload,
    title,
    preview,
    candidates,
    snapshots: unique,
    guards,
  };
}

async function noSending(ids: string[], c: PoolConnection) {
  if (
    (await all("delivery", c)).some(
      (d) => ids.includes(d.taskId) && ["queued", "sending"].includes(d.status),
    )
  )
    throw new AppError(409, "选中的任务正在发送邮件，请等待结果后再修改");
}
async function imagesExist(ids: string[], c: PoolConnection) {
  for (const id of ids) {
    const [rows] = await c.query<any[]>(
      "SELECT id FROM screenshots WHERE id=?",
      [id],
    );
    if (!rows.length) throw new AppError(400, "来源截图不存在");
  }
}
async function applyAction(p: Doc, c: PoolConnection) {
  const d = p.payload,
    type = p.type;
  if (type === "save_template" || type === "delete_template")
    await lockTemplateCollection(c);
  for (const s of [...(p.snapshots as Snapshot[])].sort((a, b) =>
    (a.kind + a.id).localeCompare(b.kind + b.id),
  )) {
    const current = await get(s.kind, s.id, c, true);
    if (
      s.revision === 0 ? !!current : !current || current.revision !== s.revision
    )
      throw new AppError(
        409,
        "记录已发生变化，请让 AI 重新查询并整理，避免覆盖新的修改",
      );
  }
  if (type === "create_tasks") {
    await imagesExist(d.imageIds, c);
    if (d.intakeId) {
      const intake = await get("intake", d.intakeId, c, true);
      if (intake?.savedTaskIds?.length)
        return { taskIds: intake.savedTaskIds, alreadySaved: true };
    }
    let customer = d.customerId ? await get("customer", d.customerId, c) : null;
    const first = validateNewTask(d.items[0]);
    if (!customer)
      customer = await save(
        "customer",
        {
          name: first.customerName || "待补客户",
          memberName: first.memberName,
          email: first.email,
          wechat: first.wechat,
          notes: "",
        },
        undefined,
        c,
        "AI 确认录入",
      );
    const orderId = randomUUID(),
      created: Task[] = [];
    for (const item of d.items) {
      const fields = validateNewTask(item),
        parent = item.parentId
          ? await get<Task>("task", item.parentId, c, true)
          : null;
      if (item.parentId && !parent) throw new AppError(404, "原单不存在");
      if (
        parent &&
        (parent.customerId !== customer.id || fields.kind !== "correction")
      )
        throw new AppError(400, "请核对补正类型与客户归属");
      if (parent) await assertCanRework(parent, c);
      created.push(
        await save<Task>(
          "task",
          {
            ...fields,
            customerId: customer.id,
            orderId,
            parentId: parent?.id || null,
            projectId: parent?.projectId || randomUUID(),
            completed: false,
            completedAt: null,
            completionMethod: "",
            archived: false,
            imageIds: d.imageIds,
            intakeId: d.intakeId || null,
          },
          undefined,
          c,
          "AI 确认录入",
        ),
      );
    }
    if (d.intakeId)
      await save(
        "intake",
        {
          id: d.intakeId,
          status: "saved",
          savedTaskIds: created.map((t) => t.id),
        },
        undefined,
        c,
      );
    return { taskIds: created.map((t) => t.id), customerId: customer.id };
  }
  if (type === "archive_tasks") {
    await noSending(
      d.targets.map((t: any) => t.taskId),
      c,
    );
    for (const target of d.targets) {
      const targetTask = await get<Task>("task", target.taskId, c, true);
      if (!targetTask) throw new AppError(404, "任务不存在");
      await assertOperable(targetTask, c);
      await save(
        "task",
        { id: target.taskId, archived: d.archived },
        target.revision,
        c,
        "AI 确认批量归档",
      );
    }
    return { taskIds: d.targets.map((t: any) => t.taskId) };
  }
  if (type === "update_customer") {
    if (d.fields.email && !z.email().safeParse(d.fields.email).success)
      throw new AppError(400, "邮箱格式不正确");
    await save(
      "customer",
      { id: d.customerId, ...d.fields },
      d.revision,
      c,
      "AI 确认修改客户",
    );
    return { customerId: d.customerId };
  }
  if (type === "save_template") {
    if (d.isDefault) {
      const templates = await all("template", c);
      const currentDefaults = templates
        .filter((t) => t.id !== d.id && t.kind === d.kind && t.isDefault)
        .map((t) => t.id)
        .sort();
      if (
        JSON.stringify(currentDefaults) !==
        JSON.stringify(p.guards?.defaultTemplateIds || [])
      )
        throw new AppError(409, "默认模板已变化，请重新整理后确认");
      for (const t of templates)
        if (t.id !== d.id && t.kind === d.kind && t.isDefault)
          await save("template", { id: t.id, isDefault: false }, undefined, c);
    }
    const t = await save(
      "template",
      { ...d, html: cleanHtml(d.html) },
      d.revision,
      c,
      "AI 确认模板",
    );
    return { templateId: t.id };
  }
  if (type === "delete_template") {
    const before = await get("template", d.id, c, true);
    await c.query("DELETE FROM records WHERE kind=? AND id=?", [
      "template",
      d.id,
    ]);
    await c.query(
      "INSERT INTO audit_log(kind,record_id,action,before_data,created_at) VALUES (?,?,?,?,?)",
      ["template", d.id, "AI 确认删除模板", JSON.stringify(before), new Date()],
    );
    return { templateId: d.id };
  }
  const t = (await get<Task>("task", d.taskId, c, true))!;
  await assertOperable(t, c);
  await noSending([t.id], c);
  if (type === "update_task") {
    const fields = validateTask({ ...t, ...d.fields });
    if (t.parentId && fields.kind !== "correction")
      throw new AppError(400, "请先解除原单关联，再修改任务类型");
    await imagesExist(d.imageIds, c);
    await save(
      "task",
      {
        ...t,
        ...fields,
        imageIds: [...new Set([...t.imageIds, ...d.imageIds])],
      },
      d.revision,
      c,
      "AI 确认补充资料",
    );
  }
  if (type === "link_task") {
    const parent = d.parentId
      ? await get<Task>("task", d.parentId, c, true)
      : null;
    if (parent && parent.id !== t.parentId) await assertCanRework(parent, c);
    const tasks = await all<Task>("task", c),
      descendants = new Set([t.id]);
    for (let more = true; more;) {
      more = false;
      for (const child of tasks)
        if (
          child.parentId &&
          descendants.has(child.parentId) &&
          !descendants.has(child.id)
        ) {
          descendants.add(child.id);
          more = true;
        }
    }
    if (parent && descendants.has(parent.id))
      throw new AppError(400, "不能形成补正关联循环");
    if (
      JSON.stringify([...descendants].sort()) !==
      JSON.stringify(p.guards?.descendantIds || [])
    )
      throw new AppError(409, "后续补正任务已变化，请重新整理关联方案");
    await noSending([...descendants], c);
    const projectId =
        parent?.projectId || (t.parentId ? randomUUID() : t.projectId),
      customerId = parent?.customerId || t.customerId;
    for (const child of tasks)
      if (descendants.has(child.id))
        await save(
          "task",
          {
            id: child.id,
            projectId,
            customerId,
            ...(child.id === t.id ? { parentId: parent?.id || null } : {}),
          },
          child.revision,
          c,
          "AI 确认补正关联",
        );
  }
  if (type === "external_delivery") {
    if (t.completed || t.archived)
      throw new AppError(409, "任务已完成或归档，请重新核对。");
    const sentAt = new Date().toISOString();
    await save(
      "task",
      {
        ...t,
        completed: true,
        completedAt: sentAt,
        completionMethod: "external",
      },
      d.revision,
      c,
      "AI 确认外部交付",
    );
    await save(
      "delivery",
      {
        taskId: t.id,
        customerName: t.customerName,
        softwareName: t.softwareName,
        to: t.email,
        subject: d.channel,
        html: "",
        notes: d.notes,
        status: "external",
        sentAt,
        channel: d.channel,
        attachments: [],
      },
      undefined,
      c,
    );
  }
  if (type === "reopen_task")
    await save(
      "task",
      { ...t, completed: false, completedAt: null, completionMethod: "" },
      d.revision,
      c,
      "AI 确认重新打开",
    );
  if (type === "prepare_mail") {
    if (d.to && !z.email().safeParse(d.to).success)
      throw new AppError(400, "邮箱格式不正确");
    if (/[\r\n]/.test(d.subject))
      throw new AppError(400, "邮件主题不能包含换行");
    const draft = await save(
      "maildraft",
      {
        id: t.id,
        to: d.to,
        subject: d.subject,
        html: cleanHtml(d.html),
        attachmentIds: d.attachmentIds,
      },
      undefined,
      c,
      "AI 确认邮件草稿",
    );
    return { taskId: t.id, mailDraftId: draft.id };
  }
  return { taskId: t.id, taskIds: [t.id] };
}

export async function confirmProposal(id: string, revision: number) {
  return transaction(async (c) => {
    const p = await get("chatproposal", id, c, true);
    if (!p) throw new AppError(404, "待确认内容不存在");
    if (p.status === "applied") return p;
    if (p.status !== "pending")
      throw new AppError(409, "这项操作已取消，请重新整理");
    if (p.revision !== revision)
      throw new AppError(409, "待确认内容已更新，请重新核对");
    const result = await applyAction(p, c);
    return save(
      "chatproposal",
      {
        ...p,
        status: "applied",
        result,
        error: "",
        appliedAt: new Date().toISOString(),
      },
      revision,
      c,
      "确认 AI 操作",
    );
  });
}
