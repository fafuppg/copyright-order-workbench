/** Check the real database and HTTP service; an open port alone is not readiness. */
export async function prepareWorkbench({
  appListening,
  tunnelListening,
  databaseReady,
  appHealthy,
  startTunnel,
  startServer,
  useTunnel,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 90000,
  intervalMs = 500,
  onProgress = () => {},
}) {
  const existing = await appListening();
  if (existing && (await appHealthy()))
    return { existing: true, repaired: false };
  const deadline = now() + timeoutMs;
  onProgress(existing ? "正在恢复工作台的数据库连接…" : "正在连接云端数据库…");
  let ready = false;
  while (now() < deadline) {
    if (useTunnel && !(await tunnelListening())) await startTunnel();
    if (await databaseReady()) {
      ready = true;
      break;
    }
    await sleep(intervalMs);
  }
  if (!ready)
    throw new Error(
      "云端数据库暂未连通。连接会在后台继续恢复，网络恢复后可重新双击启动工作台。",
    );
  if (!existing) await startServer();
  // Database reconnection may consume the initial wait. Give the HTTP service
  // its own startup window instead of failing immediately after recovery.
  const appDeadline = now() + Math.min(timeoutMs, 30000);
  while (now() < appDeadline) {
    if (await appHealthy()) return { existing, repaired: existing };
    await sleep(intervalMs);
  }
  throw new Error(
    existing
      ? "数据库已连通，但工作台健康检查尚未通过。请检查工作台运行日志；启动器未关闭已有服务。"
      : "数据库已连通，但工作台未能启动，请检查启动窗口中的错误信息。",
  );
}
