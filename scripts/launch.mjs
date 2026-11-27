import "dotenv/config";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { prepareWorkbench } from "./launch-control.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const children = [];
const appPort = Number(process.env.PORT || 3210);
const tunnelPort = Number(process.env.DB_PORT || 13316);
const address = `http://127.0.0.1:${appPort}`;
let stopping = false;
let tunnelChild = null;
let tunnelError = null;
const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
async function databaseReady() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectTimeout: 3000,
    });
    await connection.query({ sql: "SELECT 1", timeout: 3000 });
    return true;
  } catch {
    return false;
  } finally {
    connection?.destroy();
  }
}
async function appHealthy() {
  try {
    const response = await fetch(address + "/api/v1/health", {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}
function startTunnel() {
  if (tunnelError)
    throw new Error("数据库连接程序无法启动，请检查本地运行环境。");
  if (
    tunnelChild &&
    tunnelChild.exitCode === null &&
    tunnelChild.signalCode === null
  )
    return;
  const python =
    process.platform === "win32"
      ? ".private/venv/Scripts/python.exe"
      : ".private/venv/bin/python";
  if (!fs.existsSync(python))
    throw new Error("首次运行请先完成 README 中的本地准备步骤。");
  fs.mkdirSync(".private", { recursive: true, mode: 0o700 });
  const log = fs.openSync(".private/tunnel.log", "a", 0o600);
  try {
    // The tunnel is shared by the app and maintenance commands. Keep it alive
    // when a launcher exits, an existing app is repaired, or the UI is stopped.
    tunnelChild = spawn(python, ["scripts/tunnel.py"], {
      cwd: root,
      env: process.env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    tunnelChild.on("error", () => {
      tunnelError = true;
    });
    tunnelChild.unref();
  } finally {
    fs.closeSync(log);
  }
}
function start(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    cwd: root,
  });
  children.push(child);
  child.on("error", () => {
    console.error("工作台程序无法启动，请检查本地运行环境。");
    stop(1);
  });
  return child;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1000);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
try {
  const result = await prepareWorkbench({
    appListening: () => portOpen(appPort),
    tunnelListening: () => portOpen(tunnelPort),
    databaseReady,
    appHealthy,
    startTunnel,
    startServer: () => {
      const server = start(process.execPath, [
        "--import",
        "tsx",
        "server/index.ts",
      ]);
      server.on("exit", (code) => stop(code || 0));
    },
    useTunnel: process.env.DB_TUNNEL === "true",
    onProgress: console.log,
  });
  console.log(
    result.repaired
      ? `数据库连接已恢复，工作台可用：${address}`
      : result.existing
        ? `工作台已经运行且连接正常：${address}`
        : `工作台已就绪：${address}`,
  );
  if (result.existing) process.exit(0);
  if (process.argv.includes("--dev"))
    start(process.execPath, [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
    ]);
} catch (error) {
  console.error(error.message);
  stop(1);
}
