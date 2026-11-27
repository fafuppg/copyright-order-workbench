import { withNewPurchaseDate } from "../shared/date";

export async function api(
  path: string,
  body?: any,
  method?: string,
): Promise<any> {
  const multipart = body instanceof FormData;
  const response = await fetch(import.meta.env.BASE_URL + "api/v1" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "x-workbench": "1",
      ...(!multipart && body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? (multipart ? body : JSON.stringify(body)) : undefined,
  });
  const data = await response
    .json()
    .catch(() => ({ error: "服务器没有返回有效结果" }));
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(data.error || "操作失败");
  }
  return data;
}
export type Item = Record<string, any>;
export const emptyTask = {
  customerName: "",
  memberName: "",
  email: "",
  wechat: "",
  kind: "new",
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
export function newTaskDraft(initial: Item = {}, now: Date = new Date()): Item {
  return withNewPurchaseDate(
    {
      ...emptyTask,
      ...initial,
      intakeName: initial.intakeName ?? initial.softwareName ?? "",
    },
    now,
  );
}
export function reworkTaskDraft(source: Item, now: Date = new Date()): Item {
  return newTaskDraft(
    {
      kind: "correction",
      customerId: source.customerId,
      customerName: source.customerName,
      memberName: source.memberName,
      email: source.email,
      wechat: source.wechat,
      filingAccount: source.filingAccount || "",
      filingPassword: source.filingPassword || "",
      originalName: source.softwareName,
      intakeName: source.softwareName,
      softwareName: source.softwareName,
      parentId: source.id,
      needsSubmission: !!source.needsSubmission,
      imageIds: source.imageIds || [],
    },
    now,
  );
}
export function supplementTaskDraft(target: Item, source: Item): Item {
  const nonempty = Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        Object.hasOwn(emptyTask, key) &&
        typeof value === "string" &&
        value.trim() &&
        key !== "kind" &&
        !(key === "purchasedAt" && source.purchaseDateDefaulted),
    ),
  );
  return {
    ...target,
    ...nonempty,
    kind: target.kind,
    needsSubmission: target.needsSubmission,
  };
}
export function dateLabel(s?: string) {
  return s
    ? new Date(s).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
}
export function bytes(n: number) {
  return n >= 1048576
    ? (n / 1048576).toFixed(1) + " MB"
    : (n / 1024).toFixed(0) + " KB";
}
export function fill(text: string, t: Item) {
  const map: Item = {
    客户称呼: t.customerName || "您好",
    软件名称: t.softwareName || "待定软件",
    原名称: t.originalName || t.softwareName || "",
    邮箱: t.email || "",
  };
  return text.replace(/\{\{([^}]+)\}\}/g, (_, k) => map[k] ?? `{{${k}}}`);
}
export function fillHtml(text: string, t: Item) {
  const escaped = Object.fromEntries(
    Object.entries(t).map(([k, v]) => [
      k,
      typeof v === "string"
        ? v.replace(
            /[&<>"']/g,
            (c) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[c]!,
          )
        : v,
    ]),
  );
  return fill(text, escaped);
}
