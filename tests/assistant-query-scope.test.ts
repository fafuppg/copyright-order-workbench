import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../server/db.ts";
import {
  assistantDetail,
  recoverAssistant,
  tickAssistant,
} from "../server/assistant.ts";

const stamp = "2026-11-27T00:00:00.000Z";
function row(id: string, payload: Record<string, any>, asText = false) {
  const value = {
    id,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    ...payload,
  };
  return {
    id,
    revision: value.revision,
    payload: asText ? JSON.stringify(value) : value,
  };
}

test("conversation detail reads only its messages and proposals and preserves ordering and privacy", async (t) => {
  t.mock.method(pool, "getConnection", async () => {
    throw new Error("Unexpected database connection");
  });
  t.mock.method(pool, "query", (async (sql: string, values: any[]) => {
    if (values[0] === "chatsession") {
      assert.deepEqual(values, ["chatsession", "session-a"]);
      return [[row("session-a", { status: "idle" })], []];
    }
    assert.match(
      sql,
      /JSON_UNQUOTE\(JSON_EXTRACT\(payload,'\$\.sessionId'\)\)=\?/,
    );
    assert.equal(values[1], "session-a");
    if (values[0] === "chatmessage")
      return [
        [
          row("b", { sessionId: "session-a", text: "第二条" }, true),
          row("a", { sessionId: "session-a", text: "第一条" }),
        ],
        [],
      ];
    assert.equal(values[0], "chatproposal");
    return [
      [
        row("proposal", {
          sessionId: "session-a",
          status: "pending",
          payload: { items: [] },
          snapshots: [{ secret: "internal" }],
          guards: [{ internal: true }],
        }),
      ],
      [],
    ];
  }) as any);
  const detail = await assistantDetail("session-a");
  assert.deepEqual(
    detail.messages.map((m) => m.id),
    ["a", "b"],
  );
  assert.equal(detail.messages[1].text, "第二条");
  assert.equal(detail.proposals[0].status, "pending");
  assert.equal(Object.hasOwn(detail.proposals[0], "snapshots"), false);
  assert.equal(Object.hasOwn(detail.proposals[0], "guards"), false);
});

test("missing conversations fail before reading message or proposal history", async (t) => {
  let reads = 0;
  t.mock.method(pool, "query", (async (_sql: string, values: any[]) => {
    reads++;
    assert.deepEqual(values, ["chatsession", "missing"]);
    return [[], []];
  }) as any);
  await assert.rejects(() => assistantDetail("missing"), /对话不存在/);
  assert.equal(reads, 1);
});

test("idle assistant checks active states and a single ordered queued message without loading history", async (t) => {
  const queries: { sql: string; values: any[] }[] = [];
  t.mock.method(pool, "getConnection", async () => {
    throw new Error("Idle workers must not write");
  });
  t.mock.method(pool, "query", (async (sql: string, values: any[]) => {
    queries.push({ sql, values });
    assert.match(
      sql,
      /JSON_UNQUOTE\(JSON_EXTRACT\(payload,'\$\.status'\)\) IN/,
    );
    return [[], []];
  }) as any);
  await tickAssistant({
    model: async () => {
      throw new Error("Idle workers must not call AI");
    },
  });
  assert.equal(queries.length, 3);
  const next = queries.at(-1)!;
  assert.deepEqual(next.values, ["chatmessage", "user", "queued", 1]);
  assert.match(next.sql, /ORDER BY created_at ASC,id ASC LIMIT \?$/);
  assert.ok(queries.slice(0, 2).every((q) => q.values.includes("processing")));
});

test("scoped recovery makes interrupted user messages retryable and retains queued work", async (t) => {
  const records = new Map<string, any>([
    ["chatsession:interrupted", row("interrupted", { status: "processing" })],
    ["chatsession:waiting", row("waiting", { status: "queued" })],
    [
      "chatmessage:orphan",
      row("orphan", {
        sessionId: "interrupted",
        role: "user",
        status: "processing",
      }),
    ],
    [
      "chatmessage:queued",
      row("queued", {
        sessionId: "waiting",
        role: "user",
        status: "queued",
        text: "待处理消息",
      }),
    ],
  ]);
  t.mock.method(pool, "query", (async (sql: string, values: any[]) => {
    assert.match(
      sql,
      /JSON_UNQUOTE\(JSON_EXTRACT\(payload,'\$\.status'\)\) IN/,
    );
    const rows = [...records.entries()]
      .filter(([key]) => key.startsWith(values[0] + ":"))
      .map(([, value]) => structuredClone(value));
    return [rows, []];
  }) as any);
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql: string, values: any[]) => {
      if (sql.startsWith("SELECT")) {
        const record = records.get(values[0] + ":" + values[1]);
        return [record ? [structuredClone(record)] : [], []];
      }
      if (sql.startsWith("INSERT INTO records"))
        records.set(values[1] + ":" + values[0], {
          id: values[0],
          payload: JSON.parse(values[2]),
          revision: values[3],
        });
      else assert.ok(sql.startsWith("INSERT INTO audit_log"));
      return [{}, []];
    },
  };
  t.mock.method(pool, "getConnection", (async () => connection) as any);
  await recoverAssistant();
  const value = (key: string) => records.get(key).payload;
  assert.equal(value("chatmessage:orphan").status, "failed");
  assert.match(value("chatmessage:orphan").error, /请重试/);
  assert.equal(value("chatsession:interrupted").status, "idle");
  assert.equal(value("chatsession:waiting").status, "queued");
  assert.equal(value("chatmessage:queued").text, "待处理消息");
  assert.equal(records.get("chatmessage:queued").revision, 1);
});
