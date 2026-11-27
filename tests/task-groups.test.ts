import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { groupTasks, paginateTaskGroups } from "../shared/task-groups.ts";
import { TaskList } from "../src/Tasks.tsx";
import { reworkTaskDraft } from "../src/api.ts";
import { validateNewTask } from "../server/business.ts";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("date/customer grouping preserves software rows and does not merge same-named customers", () => {
  const rows = [
    { id: "a", customerId: "one", purchasedAt: "2026-11-26" },
    { id: "b", customerId: "one", purchasedAt: "2026-11-27" },
    { id: "c", customerId: "one", purchasedAt: "2026-11-27" },
    { id: "d", customerId: "two", purchasedAt: "2026-11-27" },
    { id: "e", customerName: "same", purchasedAt: "" },
    { id: "f", customerName: "same", purchasedAt: "" },
  ];
  const groups = groupTasks(rows);
  assert.deepEqual(
    groups.map((g) => g.tasks.map((t) => t.id)),
    [["a"], ["b", "c"], ["d"], ["e"], ["f"]],
  );
  assert.equal(rows[0].id, "a");
});

test("new tasks save agreed name separately and rework starts from prior delivery name", () => {
  const task = validateNewTask({ softwareName: "客户约定" });
  assert.equal(task.intakeName, "客户约定");
  const renamed = validateNewTask({ ...task, softwareName: "实际制作" });
  assert.equal(renamed.intakeName, "客户约定");
  const rework = reworkTaskDraft({
    ...renamed,
    id: "prior",
    customerId: "customer",
  });
  assert.equal(rework.originalName, "实际制作");
  assert.equal(rework.intakeName, "实际制作");
  assert.equal(rework.parentId, "prior");
});

test("task list splits new/correction, groups all software for a customer, and hides long notes", async () => {
  const tasks = Array.from({ length: 26 }, (_, i) => ({
    id: String(i),
    customerId: "customer",
    customerName: "同一客户",
    purchasedAt: "2026-11-27",
    kind: "new",
    softwareName: `制作${i}`,
    intakeName: `约定${i}`,
    notes: "不应出现的备注",
  }));
  tasks.push({
    ...tasks[0],
    id: "correction",
    kind: "correction",
    softwareName: "补正制作",
  });
  let tree: any;
  await act(async () => {
    tree = create(
      React.createElement(TaskList, {
        tasks,
        onRefresh: async () => {},
        onNew() {},
        onDetail() {},
        onMail() {},
        onCorrection() {},
        notify() {},
      }),
    );
  });
  const text = () => JSON.stringify(tree.toJSON());
  assert.doesNotMatch(
    text(),
    /不应出现的备注|补充 \/ 修改联系方式|待交付|全部任务|补正制作/,
  );
  assert.match(text(), /填报账号密码/);
  assert.doesNotMatch(text(), /"children":\["金额"\]/);
  assert.equal(
    tree.root.findAllByProps({ className: "merged-customer" }).length,
    1,
  );
  assert.equal(
    tree.root.findAll(
      (n: any) =>
        n.type === "tr" && String(n.props.className).startsWith("software-row"),
    ).length,
    26,
  );
  assert.match(text(), /约定25/);
  const tabs = tree.root.findByProps({ className: "tabs" });
  await act(async () => tabs.findAllByType("button")[1].props.onClick());
  assert.match(text(), /补正制作/);
  assert.doesNotMatch(text(), /约定25/);
  await act(async () => tree.unmount());
});

test("spreadsheet date spans cross customer groups and reset for each date", async () => {
  const tasks = [
    {
      id: "a",
      customerId: "one",
      customerName: "A",
      purchasedAt: "2026-11-27",
      kind: "new",
    },
    {
      id: "b",
      customerId: "one",
      customerName: "A",
      purchasedAt: "2026-11-27",
      kind: "new",
    },
    {
      id: "c",
      customerId: "two",
      customerName: "B",
      purchasedAt: "2026-11-27",
      kind: "new",
    },
    {
      id: "d",
      customerId: "one",
      customerName: "A",
      purchasedAt: "2026-11-26",
      kind: "new",
    },
  ];
  let tree: any;
  await act(async () => {
    tree = create(
      React.createElement(TaskList, {
        tasks,
        onRefresh: async () => {},
        onNew() {},
        onDetail() {},
        onMail() {},
        onCorrection() {},
        notify() {},
      }),
    );
  });
  assert.deepEqual(
    tree.root
      .findAllByProps({ className: "merged-date" })
      .map((n: any) => n.props.rowSpan),
    [1, 3],
  );
  assert.deepEqual(
    tree.root
      .findAllByProps({ className: "merged-customer" })
      .map((n: any) => n.props.rowSpan),
    [1, 2, 1],
  );
  assert.equal(tree.root.findByType("tbody").findAllByType("tr").length, 4);
  assert.equal(
    tree.root.findAllByProps({ className: "work-summary" }).length,
    0,
  );
  assert.equal(
    tree.root.findAllByProps({ className: "page-heading" }).length,
    0,
  );
  assert.equal(tree.root.findAllByProps({ className: "tabs" }).length, 1);
  await act(async () => tree.unmount());
});

test("row-budget pagination keeps groups intact and retains every task", () => {
  const groups = [20, 30, 2, 51, 1].map((size, i) => ({
    id: i,
    tasks: Array.from({ length: size }, (_, j) => `${i}-${j}`),
  }));
  const pages = paginateTaskGroups(groups, 50);
  assert.deepEqual(
    pages.map((p) => p.map((g) => g.id)),
    [[0, 1], [2], [3], [4]],
  );
  assert.deepEqual(pages.flat(), groups);
  assert.deepEqual(paginateTaskGroups([], 50), []);
});

test("unfinished groups come first, oldest orders first, then intake time without nickname sorting", () => {
  const rows = [
    { id: "done", customerId: "c", purchasedAt: "2026-11-01", completed: true },
    {
      id: "later",
      customerId: "a",
      customerName: "A",
      purchasedAt: "2026-11-27",
      createdAt: "2026-11-27T11:00:00Z",
    },
    {
      id: "early",
      customerId: "z",
      customerName: "Z",
      purchasedAt: "2026-11-27",
      createdAt: "2026-11-27T10:00:00Z",
    },
    { id: "old", customerId: "a", purchasedAt: "2026-11-26" },
    {
      id: "done-same-customer",
      customerId: "z",
      purchasedAt: "2026-11-27",
      completed: true,
    },
  ];
  assert.deepEqual(
    groupTasks(rows).flatMap((g) => g.tasks.map((t) => t.id)),
    ["old", "early", "later", "done", "done-same-customer"],
  );
});

test("inline completion records delivery, reorders rows, reopens, highlights submission and handles errors", async () => {
  const originalFetch = globalThis.fetch;
  let tasks: any[] = [
    {
      id: "one",
      revision: 1,
      customerId: "c",
      kind: "new",
      softwareName: "早单",
      purchasedAt: "2026-11-26",
      completed: false,
    },
    {
      id: "two",
      revision: 1,
      customerId: "c",
      kind: "new",
      softwareName: "晚单",
      purchasedAt: "2026-11-26",
      completed: false,
    },
  ];
  const calls: any[] = [],
    notices: string[] = [];
  let fail = false,
    tree: any;
  const props = () => ({
    tasks,
    onRefresh: async () => tree.update(React.createElement(TaskList, props())),
    onNew() {},
    onDetail() {},
    onMail() {},
    onCorrection() {},
    notify: (s: string) => notices.push(s),
  });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(String(options?.body)) });
    if (fail)
      return new Response(JSON.stringify({ error: "保存失败" }), {
        status: 409,
      });
    tasks = tasks.map((t) =>
      t.id !== "one"
        ? t
        : {
            ...t,
            revision: t.revision + 1,
            ...(String(url).endsWith("/external")
              ? { completed: true }
              : String(url).endsWith("/reopen")
                ? { completed: false }
                : { needsSubmission: true }),
          },
    );
    return new Response(JSON.stringify({ ok: true }));
  };
  try {
    await act(async () => {
      tree = create(React.createElement(TaskList, props()));
    });
    const completion = () =>
      tree.root.findByProps({ "aria-label": "完成交付：早单" });
    const order = () =>
      tree.root
        .findAllByType("input")
        .filter((n: any) =>
          String(n.props["aria-label"]).startsWith("完成交付："),
        )
        .map((n: any) => n.props["aria-label"]);
    await act(async () => {
      await completion().props.onChange({ target: { checked: true } });
    });
    assert.equal(calls[0].url, "/api/v1/tasks/one/external");
    assert.deepEqual(
      tree.root
        .findAllByProps({ className: "merged-date" })
        .map((n: any) => n.props.rowSpan),
      [1, 1],
    );
    assert.equal(calls[0].body.revision, 1);
    assert.deepEqual(order(), ["完成交付：晚单", "完成交付：早单"]);
    await act(async () => {
      await completion().props.onChange({ target: { checked: false } });
    });
    assert.equal(calls[1].url, "/api/v1/tasks/one/reopen");
    assert.deepEqual(order(), ["完成交付：早单", "完成交付：晚单"]);
    await act(async () => {
      await tree.root
        .findByProps({ "aria-label": "标记早单需要代提交" })
        .props.onChange({ target: { checked: true } });
    });
    assert.ok(
      tree.root
        .findAllByType("tr")
        .some((n: any) =>
          String(n.props.className).includes("needs-submission"),
        ),
    );
    fail = true;
    await act(async () => {
      await completion().props.onChange({ target: { checked: true } });
    });
    assert.equal(completion().props.checked, false);
    assert.ok(notices.some((message) => message.includes("保存失败")));
  } finally {
    globalThis.fetch = originalFetch;
    if (tree) await act(async () => tree.unmount());
  }
});

test("merged contacts edit inline with exactly the matching rows and no contact modal", async () => {
  const oldFetch = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = async (_url: any, init: any) => {
    calls.push({ url: String(_url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ tasks: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const { InlineCell } = await import("../src/components.tsx");
  let tree: any;
  try {
    const tasks: any[] = [
      {
        id: "one",
        customerId: "c",
        customerName: "客户",
        kind: "new",
        purchasedAt: "2026-11-27",
        email: "same@example.test",
        revision: 2,
      },
      {
        id: "two",
        customerId: "c",
        customerName: "客户",
        kind: "new",
        purchasedAt: "2026-11-27",
        email: "same@example.test",
        revision: 3,
      },
      {
        id: "three",
        customerId: "c",
        customerName: "客户",
        kind: "new",
        purchasedAt: "2026-11-27",
        email: "other@example.test",
        revision: 4,
      },
    ];
    tasks.push({ id: "child", kind: "correction", parentId: "one" });
    await act(async () => {
      tree = create(
        React.createElement(TaskList, {
          tasks,
          onRefresh: async () => {},
          onNew() {},
          onDetail() {},
          onMail() {},
          onCorrection() {},
          notify() {},
        }),
      );
    });
    const cells = tree.root.findAllByType(InlineCell);
    assert.equal(
      cells.filter((x: any) => x.props.value === "same@example.test").length,
      1,
    );
    const email = cells.find((x: any) => x.props.value === "same@example.test");
    await act(async () => {
      await email.props.onSave("updated@example.test");
    });
    assert.match(calls[0].url, /tasks\/contact-group$/);
    assert.deepEqual(calls[0].body, {
      targets: [{ id: "two", revision: 3 }],
      field: "email",
      value: "updated@example.test",
    });
    assert.ok(cells.some((x: any) => x.props.placeholder === "双击补充微信"));
    assert.doesNotMatch(JSON.stringify(tree.toJSON()), /补充 \/ 修改联系方式/);
  } finally {
    if (tree) await act(async () => tree.unmount());
    globalThis.fetch = oldFetch;
  }
});
