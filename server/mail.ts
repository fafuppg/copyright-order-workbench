import { assertOperable } from "./rework.ts";
import "dotenv/config";
import { createTransport } from "nodemailer";
import { randomUUID } from "node:crypto";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { all, get, save, transaction } from "./db.ts";
import { settings, cleanHtml } from "./security.ts";
import { AppError, type Task } from "./types.ts";
import { z } from "zod";
import { recordOutgoingMail, outgoingMimeMessageId } from "./mailbox.ts";

export const TEMP_DIR = path.resolve(
  process.env.DATA_DIR || "data",
  "attachments",
);
export function attachmentPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError(400, "附件编号无效");
  return path.join(TEMP_DIR, id);
}
export async function mailTransport() {
  const c = await settings();
  return createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpPort === 465,
    requireTLS: process.env.NODE_ENV === "test" ? false : c.smtpPort !== 465,
    ignoreTLS: process.env.NODE_ENV === "test",
    auth: { user: c.smtpUser, pass: c.smtpPassword },
    connectionTimeout: 20000,
    socketTimeout: 180000,
    logger: false,
    debug: false,
  });
}
export async function queueMail(taskId: string, input: any) {
  const to = z.email().parse(input.to);
  const subject = z.string().min(1).max(240).parse(input.subject);
  if (/[\r\n]/.test(subject)) throw new AppError(400, "主题不能包含换行");
  const ids = z.array(z.string()).max(10).parse(input.attachmentIds);
  if (new Set(ids).size !== ids.length) throw new AppError(400, "附件重复");
  const requestId = z.string().uuid().parse(input.requestId);
  return transaction(async (c) => {
    const task = await get<Task>("task", taskId, c, true);
    if (!task) throw new AppError(404, "任务不存在");
    await assertOperable(task, c);
    const existing = await get("delivery", requestId, c);
    if (existing) {
      if (existing.taskId !== taskId) throw new AppError(409, "发送请求冲突");
      return existing;
    }
    if (task.revision !== input.revision)
      throw new AppError(409, "任务内容已修改，请刷新后重新准备邮件");
    const prior = (await all("delivery", c)).filter((d) => d.taskId === taskId);
    if (prior.some((d) => ["queued", "sending"].includes(d.status)))
      throw new AppError(409, "此任务已有邮件正在发送");
    if (
      (task.completed || prior.some((d) => d.status === "uncertain")) &&
      !input.confirmResend
    )
      throw new AppError(
        409,
        "此任务已有交付记录或发送结果不确定，请勾选确认重新发送",
      );
    const attachments = [];
    for (const id of ids) {
      const reusable = await get("templatefile", id, c);
      if (reusable) {
        attachments.push({
          id: reusable.id,
          name: reusable.name,
          size: reusable.size,
          persistent: true,
        });
        continue;
      }
      const a = await get("attachment", id, c, true);
      if (!a || a.taskId !== taskId || a.status !== "ready")
        throw new AppError(400, "附件不存在、已清理或不属于此任务");
      try {
        await stat(attachmentPath(id));
      } catch {
        throw new AppError(400, "临时附件不可用，请重新上传");
      }
      attachments.push({ id: a.id, name: a.name, size: a.size });
    }
    return save(
      "delivery",
      {
        id: requestId,
        taskId,
        to,
        subject,
        html: cleanHtml(String(input.html || "")),
        status: "queued",
        customerName: task.customerName,
        softwareName: task.softwareName,
        attachments,
        error: "",
        sentAt: null,
        channel: "email",
      },
      undefined,
      c,
    );
  });
}
export async function completeDelivery(deliveryId: string, messageId: string) {
  return transaction(async (c) => {
    const d = await get("delivery", deliveryId, c, true);
    if (!d) throw new AppError(404, "邮件记录不存在");
    const task = await get<Task>("task", d.taskId, c, true);
    if (!task) throw new AppError(404, "任务不存在");
    const now = new Date().toISOString();
    await save(
      "delivery",
      { ...d, status: "sent", sentAt: now, messageId },
      undefined,
      c,
      "邮件发送成功",
    );
    await save(
      "task",
      { ...task, completed: true, completedAt: now, completionMethod: "email" },
      undefined,
      c,
      "邮件交付",
    );
    await c.query("DELETE FROM records WHERE kind=? AND id=?", [
      "maildraft",
      task.id,
    ]);
  });
}
export async function cleanSentAttachments(d: any) {
  for (const a of d.attachments || []) {
    if (a.persistent) continue;
    await rm(attachmentPath(a.id), { force: true });
    await save(
      "attachment",
      { id: a.id, status: "purged" },
      undefined,
      undefined,
      "发送后清理",
    );
  }
}
let sending = false;
export async function tickMail(
  factory: () => Promise<{
    sendMail: (v: any) => Promise<any>;
    close: () => void;
  }> = mailTransport,
) {
  if (sending) return;
  sending = true;
  let eml: string | undefined;
  let networkStarted = false;
  let accepted = false;
  let currentId: string | undefined;
  try {
    const d = (await all("delivery"))
      .reverse()
      .find((x) => x.status === "queued");
    if (!d) return;
    currentId = d.id;
    await save("delivery", { id: d.id, status: "sending" });
    const cfg = await settings();
    await mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
    eml = path.join(TEMP_DIR, randomUUID() + ".eml");
    const streamTransport = createTransport({
      streamTransport: true,
      newline: "windows",
      buffer: false,
    });
    const compiled = await streamTransport.sendMail({
      from: { name: "软著材料交付", address: cfg.smtpUser },
      to: d.to,
      subject: d.subject,
      html: d.html,
      text: cleanHtml(d.html).replace(/<[^>]+>/g, " "),
      messageId: outgoingMimeMessageId(d.id),
      attachments: await Promise.all(
        d.attachments.map(async (a: any) => {
          if (!a.persistent)
            return { filename: a.name, path: attachmentPath(a.id) };
          const file = await get("templatefile", a.id);
          if (!file) throw new AppError(400, "模板附件不存在");
          return {
            filename: a.name,
            content: Buffer.from(file.content, "base64"),
          };
        }),
      ),
    });
    await pipeline(
      compiled.message as any,
      createWriteStream(eml, { mode: 0o600 }),
    );
    const size = (await stat(eml)).size;
    await save("delivery", { id: d.id, mimeBytes: size });
    if (size > cfg.mailMaxBytes)
      throw new AppError(
        413,
        `邮件编码后为 ${(size / 1048576).toFixed(1)} MiB，超过 ${(cfg.mailMaxBytes / 1048576).toFixed(0)} MiB 限制，请自行交付后标记外部发送`,
      );
    const transport = await factory();
    networkStarted = true;
    const result = await transport.sendMail({
      envelope: { from: cfg.smtpUser, to: [d.to] },
      // raw MIME is not parsed by Nodemailer; pass its actual ID explicitly.
      messageId: compiled.messageId,
      raw: createReadStream(eml),
    });
    transport.close();
    if (!result.accepted?.length) throw new Error("邮件服务器未接受收件人");
    accepted = true;
    await completeDelivery(d.id, compiled.messageId);
    // Delivery is already confirmed. Mailbox indexing can recover on its next tick.
    await get("delivery", d.id)
      .then(recordOutgoingMail)
      .catch(() => {});
    await cleanSentAttachments(d);
  } catch (error: any) {
    if (currentId) {
      const existing = await get("delivery", currentId).catch(() => null);
      if (existing?.status !== "sent") {
        const uncertain =
          accepted ||
          (networkStarted &&
            !error.responseCode &&
            !(error.statusCode === 413));
        await save("delivery", {
          id: currentId,
          status: uncertain ? "uncertain" : "failed",
          error: uncertain
            ? "发送结果未能确认，请先检查QQ邮箱已发送记录，避免重复发送。"
            : String(error.message || "发送失败").slice(0, 500),
        }).catch(() => {});
      }
    }
  } finally {
    if (eml) await rm(eml, { force: true }).catch(() => {});
    sending = false;
  }
}
