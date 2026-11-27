import { protectCredentials } from "./credential-storage.ts";
import "dotenv/config";
import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { AppError, type Doc, type RecordKind } from "./types.ts";

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  connectionLimit: 6,
  timezone: "Z",
  enableKeepAlive: true,
  connectTimeout: 20000,
});
type Conn = PoolConnection | typeof pool;
export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS records (
    id VARCHAR(64) NOT NULL, kind VARCHAR(24) NOT NULL, payload JSON NOT NULL,
    revision INT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (kind,id), INDEX kind_updated(kind,updated_at)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, kind VARCHAR(24) NOT NULL, record_id VARCHAR(64) NOT NULL,
    action VARCHAR(50) NOT NULL, before_data JSON, after_data JSON, created_at DATETIME(3) NOT NULL,
    INDEX record_history(kind,record_id,created_at)
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS screenshots (
    id VARCHAR(64) PRIMARY KEY, hash VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL,
    mime VARCHAR(40) NOT NULL, size INT NOT NULL, content LONGBLOB NOT NULL, created_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash VARCHAR(64) PRIMARY KEY, expires_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`);
}
function decode(row: any): Doc {
  const d =
    typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return { ...protectCredentials(d, true), id: row.id, revision: row.revision };
}
export async function all<T extends Doc = Doc>(
  kind: RecordKind,
  conn: Conn = pool,
): Promise<T[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id,payload,revision FROM records WHERE kind=? ORDER BY updated_at DESC",
    [kind],
  );
  return rows
    .map(decode)
    .filter((d) => kind !== "delivery" || !d.deletedAt) as T[];
}
/** Load task-scoped records without transferring every attachment or delivery. */
export async function recordsForTask(
  kind: "attachment" | "delivery",
  taskId: string,
) {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id,payload,revision FROM records WHERE kind=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.taskId'))=? ORDER BY updated_at DESC",
    [kind, taskId],
  );
  return rows.map(decode).filter((d) => kind !== "delivery" || !d.deletedAt);
}
export async function get<T extends Doc = Doc>(
  kind: RecordKind,
  id: string,
  conn: Conn = pool,
  lock = false,
): Promise<T | null> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT id,payload,revision FROM records WHERE kind=? AND id=?${lock ? " FOR UPDATE" : ""}`,
    [kind, id],
  );
  return rows.length ? (decode(rows[0]) as T) : null;
}
export async function transaction<T>(
  fn: (c: PoolConnection) => Promise<T>,
): Promise<T> {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const result = await fn(c);
    await c.commit();
    return result;
  } catch (err) {
    try {
      await c.rollback();
    } catch {
      // A lost connection can also prevent rollback. Preserve the original
      // failure so callers do not mistake cleanup failure for the root cause.
    }
    throw err;
  } finally {
    c.release();
  }
}
export async function save<T extends Doc = Doc>(
  kind: RecordKind,
  data: any,
  expected?: number,
  conn?: PoolConnection,
  action = "修改",
): Promise<T> {
  if (!conn)
    return transaction((c) => save<T>(kind, data, expected, c, action));
  const id = data.id || randomUUID();
  const old = await get(kind, id, conn, true);
  if (expected !== undefined && old?.revision !== expected)
    throw new AppError(
      409,
      "记录已在其他位置修改，请刷新后重新核对。你的输入仍已保留。",
    );
  const now = new Date().toISOString();
  const doc = {
    ...old,
    ...data,
    id,
    revision: (old?.revision || 0) + 1,
    createdAt: old?.createdAt || now,
    updatedAt: now,
  } as T;
  await conn.query(
    "INSERT INTO records (id,kind,payload,revision,created_at,updated_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),revision=VALUES(revision),updated_at=VALUES(updated_at)",
    [
      id,
      kind,
      JSON.stringify(protectCredentials(doc)),
      doc.revision,
      new Date(doc.createdAt),
      new Date(now),
    ],
  );
  if (!["settings", "user"].includes(kind))
    await conn.query(
      "INSERT INTO audit_log(kind,record_id,action,before_data,after_data,created_at) VALUES (?,?,?,?,?,?)",
      [
        kind,
        id,
        old ? action : "创建",
        old ? JSON.stringify(protectCredentials(old)) : null,
        JSON.stringify(protectCredentials(doc)),
        new Date(now),
      ],
    );
  return doc;
}
export async function remove(kind: RecordKind, id: string) {
  return transaction(async (c) => {
    const old = await get(kind, id, c, true);
    if (!old) throw new AppError(404, "记录不存在");
    await c.query("DELETE FROM records WHERE kind=? AND id=?", [kind, id]);
    await c.query(
      "INSERT INTO audit_log(kind,record_id,action,before_data,created_at) VALUES (?,?,?,?,?)",
      [kind, id, "删除", JSON.stringify(protectCredentials(old)), new Date()],
    );
  });
}
