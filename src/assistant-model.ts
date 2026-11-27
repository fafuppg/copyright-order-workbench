import { emptyTask, newTaskDraft, type Item } from "./api";

export const proposalNames: Record<string, string> = {
  create_tasks: "录入订单",
  update_task: "补充 / 修改任务",
  link_task: "关联补正原单",
  external_delivery: "记录外部交付",
  reopen_task: "重新打开任务",
  archive_tasks: "整理任务",
  update_customer: "更新客户资料",
  save_template: "保存邮件模板",
  delete_template: "删除邮件模板",
  prepare_mail: "准备邮件",
};
export const proposalStates: Record<string, string> = {
  pending: "待你确认",
  applied: "已执行",
  cancelled: "已取消",
  failed: "执行失败",
};
export const fieldNames: Record<string, string> = {
  customerName: "客户昵称",
  memberName: "会员名",
  email: "邮箱",
  wechat: "微信 / 联系方式",
  softwareName: "软件名称",
  originalName: "原软件名称",
  notes: "备注",
  purchasedAt: "购买日期",
  amount: "成交金额",
  needsSubmission: "需要代提交",
  kind: "任务类型",
  completed: "完成状态",
  archived: "归档状态",
  parentId: "关联原单",
  name: "名称",
  subject: "邮件主题",
  to: "收件邮箱",
};
export function taskPayload(value: Item) {
  return Object.fromEntries(
    Object.keys(emptyTask).map((key) => [
      key,
      value[key] ?? (emptyTask as Item)[key],
    ]),
  );
}
export function editablePayload(proposal: Item, tasks: Item[]): Item {
  const payload = structuredClone(proposal.payload || {});
  if (proposal.type === "create_tasks")
    payload.items = (payload.items || [{}]).map((item: Item) =>
      newTaskDraft(item),
    );
  if (proposal.type === "update_task") {
    const task = tasks.find((t) => t.id === payload.taskId) || {};
    payload.fields = taskPayload({ ...task, ...payload.fields });
  }
  return payload;
}
export function proposalVersion(proposal: Item) {
  return proposal.id + ":" + proposal.revision;
}
export function isProposalEditable(proposal: Item) {
  return ["pending", "failed"].includes(proposal.status);
}
export function selectNewProposal(proposals: Item[], known: Set<string>) {
  return proposals.find(
    (p) => isProposalEditable(p) && !known.has(proposalVersion(p)),
  );
}
export function confirmationRecovery(
  actual: Item | undefined,
  knownRevision: number,
) {
  if (actual?.status === "applied") return "applied";
  if (actual?.status === "pending" && actual.revision !== knownRevision)
    return "reload";
  if (actual?.status === "cancelled") return "cancelled";
  return "retry";
}
export function readableValue(value: unknown): string {
  if (value === true) return "是";
  if (value === false) return "否";
  if (value === null || value === undefined || value === "") return "未填写";
  if (value === "new") return "新单";
  if (value === "correction") return "补正";
  if (Array.isArray(value)) return value.map(readableValue).join("、");
  if (typeof value === "object")
    return Object.entries(value as Item)
      .map(([k, v]) => `${fieldNames[k] || k}：${readableValue(v)}`)
      .join("；");
  return String(value);
}
