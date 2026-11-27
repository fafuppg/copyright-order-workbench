import {
  assertOperable,
  cancelCorrection,
  withReworkStatus,
} from "./rework.ts";
import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { exportBackup } from "./backup.ts";
import { randomUUID, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z, ZodError } from "zod";
import {
  all,
  get,
  pool,
  save,
  migrate,
  transaction,
  recordsForTask,
} from "./db.ts";
import { AppError, type Task } from "./types.ts";
import {
  passwordHash,
  checkPassword,
  hash,
  settings,
  publicSettings,
  saveSettings,
  cleanHtml,
} from "./security.ts";
import {
  createTasks,
  patchContactGroup,
  patchTask,
  supplementTask,
  linkTask,
  markExternal,
  candidateMatches,
  lockTemplateCollection,
} from "./business.ts";
import { tickAI } from "./ai.ts";
import { registerTaskHistoryRoutes } from "./task-history.ts";
import {
  registerMailboxRoutes,
  tickMailbox,
  recoverMailbox,
} from "./mailbox.ts";
import {
  registerAssistantRoutes,
  tickAssistant,
  recoverAssistant,
} from "./assistant.ts";
import {
  TEMP_DIR,
  attachmentPath,
  queueMail,
  tickMail,
  mailTransport,
  cleanSentAttachments,
} from "./mail.ts";

const idOf = (req: any) => z.string().uuid().parse(req.params.id);
export async function bootstrapDB() {
  await migrate();
  if (!(await get("settings", "connections"))) await saveSettings({});
  if (!(await get("user", "admin"))) {
    if (!process.env.ADMIN_PASSWORD) throw new Error("请配置 ADMIN_PASSWORD");
    await save("user", {
      id: "admin",
      username: process.env.ADMIN_USERNAME || "admin",
      passwordHash: passwordHash(process.env.ADMIN_PASSWORD),
    });
  }
  if (!(await all("template")).length) {
    await save("template", {
      name: "新单 · 材料交付",
      kind: "new",
      isDefault: true,
      subject: "{{软件名称}}｜材料交付",
      html: "<p>{{客户称呼}}，您好：</p><p>《<strong>{{软件名称}}</strong>》的材料已经整理完成，请查收附件压缩包。</p><p><strong>使用前请注意：</strong></p><ul><li>请先下载并解压附件，核对软件名称及相关信息。</li><li>如需调整，或后续收到补正通知，请将具体要求发给我。</li><li>请妥善保存本次材料。</li></ul><p>感谢您的信任。</p>",
    });
    await save("template", {
      name: "补正 · 更新材料",
      kind: "correction",
      isDefault: true,
      subject: "{{软件名称}}｜补正材料更新",
      html: '<p>{{客户称呼}}，您好：</p><p>本次补正材料已完成，请查收附件。当前软件名称：<strong>{{软件名称}}</strong>。</p><p><span style="color:#b42318"><strong>请以本次发送的版本为准，避免与旧文件混用。</strong></span></p><p>请核对材料与补正要求；如有其他问题，随时联系我。</p>',
    });
  }
}
export async function buildApp({
  workers = false,
  initialize = true,
}: { workers?: boolean; initialize?: boolean } = {}) {
  if (initialize) await bootstrapDB();
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { files: 20, fileSize: 110 * 1024 * 1024, fields: 10 },
  });
  app.setErrorHandler((error: any, req, reply) => {
    const status = error instanceof ZodError ? 400 : error.statusCode || 500;
    reply.code(status).send({
      error:
        status >= 500 && !error.statusCode
          ? "服务暂时不可用，请检查数据库连接后重试"
          : error instanceof ZodError
            ? "输入格式不正确：" +
              error.issues
                .map((x: any) => x.path.join(".") + " " + x.message)
                .join("；")
            : error.message,
    });
    if (status >= 500)
      console.error("API error", req.url, error.code || error.name);
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "DENY");
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-workbench"] !== "1"
    )
      throw new AppError(403, "请从系统页面发起操作");
    if (
      ["/api/v1/login", "/api/v1/session", "/api/v1/health"].some(
        (p) => req.url.split("?")[0] === p,
      )
    )
      return;
    const token = req.cookies.workbench_session;
    if (!token) throw new AppError(401, "请先登录");
    const [rows] = await pool.query<any[]>(
      "SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP(3)",
      [hash(token)],
    );
    if (!rows.length) throw new AppError(401, "登录已过期，请重新登录");
  });
  app.get("/api/v1/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });
  app.get("/api/v1/session", async (req) => {
    const token = req.cookies.workbench_session;
    if (!token) return { authenticated: false };
    const [rows] = await pool.query<any[]>(
      "SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP(3)",
      [hash(token)],
    );
    return { authenticated: !!rows.length };
  });
  app.post(
    "/api/v1/login",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (req, reply) => {
      const b = z
        .object({
          username: z.string().max(100),
          password: z.string().max(200),
        })
        .parse(req.body);
      const u = await get("user", "admin");
      if (
        !u ||
        u.username !== b.username ||
        !checkPassword(b.password, u.passwordHash)
      )
        throw new AppError(401, "账号或密码不正确");
      const token = randomBytes(32).toString("hex");
      await pool.query("INSERT INTO sessions VALUES (?,?)", [
        hash(token),
        new Date(Date.now() + 7 * 86400000),
      ]);
      reply.setCookie("workbench_session", token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.COOKIE_SECURE === "true",
        maxAge: 7 * 86400,
      });
      return { ok: true };
    },
  );
  app.post("/api/v1/logout", async (req, reply) => {
    if (req.cookies.workbench_session)
      await pool.query("DELETE FROM sessions WHERE token_hash=?", [
        hash(req.cookies.workbench_session),
      ]);
    reply.clearCookie("workbench_session", { path: "/" });
    return { ok: true };
  });
  app.post("/api/v1/password", async (req) => {
    const b = z
      .object({ current: z.string(), next: z.string().min(10).max(200) })
      .parse(req.body);
    const u = (await get("user", "admin"))!;
    if (!checkPassword(b.current, u.passwordHash))
      throw new AppError(400, "当前密码不正确");
    await save("user", { ...u, passwordHash: passwordHash(b.next) });
    await pool.query("DELETE FROM sessions");
    return { ok: true };
  });
  app.get("/api/v1/bootstrap", async () => {
    const [tasks, customers, templates, deliveries, intakes] =
      await Promise.all([
        all("task"),
        all("customer"),
        all("template"),
        all("delivery"),
        all("intake"),
      ]);
    return {
      tasks: withReworkStatus(tasks),
      customers,
      templates,
      deliveries,
      intakes: intakes.map(({ result, draft, ...rest }) => rest),
      settings: publicSettings(await settings()),
    };
  });
  app.delete("/api/v1/deliveries/:id", async (req) => {
    const body = z
      .object({ revision: z.number().int().positive() })
      .parse(req.body);
    return transaction(async (c) => {
      const d = await get("delivery", idOf(req), c, true);
      if (!d) throw new AppError(404, "交付记录不存在");
      if (["queued", "sending"].includes(d.status))
        throw new AppError(409, "正在等待发送或发送中的记录不能删除");
      await save(
        "delivery",
        { ...d, deletedAt: new Date().toISOString() },
        body.revision,
        c,
        "删除交付记录",
      );
      return { ok: true };
    });
  });
  app.post("/api/v1/tasks", async (req) => ({
    tasks: await createTasks(req.body),
  }));
  app.post("/api/v1/tasks/contact-group", async (req) =>
    patchContactGroup(req.body),
  );
  app.patch("/api/v1/tasks/:id", async (req) => {
    z.object({ revision: z.number().int().positive() }).parse(req.body);
    return patchTask(idOf(req), req.body);
  });
  app.post("/api/v1/tasks/:id/supplement", async (req) =>
    supplementTask(idOf(req), req.body),
  );
  app.post("/api/v1/tasks/:id/link", async (req) => {
    const b = z
      .object({
        parentId: z.string().uuid().nullable(),
        revision: z.number().int(),
      })
      .parse(req.body);
    return linkTask(idOf(req), b.parentId, b.revision);
  });
  app.post("/api/v1/tasks/:id/external", async (req) =>
    markExternal(idOf(req), req.body),
  );
  app.post("/api/v1/tasks/:id/cancel-correction", async (req) => {
    const b = z
      .object({ revision: z.number().int().positive() })
      .parse(req.body);
    return cancelCorrection(idOf(req), b.revision);
  });
  app.post("/api/v1/tasks/:id/reopen", async (req) =>
    transaction(async (c) => {
      const id = idOf(req),
        t = await get<Task>("task", id, c, true);
      if (!t) throw new AppError(404, "任务不存在");
      await assertOperable(t, c);
      const b = z.object({ revision: z.number().int() }).parse(req.body);
      if (
        (await all("delivery", c)).some(
          (d) => d.taskId === id && ["queued", "sending"].includes(d.status),
        )
      )
        throw new AppError(409, "发送中的任务不能修改状态");
      return save(
        "task",
        { ...t, completed: false, completedAt: null, completionMethod: "" },
        b.revision,
        c,
        "重新打开",
      );
    }),
  );
  app.get("/api/v1/tasks/:id/detail", async (req) => {
    const id = idOf(req);
    const [task, [audits], mailDraft, attachments, deliveries] =
      await Promise.all([
        get<Task>("task", id),
        pool.query<any[]>(
          "SELECT id,action,before_data,after_data,created_at FROM audit_log WHERE kind=? AND record_id=? ORDER BY id DESC LIMIT 100",
          ["task", id],
        ),
        get("maildraft", id),
        recordsForTask("attachment", id),
        recordsForTask("delivery", id),
      ]);
    if (!task) throw new AppError(404, "任务不存在");
    const reusableAttachments = (
      await Promise.all(
        (mailDraft?.attachmentIds || []).map((fileId: string) =>
          get("templatefile", fileId),
        ),
      )
    )
      .filter(Boolean)
      .map((f: any) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        persistent: true,
      }));
    return {
      task,
      audits,
      mailDraft,
      reusableAttachments,
      attachments,
      deliveries,
    };
  });
  app.post("/api/v1/candidates", async (req) =>
    candidateMatches(await all<Task>("task"), req.body),
  );
  app.patch("/api/v1/customers/:id", async (req) => {
    const b = z
      .object({
        name: z.string().max(200),
        email: z.union([z.literal(""), z.email()]),
        wechat: z.string().max(200),
        memberName: z.string().max(200),
        notes: z.string().max(5000),
        revision: z.number().int(),
      })
      .parse(req.body);
    return save("customer", { id: idOf(req), ...b }, b.revision);
  });
  app.post("/api/v1/screenshots", async (req) => {
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== "file") continue;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of part.file) {
        size += chunk.length;
        if (size > 12 * 1024 * 1024)
          throw new AppError(413, "单张截图不能超过12MB");
        chunks.push(chunk);
      }
      if (part.file.truncated) throw new AppError(413, "图片过大");
      const data = Buffer.concat(chunks);
      let mime = "";
      if (
        data
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        mime = "image/png";
      else if (data[0] === 255 && data[1] === 216 && data[2] === 255)
        mime = "image/jpeg";
      else if (
        data.toString("ascii", 0, 4) === "RIFF" &&
        data.toString("ascii", 8, 12) === "WEBP"
      )
        mime = "image/webp";
      if (!mime) throw new AppError(400, "仅支持PNG、JPG和WebP图片");
      const digest = hash(data);
      const [prior] = await pool.query<any[]>(
        "SELECT id,name FROM screenshots WHERE hash=?",
        [digest],
      );
      const id = prior[0]?.id || randomUUID();
      if (!prior.length)
        await pool.query(
          "INSERT INTO screenshots(id,hash,name,mime,size,content,created_at) VALUES (?,?,?,?,?,?,?)",
          [
            id,
            digest,
            path.basename(part.filename).slice(0, 255),
            mime,
            size,
            data,
            new Date(),
          ],
        );
      out.push({
        id,
        name: prior[0]?.name || part.filename,
        mime,
        size,
        duplicate: !!prior.length,
      });
    }
    if (!out.length) throw new AppError(400, "请选择图片");
    return out;
  });
  app.get("/api/v1/screenshots/:id", async (req, reply) => {
    const [rows] = await pool.query<any[]>(
      "SELECT content,mime FROM screenshots WHERE id=?",
      [idOf(req)],
    );
    if (!rows.length) throw new AppError(404, "截图不存在");
    return reply.type(rows[0].mime).send(rows[0].content);
  });
  app.post("/api/v1/intakes", async (req) => {
    const b = z
      .object({ imageIds: z.array(z.string().uuid()).min(1).max(20) })
      .parse(req.body);
    for (const id of b.imageIds) {
      const [r] = await pool.query<any[]>(
        "SELECT id FROM screenshots WHERE id=?",
        [id],
      );
      if (!r.length) throw new AppError(404, "截图不存在");
    }
    return save("intake", {
      imageIds: [...new Set(b.imageIds)],
      status: "queued",
      result: null,
      draft: null,
      error: "",
    });
  });
  app.get("/api/v1/intakes/:id", async (req) => {
    const d = await get("intake", idOf(req));
    if (!d) throw new AppError(404, "录入草稿不存在");
    return d;
  });
  app.patch("/api/v1/intakes/:id", async (req) => {
    const old = await get("intake", idOf(req));
    if (!old) throw new AppError(404, "录入草稿不存在");
    return save("intake", { id: old.id, draft: (req.body as any).draft });
  });
  app.post("/api/v1/intakes/:id/retry", async (req) => {
    const d = await get("intake", idOf(req));
    if (!d || d.status === "saved")
      throw new AppError(400, "此录入记录不能重新识别");
    if (["processing", "queued"].includes(d.status)) return d;
    return save("intake", { id: d.id, status: "queued", error: "" });
  });
  app.post("/api/v1/tasks/:id/attachments", async (req) => {
    const taskId = idOf(req);
    if (!(await get("task", taskId))) throw new AppError(404, "任务不存在");
    const file = await req.file();
    if (!file) throw new AppError(400, "请选择文件");
    const id = randomUUID(),
      dest = attachmentPath(id);
    await mkdir(TEMP_DIR, { recursive: true, mode: 0o700 });
    try {
      await pipeline(file.file, createWriteStream(dest, { mode: 0o600 }));
      if (file.file.truncated)
        throw new AppError(413, "单个附件超过110MB，请自行处理");
      const s = await stat(dest);
      return await save("attachment", {
        id,
        taskId,
        name: path.basename(file.filename).slice(0, 240),
        size: s.size,
        status: "ready",
      });
    } catch (e) {
      await rm(dest, { force: true });
      throw e;
    }
  });
  app.delete("/api/v1/attachments/:id", async (req) => {
    const id = idOf(req),
      a = await get("attachment", id);
    if (!a) throw new AppError(404, "附件不存在");
    if (
      (await all("delivery")).some(
        (d) =>
          ["queued", "sending"].includes(d.status) &&
          d.attachments?.some((x: any) => x.id === id),
      )
    )
      throw new AppError(409, "附件正在发送中");
    await rm(attachmentPath(id), { force: true });
    await save("attachment", { id, status: "removed" });
    return { ok: true };
  });
  app.post("/api/v1/tasks/:id/send", async (req) =>
    queueMail(idOf(req), req.body),
  );
  app.post("/api/v1/template-files", async (req) => {
    const file = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!file) throw new AppError(400, "请选择模板附件");
    const content = await file.toBuffer();
    const saved = await save("templatefile", {
      name: path.basename(file.filename).slice(0, 240),
      size: content.length,
      content: content.toString("base64"),
    });
    return {
      id: saved.id,
      name: saved.name,
      size: saved.size,
      persistent: true,
    };
  });
  app.get("/api/v1/template-files/:id", async (req, reply) => {
    const file = await get("templatefile", idOf(req));
    if (!file) throw new AppError(404, "模板附件不存在");
    return reply
      .type("application/octet-stream")
      .header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
      )
      .send(Buffer.from(file.content, "base64"));
  });
  app.post("/api/v1/templates", async (req) => {
    const b = z
      .object({
        id: z.string().uuid().optional(),
        revision: z.number().int().optional(),
        name: z.string().min(1).max(120),
        kind: z.enum(["new", "correction", "all"]),
        isDefault: z.boolean(),
        subject: z.string().min(1).max(240),
        html: z.string().max(200000),
        attachments: z
          .array(z.object({ id: z.string().uuid() }))
          .max(10)
          .optional(),
      })
      .parse(req.body);
    return transaction(async (c) => {
      await lockTemplateCollection(c);
      if (b.isDefault)
        for (const t of await all("template", c))
          if (t.kind === b.kind && t.isDefault && t.id !== b.id)
            await save("template", { ...t, isDefault: false }, undefined, c);
      const attachments =
        b.attachments === undefined
          ? undefined
          : await Promise.all(
              b.attachments.map(async ({ id }) => {
                const file = await get("templatefile", id, c);
                if (!file)
                  throw new AppError(400, "模板附件不存在，请重新上传");
                return {
                  id,
                  name: file.name,
                  size: file.size,
                  persistent: true,
                };
              }),
            );
      return save(
        "template",
        {
          ...b,
          ...(attachments === undefined ? {} : { attachments }),
          html: cleanHtml(b.html),
        },
        b.revision,
        c,
      );
    });
  });
  app.delete("/api/v1/templates/:id", async (req) => {
    const id = idOf(req);
    await transaction(async (c) => {
      await lockTemplateCollection(c);
      const before = await get("template", id, c, true);
      if (!before) throw new AppError(404, "模板不存在");
      await c.query("DELETE FROM records WHERE kind=? AND id=?", [
        "template",
        id,
      ]);
      await c.query(
        "INSERT INTO audit_log(kind,record_id,action,before_data,created_at) VALUES (?,?,?,?,?)",
        ["template", id, "删除", JSON.stringify(before), new Date()],
      );
    });
    return { ok: true };
  });
  app.get("/api/v1/settings", async () => publicSettings(await settings()));
  app.post("/api/v1/settings", async (req) => saveSettings(req.body));
  app.post("/api/v1/settings/verify-mail", async () => {
    const t = await mailTransport();
    try {
      await t.verify();
      return { ok: true, message: "QQ邮箱连接和授权验证成功，未发送邮件" };
    } catch (e: any) {
      throw new AppError(
        400,
        "邮箱连接失败：" + String(e.message).slice(0, 300),
      );
    } finally {
      t.close();
    }
  });
  app.get("/api/v1/export", async (req, reply) => {
    reply.header(
      "Content-Disposition",
      'attachment; filename="workbench-backup.json"',
    );
    return exportBackup();
  });
  app.patch("/api/v1/tasks/:id/maildraft", async (req) => {
    const id = idOf(req);
    if (!(await get("task", id))) throw new AppError(404, "任务不存在");
    const b = z
      .object({
        to: z.string().max(320),
        subject: z.string().max(240),
        html: z.string().max(200000),
        attachments: z
          .array(z.object({ id: z.string().uuid() }))
          .max(10)
          .optional(),
        attachmentIds: z.array(z.string().uuid()).max(10),
      })
      .parse(req.body);
    return save("maildraft", { id, ...b, html: cleanHtml(b.html) });
  });
  await registerTaskHistoryRoutes(app);
  registerMailboxRoutes(app);
  await registerAssistantRoutes(app);
  if (existsSync(path.resolve("dist"))) {
    await app.register(staticFiles, {
      root: path.resolve("dist"),
      setHeaders(reply, file) {
        if (path.basename(file) === "index.html")
          reply.header("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/"))
        return reply.code(404).send({ error: "接口不存在" });
      const pathname = req.url.split("?")[0];
      if (pathname.startsWith("/assets/") || path.extname(pathname))
        return reply.code(404).send({ error: "文件不存在" });
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
  }
  if (workers) {
    await recoverAssistant();
    await recoverMailbox();
    for (const d of await all("delivery")) {
      if (d.status === "sending")
        await save("delivery", {
          id: d.id,
          status: "uncertain",
          error: "上次发送过程中服务中断，请核对QQ邮箱已发送记录",
        });
      if (d.status === "sent") await cleanSentAttachments(d).catch(() => {});
    }
    for (const j of await all("intake"))
      if (j.status === "processing")
        await save("intake", { id: j.id, status: "queued" });
    const timer = setInterval(() => {
      void tickAI().catch(() => {});
      void tickMail().catch(() => {});
      void tickAssistant().catch(() => {});
      void tickMailbox().catch(() => {});
    }, 1500);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
  return app;
}
