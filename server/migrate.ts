import { bootstrapDB } from "./app.ts";
import { pool } from "./db.ts";
await bootstrapDB();
await pool.end();
console.log("云端MySQL数据结构已就绪");
