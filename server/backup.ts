import { pool, transaction } from "./db.ts";
import { AppError } from "./types.ts";

export async function exportBackup() {
  return transaction(async (c) => {
    const [records] = await c.query<any[]>(
      "SELECT kind,id,payload,revision FROM records WHERE kind NOT IN (?,?)",
      ["user", "settings"],
    );
    const [audit] = await c.query<any[]>("SELECT * FROM audit_log");
    const [screenshots] = await c.query<any[]>(
      "SELECT id,hash,name,mime,size,content,created_at FROM screenshots",
    );
    return {
      format: "copyright-workbench-v1",
      exportedAt: new Date().toISOString(),
      records,
      audit,
      screenshots: screenshots.map((i) => ({
        ...i,
        content: i.content.toString("base64"),
      })),
    };
  });
}
export async function restoreBackup(backup: any) {
  if (
    backup?.format !== "copyright-workbench-v1" ||
    !Array.isArray(backup.records) ||
    !Array.isArray(backup.screenshots) ||
    !Array.isArray(backup.audit)
  )
    throw new AppError(400, "备份格式不正确");
  return transaction(async (c) => {
    const [existing] = await c.query<any[]>(
      "SELECT COUNT(*) AS n FROM records WHERE kind NOT IN (?,?,?)",
      ["user", "settings", "template"],
    );
    if (existing[0].n > 0)
      throw new AppError(
        409,
        "恢复目标已有业务记录，请使用空白数据库，避免覆盖现有订单",
      );
    const allowed = [
      "customer",
      "task",
      "template",
      "templatefile",
      "delivery",
      "intake",
      "attachment",
      "maildraft",
      "chatsession",
      "chatmessage",
      "chatproposal",
      "mailmessage",
      "mailboxstate",
    ];
    await c.query("DELETE FROM records WHERE kind=?", ["template"]);
    for (const row of backup.records) {
      if (!allowed.includes(row.kind))
        throw new AppError(400, "备份包含不允许恢复的记录类型");
      const data =
        typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      if (!data || data.id !== row.id) throw new AppError(400, "备份记录损坏");
      if (row.kind === "attachment" && data.status === "ready")
        data.status = "unavailable";
      if (
        row.kind === "delivery" &&
        ["queued", "sending"].includes(data.status)
      ) {
        data.status = "uncertain";
        data.error = "从备份恢复，请先核对邮箱记录再决定重发";
      }
      if (
        row.kind === "intake" &&
        ["queued", "processing"].includes(data.status)
      ) {
        data.status = "failed";
        data.error = "从备份恢复，可手工继续或重新识别";
      }
      if (row.kind === "chatsession") data.status = "idle";
      if (row.kind === "mailboxstate") {
        data.status = "idle";
        data.requested = false;
        data.manualRun = false;
        data.folders = [];
        data.hasMore = false;
        data.lastSyncAt = null;
        data.lastError = "从备份恢复，将重新核对邮箱目录与同步进度。";
      }
      if (
        row.kind === "chatmessage" &&
        ["queued", "processing"].includes(data.status)
      ) {
        data.status = "failed";
        data.error = "从备份恢复，请重试";
      }
      await c.query("INSERT INTO records VALUES (?,?,?,?,?,?)", [
        row.id,
        row.kind,
        JSON.stringify(data),
        row.revision,
        new Date(data.createdAt),
        new Date(data.updatedAt),
      ]);
    }
    for (const img of backup.screenshots)
      await c.query("INSERT INTO screenshots VALUES (?,?,?,?,?,?,?)", [
        img.id,
        img.hash,
        img.name,
        img.mime,
        img.size,
        Buffer.from(img.content, "base64"),
        new Date(img.created_at),
      ]);
    for (const a of backup.audit)
      await c.query(
        "INSERT INTO audit_log(kind,record_id,action,before_data,after_data,created_at) VALUES (?,?,?,?,?,?)",
        [
          a.kind,
          a.record_id,
          a.action,
          a.before_data ? JSON.stringify(a.before_data) : null,
          a.after_data ? JSON.stringify(a.after_data) : null,
          new Date(a.created_at),
        ],
      );
    return {
      records: backup.records.length,
      screenshots: backup.screenshots.length,
    };
  });
}
