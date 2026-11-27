import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { TaskList, TaskDetail } from "../src/Tasks.tsx";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const task = {
  id: "fixture",
  revision: 1,
  kind: "new",
  softwareName: "Fixture",
  customerName: "Sample",
  customerId: "customer",
  createdAt: "2026-01-01",
  purchasedAt: "2026-01-01",
  completed: false,
  needsSubmission: false,
  imageIds: [],
};
for (const field of ["completed", "needsSubmission"] as const) {
  test(`${field} updates immediately, ignores duplicate clicks and rolls back failures`, async () => {
    const oldFetch = globalThis.fetch;
    let finish!: (r: Response) => void,
      calls = 0,
      tree: any;
    globalThis.fetch = async () => {
      calls++;
      return new Promise<Response>((r) => {
        finish = r;
      });
    };
    try {
      await act(async () => {
        tree = create(
          React.createElement(TaskList, {
            tasks: [task],
            onRefresh: async () => {},
            onNew() {},
            onDetail() {},
            onMail() {},
            onCorrection() {},
            notify() {},
          }),
        );
      });
      const checkbox = () =>
        tree.root
          .findAllByType("input")
          .find(
            (n: any) =>
              n.props["aria-label"] ===
              (field === "completed"
                ? "完成交付：Fixture"
                : "标记Fixture需要代提交"),
          );
      const change = checkbox().props.onChange;
      await act(async () => {
        change({ target: { checked: true } });
        change({ target: { checked: true } });
      });
      assert.equal(calls, 1);
      assert.equal(checkbox().props.checked, true);
      assert.equal(checkbox().props.disabled, true);
      await act(async () => {
        finish(
          new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
        );
      });
      assert.equal(checkbox().props.checked, false);
      assert.equal(checkbox().props.disabled, false);
      await act(async () => {
        checkbox().props.onChange({ target: { checked: true } });
      });
      await act(async () => {
        finish(
          new Response(JSON.stringify({ ...task, [field]: true, revision: 2 })),
        );
      });
      assert.equal(checkbox().props.checked, true);
      assert.equal(checkbox().props.disabled, false);
    } finally {
      await act(async () => tree?.unmount());
      globalThis.fetch = oldFetch;
    }
  });
}
test("history displays while the independent detail request is still pending", async () => {
  const oldFetch = globalThis.fetch,
    oldDocument = (globalThis as any).document;
  (globalThis as any).document = {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  let tree: any;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/history")
      ? new Response(
          JSON.stringify({
            summary: { stages: 0, deliveries: 0, changes: 0 },
            stages: [],
          }),
        )
      : new Promise<Response>(() => {});
  try {
    await act(async () => {
      tree = create(
        React.createElement(TaskDetail, {
          task,
          tasks: [task],
          onClose() {},
          onRefresh: async () => {},
          onMail() {},
          onEdit() {},
          onCorrection() {},
          notify() {},
        }),
      );
    });
    assert.equal(
      tree.root.findAllByProps({ className: "task-history" }).length,
      1,
    );
    assert.ok(!JSON.stringify(tree.toJSON()).includes("正在读取完整历史"));
  } finally {
    await act(async () => tree?.unmount());
    globalThis.fetch = oldFetch;
    (globalThis as any).document = oldDocument;
  }
});
