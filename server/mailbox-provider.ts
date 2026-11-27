import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type {
  MessageStructureObject,
  FetchMessageObject,
} from "imapflow/lib/types";

export type MailFolder = "inbox" | "sent";
export type MailAddress = { name: string; address: string };
export type AttachmentMeta = {
  filename: string;
  contentType: string;
  size: number;
  contentId: string;
  part: string;
};
export type RemoteFolder = { folder: MailFolder; path: string };
export type FolderSnapshot = {
  uidValidity: string;
  uidNext: number;
  exists: number;
};
export type MessageRange = { start: number; end: number; uid: boolean };
export type RemoteMessage = {
  uid: number;
  read: boolean;
  subject: string;
  messageId: string;
  inReplyTo: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  date: string;
  size: number;
  structure?: MessageStructureObject;
};
export type MessageBody = {
  text: string;
  html: string;
  attachments: AttachmentMeta[];
  bodyTruncated: boolean;
};
export type MailboxConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  autoSync: boolean;
};
export interface MailboxProvider {
  connect(): Promise<void>;
  folders(): Promise<RemoteFolder[]>;
  inspect(path: string): Promise<FolderSnapshot>;
  list(path: string, range: MessageRange): Promise<RemoteMessage[]>;
  body(
    path: string,
    message: RemoteMessage,
    uidValidity: string,
  ): Promise<MessageBody>;
  flags(
    path: string,
    uids: number[],
    uidValidity: string,
  ): Promise<{ uid: number; read: boolean }[]>;
  setRead(
    path: string,
    uid: number,
    uidValidity: string,
    read: boolean,
  ): Promise<void>;
  close(): Promise<void>;
}
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_TEXT_PARTS = 8;

/** Only inline text leaves are downloadable. Attached messages and text files stay metadata. */
export function splitStructure(root?: MessageStructureObject) {
  const textParts: { part: string; type: string; size: number }[] = [];
  const attachments: AttachmentMeta[] = [];
  let visited = 0;
  const visit = (node: MessageStructureObject) => {
    if (++visited > 1000) return;
    const filename =
      node.dispositionParameters?.filename || node.parameters?.name || "";
    const attached =
      node.disposition?.toLowerCase() === "attachment" || !!filename;
    if (!attached && node.type.startsWith("multipart/")) {
      for (const child of node.childNodes || []) visit(child);
    } else if (!attached && ["text/plain", "text/html"].includes(node.type)) {
      textParts.push({
        part: node.part || "1",
        type: node.type,
        size: node.size || 0,
      });
    } else {
      attachments.push({
        filename:
          filename ||
          (node.type === "message/rfc822" ? "附加邮件.eml" : "未命名附件"),
        contentType: node.type,
        size: node.size || 0,
        contentId: node.id || "",
        part: node.part || "1",
      });
    }
  };
  if (root) visit(root);
  return { textParts, attachments };
}
function addresses(rows: any[] | undefined): MailAddress[] {
  return (rows || [])
    .slice(0, 100)
    .map((x) => ({
      name: String(x.name || "").slice(0, 300),
      address: String(x.address || "").slice(0, 320),
    }));
}
function message(row: FetchMessageObject): RemoteMessage {
  const e = row.envelope || {};
  const d = new Date(e.date || row.internalDate || 0);
  return {
    uid: row.uid,
    read: !!row.flags?.has("\\Seen"),
    subject: String(e.subject || "（无主题）").slice(0, 1000),
    messageId: String(e.messageId || "").slice(0, 1000),
    inReplyTo: String(e.inReplyTo || "").slice(0, 1000),
    from: addresses(e.from),
    to: addresses(e.to),
    cc: addresses(e.cc),
    date: Number.isNaN(d.valueOf())
      ? new Date(0).toISOString()
      : d.toISOString(),
    size: row.size || 0,
    structure: row.bodyStructure,
  };
}
export class ImapMailboxProvider implements MailboxProvider {
  private client: ImapFlow;
  constructor(config: MailboxConfig) {
    this.client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      auth: { user: config.user, pass: config.password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      clientInfo: { name: "Copyright Workbench", version: "1.0" },
    });
    this.client.on("error", () => {});
  }
  async connect() {
    await this.client.connect();
  }
  async folders() {
    const list = await this.client.list();
    const inbox = list.find(
      (x) => x.specialUse === "\\Inbox" || x.path.toUpperCase() === "INBOX",
    );
    const sent =
      list.find((x) => x.specialUse === "\\Sent") ||
      list.find((x) =>
        /^(sent|sent messages|sent items|已发送|已发送邮件)$/i.test(x.name),
      );
    const folders: RemoteFolder[] = [];
    if (inbox) folders.push({ folder: "inbox", path: inbox.path });
    if (sent) folders.push({ folder: "sent", path: sent.path });
    return folders;
  }
  private async locked<T>(
    path: string,
    readOnly: boolean,
    fn: () => Promise<T>,
  ) {
    const lock = await this.client.getMailboxLock(path, { readOnly });
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }
  private snapshot(): FolderSnapshot {
    if (!this.client.mailbox) throw new Error("MAILBOX_NOT_FOUND");
    return {
      uidValidity: String(this.client.mailbox.uidValidity),
      uidNext: this.client.mailbox.uidNext,
      exists: this.client.mailbox.exists,
    };
  }
  async inspect(path: string) {
    return this.locked(path, true, async () => this.snapshot());
  }
  async list(path: string, range: MessageRange) {
    if (range.start > range.end || range.end < 1) return [];
    return this.locked(path, true, async () => {
      // ImapFlow uses BODY.PEEK for headers/body parts; EXAMINE adds a second read-only guard.
      const rows = await this.client.fetchAll(
        `${range.start}:${range.end}`,
        {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          internalDate: true,
          size: true,
        },
        { uid: range.uid },
      );
      return rows
        .filter(
          (x) => !range.uid || (x.uid >= range.start && x.uid <= range.end),
        )
        .map(message);
    });
  }
  async body(path: string, msg: RemoteMessage, uidValidity: string) {
    return this.locked(path, true, async () => {
      if (this.snapshot().uidValidity !== uidValidity)
        throw new Error("UIDVALIDITY_CHANGED");
      const { textParts, attachments } = splitStructure(msg.structure);
      let text = "",
        html = "",
        remaining = MAX_BODY_BYTES,
        bodyTruncated = textParts.length > MAX_TEXT_PARTS;
      for (const part of textParts.slice(0, MAX_TEXT_PARTS)) {
        if (remaining <= 0) {
          bodyTruncated = true;
          break;
        }
        const limit = remaining;
        const result = await this.client.download(String(msg.uid), part.part, {
          uid: true,
          maxBytes: limit,
          chunkSize: 32768,
        });
        if (!result.content) continue;
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of result.content) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(buffer.subarray(0, Math.max(0, limit - bytes)));
          bytes += buffer.length;
        }
        const value = Buffer.concat(chunks).toString("utf8");
        remaining -= Math.min(bytes, limit);
        if (bytes >= limit) bodyTruncated = true;
        if (part.type === "text/plain") text += (text ? "\n" : "") + value;
        else html += (html ? "\n" : "") + value;
      }
      if (!text && html) {
        const parsed = await simpleParser(
          Buffer.from("Content-Type: text/html; charset=utf-8\r\n\r\n" + html),
          {
            skipImageLinks: true,
            skipTextToHtml: true,
            maxHtmlLengthToParse: MAX_BODY_BYTES,
          },
        );
        text = parsed.text || "";
      }
      return {
        text: text.slice(0, MAX_BODY_BYTES),
        html,
        attachments,
        bodyTruncated,
      };
    });
  }
  async setRead(path: string, uid: number, uidValidity: string, read: boolean) {
    await this.locked(path, false, async () => {
      if (this.snapshot().uidValidity !== uidValidity)
        throw new Error("UIDVALIDITY_CHANGED");
      const existing = await this.client.fetchOne(
        String(uid),
        { uid: true, flags: true },
        { uid: true },
      );
      if (!existing || existing.uid !== uid)
        throw new Error("MESSAGE_NOT_FOUND");
      if (read)
        await this.client.messageFlagsAdd(String(uid), ["\\Seen"], {
          uid: true,
        });
      else
        await this.client.messageFlagsRemove(String(uid), ["\\Seen"], {
          uid: true,
        });
      const current = await this.client.fetchOne(
        String(uid),
        { flags: true },
        { uid: true },
      );
      if (!current || !!current.flags?.has("\\Seen") !== read)
        throw new Error("READ_STATE_UNCONFIRMED");
    });
  }
  async flags(path: string, uids: number[], uidValidity: string) {
    if (!uids.length) return [];
    return this.locked(path, true, async () => {
      if (this.snapshot().uidValidity !== uidValidity)
        throw new Error("UIDVALIDITY_CHANGED");
      const rows = await this.client.fetchAll(
        uids,
        { uid: true, flags: true },
        { uid: true },
      );
      return rows.map((row) => ({
        uid: row.uid,
        read: !!row.flags?.has("\\Seen"),
      }));
    });
  }
  async close() {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}
