import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareWorkbench,
  type LaunchChecks,
} from "../scripts/launch-control.mjs";

function scenario(overrides: Partial<LaunchChecks> = {}) {
  let clock = 0;
  const events: string[] = [];
  const checks: LaunchChecks = {
    appListening: async () => false,
    tunnelListening: async () => true,
    databaseReady: async () => true,
    appHealthy: async () => true,
    startTunnel: () => {
      events.push("tunnel");
    },
    startServer: () => {
      events.push("server");
    },
    useTunnel: true,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timeoutMs: 100,
    intervalMs: 10,
    ...overrides,
  };
  return { checks, events };
}

test("launcher repairs a missing tunnel even when the app port is already open", async () => {
  let repaired = false;
  const s = scenario({
    appListening: async () => true,
    appHealthy: async () => repaired,
    tunnelListening: async () => repaired,
    databaseReady: async () => repaired,
    startTunnel: () => {
      repaired = true;
      s.events.push("tunnel");
    },
  });
  assert.deepEqual(await prepareWorkbench(s.checks), {
    existing: true,
    repaired: true,
  });
  assert.deepEqual(s.events, ["tunnel"]);
});

test("launcher reuses a shared tunnel and waits for a real database query", async () => {
  let attempts = 0;
  const s = scenario({
    databaseReady: async () => ++attempts >= 3,
    startServer: () => {
      assert.equal(attempts, 3);
      s.events.push("server");
    },
  });
  assert.deepEqual(await prepareWorkbench(s.checks), {
    existing: false,
    repaired: false,
  });
  assert.deepEqual(s.events, ["server"]);
});

test("launcher never reports success for an open HTTP port with failing health", async () => {
  const s = scenario({
    appListening: async () => true,
    appHealthy: async () => false,
  });
  await assert.rejects(prepareWorkbench(s.checks), /健康检查尚未通过/);
  assert.deepEqual(s.events, []);
});

test("launcher does not start the app while the database remains unavailable", async () => {
  const s = scenario({ databaseReady: async () => false });
  await assert.rejects(prepareWorkbench(s.checks), /云端数据库暂未连通/);
  assert.deepEqual(s.events, []);
});

test("launcher waits for HTTP readiness after starting the app", async () => {
  let probes = 0;
  const s = scenario({ appHealthy: async () => ++probes >= 3 });
  await prepareWorkbench(s.checks);
  assert.equal(probes, 3);
  assert.deepEqual(s.events, ["server"]);
});

test("launcher leaves an already healthy workbench and shared tunnel alone", async () => {
  const s = scenario({
    appListening: async () => true,
    databaseReady: async () => {
      throw new Error("unnecessary DB connection");
    },
    tunnelListening: async () => {
      throw new Error("unnecessary tunnel probe");
    },
  });
  assert.deepEqual(await prepareWorkbench(s.checks), {
    existing: true,
    repaired: false,
  });
  assert.deepEqual(s.events, []);
});
