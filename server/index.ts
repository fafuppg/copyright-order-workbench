import { buildApp } from "./app.ts";
import { pool } from "./db.ts";
const app = await buildApp({ workers: true });
await app.listen({
  port: Number(process.env.PORT || 3210),
  host: process.env.HOST || "127.0.0.1",
});
console.log(
  `软著订单工作台已启动：http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3210}`,
);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await pool.end();
    process.exit(0);
  });
