import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import sanitize from "sanitize-html";
import { get, save } from "./db.ts";
import { AppError } from "./types.ts";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function checkPassword(password: string, stored: string) {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const a = Buffer.from(key, "hex"),
    b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
const encryptionKey = () => {
  const s = process.env.SECRET_KEY;
  if (!s || s.length < 32) throw new Error("SECRET_KEY must be configured");
  return createHash("sha256").update(s).digest();
};
export function encrypt(value: any) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const bytes = Buffer.concat([
    c.update(JSON.stringify(value), "utf8"),
    c.final(),
  ]);
  return [
    iv.toString("hex"),
    c.getAuthTag().toString("hex"),
    bytes.toString("base64"),
  ].join(".");
}
export function decrypt(value: string) {
  const [iv, tag, bytes] = value.split("."),
    c = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "hex"),
    );
  c.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(
    Buffer.concat([
      c.update(Buffer.from(bytes, "base64")),
      c.final(),
    ]).toString(),
  );
}
export async function settings() {
  const stored = await get("settings", "connections");
  const conf = stored?.encrypted ? decrypt(stored.encrypted) : {};
  return {
    aiBaseUrl: process.env.AI_BASE_URL || "https://api.deepseek.com/anthropic",
    aiModel: process.env.AI_MODEL || "deepseek-flash",
    aiKey: process.env.AI_API_KEY || "",
    smtpHost: process.env.SMTP_HOST || "smtp.qq.com",
    smtpPort: Number(process.env.SMTP_PORT || 465),
    smtpUser: process.env.SMTP_USER || "",
    smtpPassword: process.env.SMTP_PASSWORD || "",
    imapHost: process.env.IMAP_HOST || "imap.qq.com",
    imapPort: Number(process.env.IMAP_PORT || 993),
    imapUser: process.env.IMAP_USER || "",
    imapPassword: process.env.IMAP_PASSWORD || "",
    autoSync: process.env.MAIL_AUTO_SYNC !== "false",
    mailMaxBytes: Number(process.env.MAIL_MAX_BYTES || 73400320),
    ...conf,
  };
}
export async function saveSettings(input: any) {
  const conf = await settings();
  for (const key of [
    "aiBaseUrl",
    "aiModel",
    "smtpHost",
    "smtpUser",
    "imapHost",
    "imapUser",
  ])
    if (typeof input[key] === "string") conf[key] = input[key].trim();
  for (const key of ["aiKey", "smtpPassword", "imapPassword"])
    if (input[key]) conf[key] = String(input[key]).trim();
  if (input.smtpPort) conf.smtpPort = Number(input.smtpPort);
  if (input.imapPort !== undefined) conf.imapPort = Number(input.imapPort);
  if (typeof input.autoSync === "boolean") conf.autoSync = input.autoSync;
  if (input.mailMaxBytes) conf.mailMaxBytes = Number(input.mailMaxBytes);
  if (
    !/^https:\/\//.test(conf.aiBaseUrl) ||
    !conf.aiModel ||
    !conf.smtpHost ||
    !Number.isInteger(conf.smtpPort) ||
    conf.smtpPort < 1 ||
    conf.smtpPort > 65535 ||
    !conf.imapHost ||
    !Number.isInteger(conf.imapPort) ||
    conf.imapPort < 1 ||
    conf.imapPort > 65535 ||
    conf.mailMaxBytes < 1024 ||
    conf.mailMaxBytes > 150 * 1024 * 1024
  )
    throw new AppError(400, "请检查接口地址、端口及附件限制");
  await save("settings", { id: "connections", encrypted: encrypt(conf) });
  return publicSettings(conf);
}
export function publicSettings(c: any) {
  const { aiKey, smtpPassword, imapPassword, ...safe } = c;
  return {
    ...safe,
    aiConfigured: !!aiKey,
    smtpConfigured: !!smtpPassword,
    imapConfigured: !!(
      (imapPassword || smtpPassword) &&
      (c.imapUser || c.smtpUser)
    ),
    imapPasswordInherited: !imapPassword,
    dbType: "MySQL",
    dbLocation: "腾讯云 · 加密连接",
    dbName: process.env.DB_NAME,
  };
}
export function cleanHtml(html: string) {
  return sanitize(html, {
    allowedTags: [
      "p",
      "br",
      "div",
      "span",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "ul",
      "ol",
      "li",
      "blockquote",
      "h1",
      "h2",
      "h3",
      "a",
      "hr",
    ],
    allowedAttributes: { "*": ["style"], a: ["href", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedStyles: {
      "*": {
        color: [/^#[\da-f]{3,8}$/i, /^rgb\([\d\s,]+\)$/i, /^[a-z]+$/i],
        "background-color": [/^#[\da-f]{3,8}$/i, /^rgb\([\d\s,]+\)$/i],
        "font-size": [/^\d{1,2}(px|pt)$/],
        "font-family": [/^[\w\s,'\-\u4e00-\u9fff]+$/],
        "text-align": [/^(left|center|right|justify)$/],
        "font-weight": [/^(bold|[1-9]00)$/],
        "text-decoration": [/^(underline|line-through)$/],
      },
    },
  });
}
/** Keep email table layout readable without loading trackers, media or active content. */
export function cleanMailboxHtml(html: string) {
  return sanitize(html, {
    allowedTags: [
      "p",
      "br",
      "div",
      "span",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "ul",
      "ol",
      "li",
      "blockquote",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "a",
      "hr",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "th",
      "caption",
      "colgroup",
      "col",
    ],
    allowedAttributes: {
      "*": ["style", "align", "dir"],
      a: ["href", "title"],
      table: [
        "style",
        "width",
        "border",
        "cellpadding",
        "cellspacing",
        "align",
      ],
      td: ["style", "colspan", "rowspan", "width", "height", "align", "valign"],
      th: ["style", "colspan", "rowspan", "width", "height", "align", "valign"],
      col: ["width", "span"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedStyles: {
      "*": {
        color: [/^#[\da-f]{3,8}$/i, /^rgba?\([\d\s,.]+\)$/i, /^[a-z]+$/i],
        "background-color": [
          /^#[\da-f]{3,8}$/i,
          /^rgba?\([\d\s,.]+\)$/i,
          /^[a-z]+$/i,
        ],
        "font-size": [/^\d{1,2}(px|pt)$/],
        "font-family": [/^[\w\s,'\-\u4e00-\u9fff]+$/],
        "font-weight": [/^(normal|bold|[1-9]00)$/],
        "font-style": [/^(normal|italic)$/],
        "text-align": [/^(left|center|right|justify)$/],
        "text-decoration": [/^(none|underline|line-through)$/],
        "white-space": [/^(normal|pre|pre-wrap|pre-line)$/],
        "border-collapse": [/^(collapse|separate)$/],
        "vertical-align": [/^(top|middle|bottom|baseline)$/],
        "line-height": [/^\d{1,3}(\.\d+)?(px|pt|%|em)?$/],
        width: [/^\d{1,4}(px|pt|%)$/],
        "max-width": [/^\d{1,4}(px|pt|%)$/],
        padding: [/^\d{1,3}(px|pt)(\s+\d{1,3}(px|pt)){0,3}$/],
        border: [/^\d{1,2}px\s+(solid|dashed|dotted)\s+#[\da-f]{3,8}$/i],
      },
    },
  });
}
export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function fillTemplate(text: string, task: any, html = false) {
  const vals: Record<string, string> = {
    客户称呼: task.customerName || "您好",
    软件名称: task.softwareName || "待定软件",
    原名称: task.originalName || task.softwareName || "",
    邮箱: task.email || "",
  };
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    if (!(key in vals)) throw new AppError(400, `未知模板变量：${key}`);
    return html ? escapeHtml(vals[key]) : vals[key];
  });
}
