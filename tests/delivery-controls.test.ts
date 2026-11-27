import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { Deliveries } from "../src/Mail.tsx";
import { TaskFields } from "../src/Tasks.tsx";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const text = (node: any): string =>
  typeof node === "string" ? node : (node.children || []).map(text).join("");

test("delivery deletion requires a concrete confirmation and sends its revision", async () => {
  const oldDocument = (globalThis as any).document,
    oldFetch = globalThis.fetch;
  (globalThis as any).document = {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  let tree: any,
    calls = 0,
    refreshes = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "/api/v1/deliveries/delivery-id");
    assert.equal(options?.method, "DELETE");
    assert.deepEqual(JSON.parse(String(options?.body)), { revision: 7 });
    return new Response(JSON.stringify({ ok: true }));
  };
  try {
    await act(async () => {
      tree = create(
        React.createElement(Deliveries, {
          deliveries: [
            {
              id: "delivery-id",
              revision: 7,
              status: "sent",
              subject: "指定交付",
            },
          ],
          tasks: [],
          onTask() {},
          onRefresh: async () => {
            refreshes++;
          },
          notify() {},
        }),
      );
    });
    const button = (label: string) =>
      tree.root.findAllByType("button").find((n: any) => text(n).trim() === label);
    await act(async () =>
      tree.root
        .findByProps({ className: "delivery-list" })
        .findByType("button")
        .props.onClick(),
    );
    await act(async () => button("删除记录").props.onClick());
    assert.equal(calls, 0);
    assert.match(text(tree.root.findByProps({ role: "dialog" })), /指定交付/);
    await act(async () => button("取消").props.onClick());
    assert.equal(calls, 0);
    await act(async () => button("删除记录").props.onClick());
    await act(async () => button("确认删除").props.onClick());
    assert.equal(calls, 1);
    assert.equal(refreshes, 1);
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 0);
  } finally {
    if (tree) await act(async () => tree.unmount());
    globalThis.fetch = oldFetch;
    (globalThis as any).document = oldDocument;
  }
});

test("filing password is masked initially and reveals only on explicit toggle", async () => {
  let tree: any;
  await act(async () => {
    tree = create(
      React.createElement(TaskFields, {
        value: { kind: "new", filingAccount: "user", filingPassword: "exact!" },
        onChange() {},
      }),
    );
  });
  const input = () =>
    tree.root
      .findAllByType("input")
      .find((n: any) => n.props.value === "exact!");
  assert.equal(input().props.type, "password");
  await act(async () =>
    tree.root
      .findAllByType("button")
      .find((n: any) => text(n) === "显示")
      .props.onClick(),
  );
  assert.equal(input().props.type, "text");
  await act(async () => tree.unmount());
});
