import "dotenv/config";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { exportBackup, restoreBackup } from "../server/backup.ts";
import { bootstrapDB } from "../server/app.ts";
import { pool } from "../server/db.ts";
try {
  if (process.argv[2] === "restore") {
    if (!process.argv[3])
      throw new Error("用法：npm run restore -- /绝对路径/备份.json");
    await bootstrapDB();
    const result = await restoreBackup(
      JSON.parse(await readFile(process.argv[3], "utf8")),
    );
    console.log("恢复完成：", result);
  } else {
    await mkdir(".private/backups", { recursive: true, mode: 0o700 });
    const file =
      ".private/backups/workbench-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      ".json";
    await writeFile(file, JSON.stringify(await exportBackup()), {
      mode: 0o600,
    });
    console.log("完整业务备份已保存：" + file);
  }
} finally {
  await pool.end();
}
