import { assertOperable, assertCanRework } from "./rework.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolConnection } from "mysql2/promise";
import { all, get, pool, save, transaction } from "./db.ts";
import { AppError, type Task } from "./types.ts";
import { withNewPurchaseDate } from "../shared/date.ts";

export async function lockTemplateCollection(c: PoolConnection) {
  // Serialize even an empty collection before taking its range lock. Every
  // template writer uses this order; the connection settings are not changed.
  await c.query("SELECT id FROM records WHERE kind=? AND id=? FOR UPDATE", [
    "settings",
    "connections",
  ]);
  await c.query(
    "SELECT id FROM records FORCE INDEX (PRIMARY) WHERE kind=? ORDER BY id FOR UPDATE",
    ["template"],
  );
}

const str = z.string().max(5000);
export const taskFields = z.object({
  customerName: str,
  memberName: str,
  email: z.string().max(320),
  wechat: str,
  kind: z.enum(["new", "correction"]),
  softwareName: str,
  intakeName: str,
  filingAccount: str,
  filingPassword: str,
  originalName: str,
  notes: str,
  purchasedAt: z.string().max(30),
  amount: z.string().max(30),
  needsSubmission: z.boolean(),
});
export const defaults = {
  customerName: "",
  memberName: "",
  email: "",
  wechat: "",
  kind: "new" as const,
  softwareName: "",
  intakeName: "",
  filingAccount: "",
  filingPassword: "",
  originalName: "",
  notes: "",
  purchasedAt: "",
  amount: "",
  needsSubmission: false,
};
export function validateTask(input: any) {
  const d = taskFields.parse({ ...defaults, ...input });
  if (d.email && !z.email().safeParse(d.email.trim()).success)
    throw new AppError(400, "邮箱格式不正确");
  if (d.purchasedAt && !/^\d{4}-\d{2}-\d{2}$/.test(d.purchasedAt))
    throw new AppError(400, "购买日期格式应为年-月-日");
  if (d.purchasedAt) {
    const date = new Date(d.purchasedAt + "T00:00:00Z");
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== d.purchasedAt
    )
      throw new AppError(400, "购买日期不是有效日期");
  }
  if (d.amount && (Number(d.amount) < 0 || !Number.isFinite(Number(d.amount))))
    throw new AppError(400, "金额应为非负数字");
  return {
    ...d,
    email: d.email.trim(),
    customerName: d.customerName.trim(),
    softwareName: d.softwareName.trim(),
  };
}
export function validateNewTask(input: any, now: Date = new Date()) {
  return validateTask(
    withNewPurchaseDate(
      { ...input, intakeName: input.intakeName || input.softwareName || "" },
      now,
    ),
  );
}
export async function createTasks(input: any) {
  const items = z.array(z.any()).min(1).max(30).parse(input.items);
  z.object({
    customerId: z.string().uuid().optional(),
    intakeId: z.string().uuid().optional(),
    imageIds: z.array(z.string().uuid()).max(20).optional(),
  }).parse(input);
  for (const imageId of input.imageIds || []) {
    const [rows] = await pool.query<any[]>(
      "SELECT id FROM screenshots WHERE id=?",
      [imageId],
    );
    if (!rows.length) throw new AppError(400, "来源图片不存在");
  }
  return transaction(async (c) => {
    if (input.intakeId) {
      const intake = await get("intake", input.intakeId, c, true);
      if (!intake) throw new AppError(404, "录入草稿不存在");
      if (intake.savedTaskIds?.length)
        return Promise.all(
          intake.savedTaskIds.map((id: string) => get("task", id, c)),
        );
    }
    let customer = input.customerId
      ? await get("customer", input.customerId, c)
      : null;
    if (input.customerId && !customer) throw new AppError(404, "客户不存在");
    const first = validateNewTask(items[0]);
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
      );
    const orderId = randomUUID(),
      out: Task[] = [];
    const parents = new Map<string, Task | null>();
    for (const parentId of [
      ...new Set<string>(items.map((item) => item.parentId).filter(Boolean)),
    ].sort())
      parents.set(parentId, await get<Task>("task", parentId, c, true));
    for (const item of items) {
      const d = validateNewTask(item);
      const parent = item.parentId ? parents.get(item.parentId) : null;
      if (item.parentId && !parent) throw new AppError(404, "原任务不存在");
      if (parent && parent.customerId !== customer.id)
        throw new AppError(400, "原单属于另一客户，请先选择正确客户");
      if (parent && d.kind !== "correction")
        throw new AppError(400, "只有补正任务可以关联原单");
      if (parent) await assertCanRework(parent, c);
      const task = await save<Task>(
        "task",
        {
          ...d,
          customerId: customer.id,
          orderId,
          parentId: parent?.id || null,
          projectId: parent?.projectId || randomUUID(),
          completed: false,
          completedAt: null,
          completionMethod: "",
          archived: false,
          imageIds: input.imageIds || [],
          intakeId: input.intakeId || null,
        },
        undefined,
        c,
      );
      out.push(task);
    }
    if (input.intakeId)
      await save(
        "intake",
        {
          id: input.intakeId,
          status: "saved",
          savedTaskIds: out.map((t) => t.id),
        },
        undefined,
        c,
      );
    return out;
  });
}
export async function patchTask(id: string, input: any) {
  return transaction(async (c) => {
    const old = await get<Task>("task", id, c, true);
    if (!old) throw new AppError(404, "任务不存在");
    await assertOperable(old, c);
    if (
      (await all("delivery", c)).some(
        (d) => d.taskId === id && ["queued", "sending"].includes(d.status),
      )
    )
      throw new AppError(409, "正在发送邮件，请等待发送结果后修改");
    const fields = validateTask({
      ...old,
      intakeName: old.intakeName ?? old.softwareName,
      ...input,
    });
    if (old.parentId && fields.kind !== "correction")
      throw new AppError(400, "请先解除原单关联，再修改任务类型");
    return save<Task>(
      "task",
      {
        ...old,
        ...fields,
        archived:
          typeof input.archived === "boolean" ? input.archived : old.archived,
      },
      input.revision,
      c,
    );
  });
}
export async function supplementTask(id: string, input: any) {
  const body = z
    .object({
      revision: z.number().int(),
      intakeId: z.string().uuid().optional(),
      imageIds: z.array(z.string().uuid()).max(20),
      fields: z.record(z.string(), z.any()),
    })
    .parse(input);
  return transaction(async (c) => {
    if (body.intakeId) {
      const intake = await get("intake", body.intakeId, c, true);
      if (!intake) throw new AppError(404, "录入草稿不存在");
      if (intake.savedTaskIds?.length) {
        if (intake.savedTaskIds.length === 1 && intake.savedTaskIds[0] === id)
          return get<Task>("task", id, c);
        throw new AppError(409, "这一批已经用于其他任务，请新建一批截图");
      }
    }
    const task = await get<Task>("task", id, c, true);
    if (!task) throw new AppError(404, "任务不存在");
    await assertOperable(task, c);
    if (
      (await all("delivery", c)).some(
        (d) => d.taskId === id && ["queued", "sending"].includes(d.status),
      )
    )
      throw new AppError(409, "正在发送邮件，请等待结果后补充资料");
    for (const imageId of body.imageIds) {
      const [rows] = await c.query<any[]>(
        "SELECT id FROM screenshots WHERE id=?",
        [imageId],
      );
      if (!rows.length) throw new AppError(400, "来源图片不存在");
    }
    const fields = validateTask({
      ...task,
      intakeName: task.intakeName ?? task.softwareName,
      ...body.fields,
    });
    if (task.parentId && fields.kind !== "correction")
      throw new AppError(400, "关联原单的任务必须保留补正类型");
    const result = await save<Task>(
      "task",
      {
        ...task,
        ...fields,
        imageIds: [...new Set([...task.imageIds, ...body.imageIds])],
      },
      body.revision,
      c,
      "截图补充资料",
    );
    if (body.intakeId)
      await save(
        "intake",
        { id: body.intakeId, status: "saved", savedTaskIds: [id] },
        undefined,
        c,
      );
    return result;
  });
}
export async function linkTask(
  id: string,
  parentId: string | null,
  revision: number,
) {
  return transaction(async (c) => {
    const task = await get<Task>("task", id, c, true);
    if (!task) throw new AppError(404, "任务不存在");
    await assertCanRework(task, c);
    if (task.kind !== "correction")
      throw new AppError(400, "仅补正任务可以关联原单");
    const parent = parentId ? await get<Task>("task", parentId, c, true) : null;
    if (parentId && !parent) throw new AppError(404, "原任务不存在");
    if (parent && parent.id !== task.parentId) await assertCanRework(parent, c);
    if (parent) {
      let cur: Task | null = parent;
      const seen = new Set<string>([id]);
      while (cur) {
        if (seen.has(cur.id)) throw new AppError(400, "不能关联自身或形成循环");
        seen.add(cur.id);
        cur = cur.parentId ? await get<Task>("task", cur.parentId, c) : null;
      }
    }
    const result = await save<Task>(
      "task",
      {
        ...task,
        parentId: parent?.id || null,
        projectId:
          parent?.projectId || (task.parentId ? randomUUID() : task.projectId),
        customerId: parent?.customerId || task.customerId,
      },
      revision,
      c,
      "关联原单",
    );
    // Keep descendants in the same software lineage when a previously standalone correction is linked.
    const tasks = await all<Task>("task", c);
    const descend = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of tasks)
        if (t.parentId && descend.has(t.parentId) && !descend.has(t.id)) {
          descend.add(t.id);
          changed = true;
        }
    }
    for (const t of tasks)
      if (t.id !== id && descend.has(t.id))
        await save(
          "task",
          { ...t, projectId: result.projectId, customerId: result.customerId },
          undefined,
          c,
          "关联链更新",
        );
    return result;
  });
}
export async function markExternal(id: string, input: any) {
  return transaction(async (c) => {
    const task = await get<Task>("task", id, c, true);
    if (!task) throw new AppError(404, "任务不存在");
    await assertOperable(task, c);
    if (
      (await all("delivery", c)).some(
        (d) => d.taskId === id && ["queued", "sending"].includes(d.status),
      )
    )
      throw new AppError(409, "邮件正在发送，请先等待结果");
    if (!input.channel?.trim()) throw new AppError(400, "请填写发送渠道");
    const time = input.sentAt ? new Date(input.sentAt) : new Date();
    if (!Number.isFinite(time.getTime()))
      throw new AppError(400, "发送时间无效");
    const result = await save<Task>(
      "task",
      {
        ...task,
        completed: true,
        completedAt: time.toISOString(),
        completionMethod: "external",
      },
      input.revision,
      c,
      "外部交付",
    );
    await save(
      "delivery",
      {
        taskId: id,
        customerName: task.customerName,
        softwareName: task.softwareName,
        to: task.email,
        subject: input.channel,
        html: "",
        notes: String(input.notes || ""),
        status: "external",
        sentAt: time.toISOString(),
        channel: input.channel,
        attachments: [],
      },
      undefined,
      c,
    );
    return result;
  });
}
export function candidateMatches(tasks: Task[], draft: any) {
  const norm = (s: string) => s.toLowerCase().replace(/[\s，。._\-]/g, "");
  return tasks
    .filter((t) => !t.archived)
    .map((t) => {
      let score = 0;
      const reasons = [];
      if (draft.email && t.email.toLowerCase() === draft.email.toLowerCase()) {
        score += 55;
        reasons.push("邮箱一致");
      }
      if (
        draft.customerName &&
        norm(t.customerName) === norm(draft.customerName)
      ) {
        score += 25;
        reasons.push("昵称一致");
      }
      if (draft.wechat && t.wechat === draft.wechat) {
        score += 45;
        reasons.push("微信一致");
      }
      const name = draft.originalName || draft.softwareName;
      if (
        name &&
        [t.softwareName, t.originalName].some((n) => norm(n) === norm(name))
      ) {
        score += 60;
        reasons.push("软件名称一致");
      } else if (
        name &&
        name.length >= 4 &&
        [t.softwareName, t.originalName].some(
          (n) =>
            n && (norm(n).includes(norm(name)) || norm(name).includes(norm(n))),
        )
      ) {
        score += 20;
        reasons.push("软件名称相近");
      }
      return { task: t, score, reasons };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export async function patchContactGroup(input: unknown) {
  const body = z
    .object({
      targets: z
        .array(
          z.object({
            id: z.string().uuid(),
            revision: z.number().int().positive(),
          }),
        )
        .min(1)
        .max(2000),
      field: z.enum(["customerName", "email", "wechat"]),
      value: z.string().max(5000),
    })
    .parse(input);
  if (new Set(body.targets.map((t) => t.id)).size !== body.targets.length)
    throw new AppError(400, "任务重复");
  return transaction(async (c) => {
    const changes: {
      task: Task;
      fields: ReturnType<typeof validateTask>;
      revision: number;
    }[] = [];
    for (const target of [...body.targets].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const task = await get<Task>("task", target.id, c, true);
      if (!task) throw new AppError(404, "任务不存在");
      if (task.revision !== target.revision)
        throw new AppError(409, "本组资料已变化，请刷新后重新修改");
      await assertOperable(task, c);
      if (
        changes.length &&
        ["customerId", "purchasedAt", "kind"].some(
          (k) => changes[0].task[k] !== task[k],
        )
      )
        throw new AppError(400, "只能修改同一组客户订单的联系方式");
      const fields = validateTask({
        ...task,
        intakeName: task.intakeName ?? task.softwareName,
        [body.field]: body.value,
      });
      changes.push({ task, fields, revision: target.revision });
    }
    for (const { task } of changes) {
      const [pending] = await c.query<any[]>(
        `SELECT id FROM records WHERE kind='delivery' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.taskId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status')) IN ('queued','sending') FOR UPDATE`,
        [task.id],
      );
      if (pending.length)
        throw new AppError(409, "本组有邮件正在发送，请稍后修改联系方式");
    }
    const saved = [];
    for (const { task, fields, revision } of changes)
      saved.push(
        await save(
          "task",
          { ...task, [body.field]: fields[body.field] },
          revision,
          c,
          "列表修改联系方式",
        ),
      );
    return { tasks: saved };
  });
}
