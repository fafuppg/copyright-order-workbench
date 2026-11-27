import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, get, save, transaction } from "./db.ts";
import { settings, cleanHtml, cleanMailboxHtml } from "./security.ts";
import { AppError, type Doc } from "./types.ts";
import {
  ImapMailboxProvider,
  type MailboxProvider,
  type MailboxConfig,
  type MailFolder,
  type FolderSnapshot,
  type RemoteMessage,
  type RemoteFolder,
  type MessageRange,
} from "./mailbox-provider.ts";

export const MAILBOX_BATCH = 25;
const UID_WINDOW = 500;
const SYNC_INTERVAL = 5 * 60 * 1000;
const CONTINUE_INTERVAL = 10 * 1000;
const ERROR_RETRY = 60 * 1000;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// The application has always written this deterministic ID into its compiled MIME.
export const outgoingMimeMessageId = (deliveryId: string) =>
  `<${deliveryId}@copyright-workbench.local>`;
export function outgoingMessageIds(delivery: {
  id: string;
  messageId?: string;
}) {
  return [
    ...new Set(
      [outgoingMimeMessageId(delivery.id), delivery.messageId].filter(
        (value): value is string => !!value,
      ),
    ),
  ];
}
export const mailboxAccountId = (c: MailboxConfig) =>
  digest(`${c.host.toLowerCase()}:${c.port}:${c.user.toLowerCase()}`);
export const mailboxMessageId = (
  accountId: string,
  path: string,
  uidValidity: string,
  uid: number,
) => digest(`${accountId}\n${path}\n${uidValidity}\n${uid}`);
export function mailboxConfig(c: any): MailboxConfig {
  return {
    host: c.imapHost || "imap.qq.com",
    port: Number(c.imapPort || 993),
    user: c.imapUser || c.smtpUser || "",
    password: c.imapPassword || c.smtpPassword || "",
    autoSync: c.autoSync !== false,
  };
}
export function mailboxError(error: any): string {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (
    /auth|login|credentials|authorization/i.test(code + message) ||
    error?.authenticationFailed
  )
    return "QQ邮箱登录失败，请确认已开启IMAP服务，并填写邮箱授权码。";
  if (/UIDVALIDITY_CHANGED/.test(message))
    return "邮箱目录发生变化，请重新同步后再操作。";
  if (/MESSAGE_NOT_FOUND/.test(message))
    return "邮件已从QQ邮箱移动或删除，请重新同步。";
  if (/READ_STATE_UNCONFIRMED/.test(message))
    return "邮箱未确认已读状态，请同步后核对再重试。";
  if (/ECONN|ETIMEDOUT|ENOTFOUND|ETIMEOUT|socket|timeout/i.test(code + message))
    return "暂时无法连接QQ邮箱，稍后会自动重试，也可点击立即同步。";
  return "邮箱操作暂未完成，请检查IMAP设置后重试。";
}
export type FolderCursor = RemoteFolder & {
  uidValidity: string;
  lastUid: number;
  beforeUid: number;
  exists: number;
  synced: number;
  hasMore: boolean;
  refreshAfterId?: string;
  lastSyncAt?: string;
};
export interface MailboxStore {
  state(): Promise<any>;
  saveState(value: any): Promise<any>;
  message(id: string): Promise<any>;
  upsert(value: any): Promise<any>;
  scanMessages(
    accountId: string,
    path: string,
    afterId: string,
    limit: number,
  ): Promise<any[]>;
}
function decode(row: any) {
  const value =
    typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return { ...value, id: row.id, revision: row.revision };
}
export const mysqlMailboxStore: MailboxStore = {
  state: () => get("mailboxstate", "main"),
  saveState: (value) =>
    save(
      "mailboxstate",
      { ...value, id: "main" },
      undefined,
      undefined,
      "邮箱同步状态",
    ),
  message: (id) => get("mailmessage", id),
  async scanMessages(accountId, path, afterId, limit) {
    const [rows] = await pool.query<any[]>(
      "SELECT id,JSON_REMOVE(payload,'$.text','$.html','$.attachments') AS payload,revision FROM records WHERE kind='mailmessage' AND id>? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.accountId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.remotePath'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source'))='imap' AND JSON_EXTRACT(payload,'$.duplicateOf') IS NULL ORDER BY id LIMIT ?",
      [afterId, accountId, path, limit],
    );
    return rows.map(decode);
  },
  async upsert(value) {
    return transaction(async (c) => {
      const previous = await get("mailmessage", value.id, c, true);
      const merged = {
        ...previous,
        ...value,
        taskIds: [
          ...new Set([...(previous?.taskIds || []), ...(value.taskIds || [])]),
        ],
      };
      // A remotely synced Sent copy replaces its local delivery summary in lists.
      if (value.source === "imap" && value.messageId) {
        const [duplicates] = await c.query<any[]>(
          "SELECT id,payload,revision FROM records WHERE kind='mailmessage' AND id<>? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.accountId'))=? AND (JSON_UNQUOTE(JSON_EXTRACT(payload,'$.messageId'))=? OR (JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source'))='local' AND (JSON_CONTAINS(JSON_EXTRACT(payload,'$.messageIdAliases'),JSON_QUOTE(?)) OR CONCAT('<',JSON_UNQUOTE(JSON_EXTRACT(payload,'$.deliveryId')),'@copyright-workbench.local>')=?))) AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.folder'))=? AND (JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source'))='local' OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.remoteUidValidity'))<>?) FOR UPDATE",
          [
            value.id,
            value.accountId,
            value.messageId,
            value.messageId,
            value.messageId,
            value.folder,
            value.remoteUidValidity,
          ],
        );
        for (const row of duplicates) {
          const duplicate = decode(row);
          merged.taskIds = [
            ...new Set([...merged.taskIds, ...(duplicate.taskIds || [])]),
          ];
          if (duplicate.duplicateOf !== value.id)
            await save(
              "mailmessage",
              { id: row.id, duplicateOf: value.id },
              undefined,
              c,
              "合并邮箱副本",
            );
        }
      }
      if (value.source === "local" && value.messageId) {
        const messageIds: string[] = [
          ...new Set([value.messageId, ...(value.messageIdAliases || [])]),
        ];
        const [matches] = await c.query<any[]>(
          `SELECT id,payload,revision FROM records WHERE kind='mailmessage' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.accountId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.messageId')) IN (${messageIds.map(() => "?").join(",")}) AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.folder'))='sent' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.source'))='imap' AND JSON_EXTRACT(payload,'$.duplicateOf') IS NULL ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
          [value.accountId, ...messageIds],
        );
        if (matches.length) {
          const remote = decode(matches[0]);
          const taskIds = [
            ...new Set([...(remote.taskIds || []), ...merged.taskIds]),
          ];
          if (JSON.stringify(taskIds) !== JSON.stringify(remote.taskIds))
            await save(
              "mailmessage",
              { id: remote.id, taskIds },
              undefined,
              c,
              "关联本系统发送任务",
            );
          merged.duplicateOf = remote.id;
        }
      }
      const unchanged =
        previous &&
        Object.entries(merged).every(
          ([key, item]) =>
            JSON.stringify(previous[key]) === JSON.stringify(item),
        );
      return unchanged
        ? previous
        : save("mailmessage", merged, undefined, c, "同步邮件");
    });
  },
};
export type MailboxServiceOptions = {
  store?: MailboxStore;
  config?: () => Promise<MailboxConfig>;
  provider?: (c: MailboxConfig) => MailboxProvider;
  now?: () => number;
};

/** One bounded UID window; empty gaps advance without searching an entire mailbox. */
export function planFolder(snapshot: FolderSnapshot, previous?: FolderCursor) {
  const reset = !previous || previous.uidValidity !== snapshot.uidValidity;
  if (reset)
    return {
      reset,
      initial: {
        start: Math.max(1, snapshot.exists - MAILBOX_BATCH + 1),
        end: snapshot.exists,
        uid: false,
      } as MessageRange,
    };
  return {
    reset,
    newer: {
      start: previous.lastUid + 1,
      end: Math.min(snapshot.uidNext - 1, previous.lastUid + UID_WINDOW),
      uid: true,
    } as MessageRange,
    older: {
      start: Math.max(1, previous.beforeUid - UID_WINDOW),
      end: previous.beforeUid - 1,
      uid: true,
    } as MessageRange,
  };
}
export function createMailboxService(options: MailboxServiceOptions = {}) {
  const store = options.store || mysqlMailboxStore;
  const config =
    options.config || (async () => mailboxConfig(await settings()));
  const providerFactory =
    options.provider || ((c) => new ImapMailboxProvider(c));
  const now = options.now || Date.now;
  let busy = false;
  let nextCheck = 0;
  const configured = (c: MailboxConfig) => !!(c.user && c.password);
  async function verify() {
    const c = await config();
    if (!configured(c)) throw new AppError(400, "请先保存QQ邮箱账号和授权码。");
    const provider = providerFactory(c);
    try {
      await provider.connect();
      const folders = await provider.folders();
      if (!folders.some((x) => x.folder === "inbox"))
        throw new Error("INBOX_NOT_FOUND");
      return {
        ok: true,
        account: c.user,
        folders,
        warning: folders.some((x) => x.folder === "sent")
          ? ""
          : "未找到已发送文件夹，仍可查看本系统发送记录。",
      };
    } catch (error) {
      throw new AppError(502, mailboxError(error));
    } finally {
      await provider.close().catch(() => {});
    }
  }
  async function queue() {
    const c = await config();
    if (!configured(c)) throw new AppError(400, "请先保存QQ邮箱账号和授权码。");
    if (busy) return { status: "syncing" };
    const state = await store.state();
    const accountId = mailboxAccountId(c);
    await store.saveState({
      ...(state?.accountId !== accountId
        ? { folders: [], lastSyncAt: null, hasMore: false }
        : {}),
      accountId,
      requested: true,
      manualRun: true,
      status: "queued",
      lastError: "",
    });
    nextCheck = 0;
    return { status: "queued" };
  }
  async function synchronize() {
    if (busy) return;
    busy = true;
    let provider: MailboxProvider | undefined;
    let state: any;
    try {
      const c = await config();
      if (!configured(c)) return;
      state = (await store.state()) || {};
      const accountId = mailboxAccountId(c);
      if (state.accountId !== accountId)
        state = { ...state, accountId, folders: [], lastSyncAt: null };
      state = await store.saveState({
        ...state,
        status: "syncing",
        requested: false,
        startedAt: new Date(now()).toISOString(),
        lastError: "",
      });
      provider = providerFactory(c);
      await provider.connect();
      const folders = await provider.folders();
      if (!folders.some((x) => x.folder === "inbox"))
        throw new Error("INBOX_NOT_FOUND");
      const cursors: FolderCursor[] = [...(state.folders || [])].filter((x) =>
        folders.some((f) => f.folder === x.folder && f.path === x.path),
      );
      for (const folder of folders) {
        const snapshot = await provider.inspect(folder.path);
        const prior = cursors.find(
          (x) => x.folder === folder.folder && x.path === folder.path,
        );
        const plan = planFolder(snapshot, prior);
        let cursor: FolderCursor = {
          ...folder,
          uidValidity: snapshot.uidValidity,
          lastUid: 0,
          beforeUid: 1,
          exists: snapshot.exists,
          synced: 0,
          hasMore: false,
          ...(plan.reset ? {} : prior),
        };
        cursor.exists = snapshot.exists;
        async function ingest(rows: RemoteMessage[], fetchUnknown: boolean) {
          for (const remote of rows) {
            const id = mailboxMessageId(
              accountId,
              folder.path,
              snapshot.uidValidity,
              remote.uid,
            );
            const old = await store.message(id);
            if (!old && !fetchUnknown) continue;
            if (old) {
              if (old.read !== remote.read || old.remoteMissing)
                await store.upsert({
                  id,
                  read: remote.read,
                  remoteMissing: false,
                });
              continue;
            }
            const body = await provider!.body(
              folder.path,
              remote,
              snapshot.uidValidity,
            );
            const { structure: _structure, uid, ...meta } = remote;
            await store.upsert({
              id,
              accountId,
              source: "imap",
              folder: folder.folder,
              remotePath: folder.path,
              remoteUid: uid,
              remoteUidValidity: snapshot.uidValidity,
              remoteMissing: false,
              ...meta,
              ...body,
              html: cleanMailboxHtml(body.html),
              snippet: body.text.replace(/\s+/g, " ").slice(0, 200),
              taskIds: [],
            });
          }
        }
        if (plan.reset) {
          const rows = (await provider.list(folder.path, plan.initial!)).sort(
            (a, b) => a.uid - b.uid,
          );
          await ingest(rows, true);
          cursor.synced = rows.length;
          cursor.lastUid = Math.max(0, snapshot.uidNext - 1);
          cursor.beforeUid =
            snapshot.exists > rows.length && rows.length ? rows[0].uid : 1;
        } else {
          const newRows = (await provider.list(folder.path, plan.newer!)).sort(
            (a, b) => a.uid - b.uid,
          );
          const selectedNew = newRows.slice(0, MAILBOX_BATCH);
          await ingest(selectedNew, true);
          if (plan.newer!.start <= plan.newer!.end)
            cursor.lastUid =
              newRows.length > selectedNew.length
                ? selectedNew.at(-1)!.uid
                : plan.newer!.end;
          const oldRows = (await provider.list(folder.path, plan.older!)).sort(
            (a, b) => b.uid - a.uid,
          );
          const selectedOld = oldRows.slice(0, MAILBOX_BATCH);
          await ingest(selectedOld, true);
          cursor.synced += selectedNew.length + selectedOld.length;
          if (plan.older!.end >= 1)
            cursor.beforeUid =
              oldRows.length > selectedOld.length
                ? selectedOld.at(-1)!.uid
                : plan.older!.start;
          // Refresh recent remote flags without reading bodies or changing QQ read state.
          const recent = await provider.list(folder.path, {
            start: Math.max(1, snapshot.exists - MAILBOX_BATCH + 1),
            end: snapshot.exists,
            uid: false,
          });
          await ingest(recent, false);
        }
        // Cycle through every stored message, not only the newest screen. This detects
        // read changes, moved/deleted mail and invalidated generations without deleting history.
        const auditRows = await store.scanMessages(
          accountId,
          folder.path,
          cursor.refreshAfterId || "",
          100,
        );
        const currentRows = auditRows.filter(
          (x) => x.remoteUidValidity === snapshot.uidValidity,
        );
        const remoteFlags = new Map(
          (
            await provider.flags(
              folder.path,
              currentRows.map((x) => x.remoteUid),
              snapshot.uidValidity,
            )
          ).map((x) => [x.uid, x.read]),
        );
        for (const saved of auditRows) {
          const remoteMissing =
            saved.remoteUidValidity !== snapshot.uidValidity ||
            !remoteFlags.has(saved.remoteUid);
          const read = remoteMissing
            ? saved.read
            : remoteFlags.get(saved.remoteUid);
          if (!!saved.remoteMissing !== remoteMissing || saved.read !== read)
            await store.upsert({ id: saved.id, remoteMissing, read });
        }
        cursor.refreshAfterId =
          auditRows.length === 100 ? auditRows.at(-1)!.id : "";
        cursor.hasMore =
          cursor.beforeUid > 1 || cursor.lastUid < snapshot.uidNext - 1;
        cursor.lastSyncAt = new Date(now()).toISOString();
        const index = cursors.findIndex((x) => x.folder === folder.folder);
        if (index === -1) cursors.push(cursor);
        else cursors[index] = cursor;
        state = await store.saveState({ accountId, folders: cursors });
      }
      const hasMore = cursors.some((x) => x.hasMore);
      const warning = folders.some((x) => x.folder === "sent")
        ? ""
        : "未找到QQ已发送文件夹，已发送列表仍显示本系统交付记录。";
      await store.saveState({
        status: "idle",
        hasMore,
        lastSyncAt: new Date(now()).toISOString(),
        lastError: "",
        warning,
        requested: false,
        manualRun: hasMore && !!state.manualRun,
      });
      nextCheck = now() + (hasMore ? CONTINUE_INTERVAL : SYNC_INTERVAL);
    } catch (error) {
      await store
        .saveState({
          status: "error",
          lastError: mailboxError(error),
          requested: false,
        })
        .catch(() => {});
      nextCheck = now() + ERROR_RETRY;
    } finally {
      if (provider) await provider.close().catch(() => {});
      busy = false;
    }
  }
  async function tick() {
    if (busy || now() < nextCheck) return;
    // Throttle settings reads between worker ticks; a manual request resets this immediately.
    nextCheck = now() + 10000;
    const c = await config();
    const state = await store.state();
    if (
      !configured(c) ||
      (!c.autoSync && !state?.requested && !state?.manualRun)
    )
      return;
    await synchronize();
  }
  async function recover() {
    const state = await store.state();
    if (state && ["syncing", "queued"].includes(state.status))
      await store.saveState({
        status: "idle",
        requested: true,
        lastError: "上次同步中断，将从已保存进度继续。",
      });
    nextCheck = 0;
  }
  async function changeRead(id: string, read: boolean, revision: number) {
    if (busy) throw new AppError(409, "邮箱正在同步，请稍后再修改已读状态。");
    busy = true;
    let provider: MailboxProvider | undefined;
    try {
      const existing = await store.message(id);
      if (!existing) throw new AppError(404, "邮件不存在");
      if (existing.revision !== revision)
        throw new AppError(409, "邮件已更新，请刷新后重试。");
      if (existing.source !== "imap")
        throw new AppError(400, "本系统发送记录默认已读，无需修改QQ邮箱状态。");
      const c = await config();
      if (existing.accountId !== mailboxAccountId(c))
        throw new AppError(
          409,
          "这封邮件属于之前的邮箱账号，请切换回对应账号后操作。",
        );
      provider = providerFactory(c);
      await provider.connect();
      await provider.setRead(
        existing.remotePath,
        existing.remoteUid,
        existing.remoteUidValidity,
        read,
      );
      return await store.upsert({ id, read });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, mailboxError(error));
    } finally {
      if (provider) await provider.close().catch(() => {});
      busy = false;
    }
  }
  return { verify, queue, synchronize, tick, recover, changeRead };
}
const service = createMailboxService();

export type MailboxQuery = {
  folder?: string;
  q?: string;
  page?: number | string;
  pageSize?: number | string;
  unread?: boolean | string;
  taskId?: string;
};
async function mailboxFilter(query: MailboxQuery = {}) {
  const c = mailboxConfig(await settings());
  const clauses = [
    "kind='mailmessage'",
    "JSON_UNQUOTE(JSON_EXTRACT(payload,'$.accountId'))=?",
    "JSON_EXTRACT(payload,'$.duplicateOf') IS NULL",
  ];
  const values: any[] = [mailboxAccountId(c)];
  if (query.folder && query.folder !== "all") {
    if (!["inbox", "sent"].includes(query.folder))
      throw new AppError(400, "邮件文件夹无效");
    clauses.push("JSON_UNQUOTE(JSON_EXTRACT(payload,'$.folder'))=?");
    values.push(query.folder);
  }
  if (query.unread === true || query.unread === "true")
    clauses.push("JSON_EXTRACT(payload,'$.read')=false");
  if (query.taskId) {
    clauses.push(
      "JSON_CONTAINS(JSON_EXTRACT(payload,'$.taskIds'),JSON_QUOTE(?))",
    );
    values.push(String(query.taskId).slice(0, 64));
  }
  const q = String(query.q || "")
    .trim()
    .slice(0, 200);
  if (q) {
    clauses.push(
      "CONCAT_WS(' ',JSON_UNQUOTE(JSON_EXTRACT(payload,'$.subject')),JSON_UNQUOTE(JSON_EXTRACT(payload,'$.text')),JSON_EXTRACT(payload,'$.from'),JSON_EXTRACT(payload,'$.to'),JSON_EXTRACT(payload,'$.attachments')) LIKE ? ESCAPE '='",
    );
    values.push(`%${q.replace(/[=%_]/g, (x) => "=" + x)}%`);
  }
  return { where: clauses.join(" AND "), values };
}
export async function listMailboxMessages(query: MailboxQuery = {}) {
  const page = Math.max(1, Math.min(100000, Number(query.page) || 1)) | 0;
  const pageSize = Math.max(1, Math.min(100, Number(query.pageSize) || 30)) | 0;
  const { where, values } = await mailboxFilter(query);
  const [rows] = await pool.query<any[]>(
    `SELECT id,JSON_REMOVE(payload,'$.text','$.html') AS payload,revision FROM records WHERE ${where} ORDER BY JSON_UNQUOTE(JSON_EXTRACT(payload,'$.date')) DESC,id DESC LIMIT ? OFFSET ?`,
    [...values, pageSize, (page - 1) * pageSize],
  );
  const [count] = await pool.query<any[]>(
    `SELECT COUNT(*) AS total FROM records WHERE ${where}`,
    values,
  );
  return {
    items: rows.map(decode),
    total: Number(count[0].total),
    page,
    pageSize,
  };
}
export async function getMailboxMessage(id: string) {
  const message = await get("mailmessage", id);
  if (!message) throw new AppError(404, "邮件不存在");
  if (message.duplicateOf) return getMailboxMessage(message.duplicateOf);
  return message;
}
export async function mailboxSummary() {
  const { where, values } = await mailboxFilter();
  const [rows] = await pool.query<any[]>(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.folder')) AS folder,COUNT(*) AS total,SUM(JSON_EXTRACT(payload,'$.read')=false) AS unread FROM records WHERE ${where} GROUP BY folder`,
    values,
  );
  return {
    inbox: Number(rows.find((x) => x.folder === "inbox")?.total || 0),
    sent: Number(rows.find((x) => x.folder === "sent")?.total || 0),
    unread: rows.reduce((sum, x) => sum + Number(x.unread || 0), 0),
  };
}
export async function mailboxStatus() {
  const c = mailboxConfig(await settings());
  const stored = await get("mailboxstate", "main");
  const state = stored?.accountId === mailboxAccountId(c) ? stored : null;
  return {
    configured: !!(c.user && c.password),
    account: c.user,
    address: c.user,
    autoSync: c.autoSync,
    status: state?.status || "idle",
    lastSyncAt: state?.lastSyncAt || null,
    lastError: state?.lastError || "",
    warning: state?.warning || "",
    hasMore: !!state?.hasMore,
    folders: state?.folders || [],
    historyRemaining: (state?.folders || []).reduce(
      (sum: number, x: FolderCursor) =>
        sum + (x.hasMore ? Math.max(0, x.exists - x.synced) : 0),
      0,
    ),
    counts: await mailboxSummary(),
  };
}
export async function linkMailboxMessage(
  id: string,
  taskIds: string[],
  revision: number,
) {
  return transaction(async (c) => {
    const old = await get("mailmessage", id, c, true);
    if (!old) throw new AppError(404, "邮件不存在");
    if (old.duplicateOf) throw new AppError(409, "邮件已合并，请刷新后关联。");
    if (old.revision !== revision)
      throw new AppError(409, "邮件已更新，请刷新后重新关联。");
    for (const taskId of [...new Set(taskIds)].sort()) {
      if (!(await get("task", taskId, c)))
        throw new AppError(400, "关联的任务不存在");
    }
    return save(
      "mailmessage",
      { id, taskIds: [...new Set(taskIds)] },
      revision,
      c,
      "关联邮件与任务",
    );
  });
}
/** Only delivery metadata and already-saved text; attachment bytes are never read. */
export async function recordOutgoingMail(delivery: any) {
  if (delivery?.status !== "sent" || !delivery.id) return null;
  const id = digest(`local-delivery:${delivery.id}`);
  const existing = await get("mailmessage", id);
  if (existing?.messageIdentityVersion === 1) return existing;
  const identity = {
    messageId: outgoingMimeMessageId(delivery.id),
    messageIdAliases: outgoingMessageIds(delivery),
    messageIdentityVersion: 1,
  };
  if (existing)
    return mysqlMailboxStore.upsert({
      ...existing,
      ...identity,
      taskIds: [
        ...new Set([
          ...(existing.taskIds || []),
          ...(delivery.taskId ? [delivery.taskId] : []),
        ]),
      ],
    });
  const c = await settings();
  const conf = mailboxConfig(c);
  const html = cleanHtml(String(delivery.html || ""));
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return mysqlMailboxStore.upsert({
    id,
    source: "local",
    accountId: mailboxAccountId(conf),
    folder: "sent",
    deliveryId: delivery.id,
    ...identity,
    subject: delivery.subject || "（无主题）",
    from: [{ name: "软著材料交付", address: c.smtpUser }],
    to: [{ name: delivery.customerName || "", address: delivery.to }],
    cc: [],
    date: delivery.sentAt || delivery.updatedAt,
    read: true,
    text,
    html,
    snippet: text.slice(0, 200),
    taskIds: delivery.taskId ? [delivery.taskId] : [],
    attachments: (delivery.attachments || []).map((a: any) => ({
      filename: a.name,
      size: a.size,
      contentType: "application/octet-stream",
      contentId: "",
      part: "",
    })),
    bodyTruncated: false,
    remoteMissing: false,
  });
}
let lastOutgoingCheck = 0;
async function seedOutgoingMail() {
  if (Date.now() - lastOutgoingCheck < 10000) return;
  lastOutgoingCheck = Date.now();
  const [rows] = await pool.query<any[]>(
    "SELECT d.id,d.payload,d.revision FROM records d WHERE d.kind='delivery' AND JSON_UNQUOTE(JSON_EXTRACT(d.payload,'$.status'))='sent' AND NOT EXISTS (SELECT 1 FROM records m WHERE m.kind='mailmessage' AND m.id=SHA2(CONCAT('local-delivery:',d.id),256) AND JSON_EXTRACT(m.payload,'$.messageIdentityVersion')=1) ORDER BY d.updated_at DESC LIMIT 25",
  );
  for (const row of rows) await recordOutgoingMail(decode(row));
}
export async function tickMailbox() {
  await seedOutgoingMail();
  await service.tick();
}
export async function recoverMailbox() {
  await service.recover();
}
export function registerMailboxRoutes(app: FastifyInstance) {
  app.get("/api/v1/mailbox/status", mailboxStatus);
  app.post("/api/v1/mailbox/verify", () => service.verify());
  app.post("/api/v1/mailbox/sync", () => service.queue());
  app.get("/api/v1/mailbox/messages", (req) =>
    listMailboxMessages(req.query as MailboxQuery),
  );
  app.get<{ Params: { id: string } }>("/api/v1/mailbox/messages/:id", (req) =>
    getMailboxMessage(req.params.id),
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/mailbox/messages/:id/read",
    (req) => {
      const input = z
        .object({ read: z.boolean(), revision: z.number().int().positive() })
        .parse(req.body);
      return service.changeRead(req.params.id, input.read, input.revision);
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/v1/mailbox/messages/:id/link",
    (req) => {
      const input = z
        .object({
          taskIds: z.array(z.string().min(1).max(64)).max(100),
          revision: z.number().int().positive(),
        })
        .parse(req.body);
      return linkMailboxMessage(req.params.id, input.taskIds, input.revision);
    },
  );
}
