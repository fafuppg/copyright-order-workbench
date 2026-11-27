import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { PoolConnection } from "mysql2/promise";
import { pool, transaction } from "../server/db.ts";

function connection(
  t: TestContext,
  failures: Partial<Record<"begin" | "commit" | "rollback", Error>> = {},
) {
  const calls: string[] = [];
  const step = (name: "begin" | "commit" | "rollback") => async () => {
    calls.push(name);
    if (failures[name]) throw failures[name];
  };
  const fake = {
    beginTransaction: step("begin"),
    commit: step("commit"),
    rollback: step("rollback"),
    release: () => {
      calls.push("release");
    },
  } as unknown as PoolConnection;
  t.mock.method(pool, "getConnection", async () => fake);
  return { calls, fake };
}

test("transaction commits the result and releases its connection exactly once", async (t) => {
  const { calls, fake } = connection(t);
  const result = await transaction(async (c) => {
    assert.equal(c, fake);
    calls.push("work");
    return { saved: true };
  });
  assert.deepEqual(result, { saved: true });
  assert.deepEqual(calls, ["begin", "work", "commit", "release"]);
});

test("transaction releases the connection when BEGIN fails without running work", async (t) => {
  const original = new Error("connection lost during BEGIN");
  const { calls } = connection(t, { begin: original });
  await assert.rejects(
    transaction(async () => {
      calls.push("work");
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
});

test("transaction preserves a BEGIN error when rollback also fails", async (t) => {
  const original = new Error("BEGIN failed");
  const { calls } = connection(t, {
    begin: original,
    rollback: new Error("connection already closed"),
  });
  await assert.rejects(
    transaction(async () => {
      calls.push("work");
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
});

test("transaction rolls back rejected work and still releases the connection", async (t) => {
  const original = new Error("write rejected");
  const { calls } = connection(t);
  await assert.rejects(
    transaction(async () => {
      calls.push("work");
      throw original;
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ["begin", "work", "rollback", "release"]);
});

test("transaction does not hide the work error behind a rollback error", async (t) => {
  const original = new Error("write connection failed");
  const { calls } = connection(t, {
    rollback: new Error("rollback disconnected"),
  });
  await assert.rejects(
    transaction(async () => {
      calls.push("work");
      throw original;
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ["begin", "work", "rollback", "release"]);
});

test("transaction preserves uncertain COMMIT failure and releases after failed rollback", async (t) => {
  const original = new Error("connection lost during COMMIT");
  const { calls } = connection(t, {
    commit: original,
    rollback: new Error("rollback disconnected"),
  });
  await assert.rejects(
    transaction(async () => {
      calls.push("work");
      return "unconfirmed";
    }),
    (error) => error === original,
  );
  assert.deepEqual(calls, ["begin", "work", "commit", "rollback", "release"]);
});

test("transaction propagates failed checkout without invoking work", async (t) => {
  const original = new Error("database unavailable");
  let invoked = false;
  t.mock.method(pool, "getConnection", async () => {
    throw original;
  });
  await assert.rejects(
    transaction(async () => {
      invoked = true;
    }),
    (error) => error === original,
  );
  assert.equal(invoked, false);
});
