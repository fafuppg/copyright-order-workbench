import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { TaskList } from "../src/Tasks.tsx";
import { withReworkStatus } from "../shared/rework-status.ts";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("linked rework freezes original row and only linked corrections offer cancellation", async () => {
  const tasks = [
    {
      id: "original",
      kind: "new",
      softwareName: "原软件",
      customerName: "客户",
      filingAccount: "account",
      filingPassword: "pass!",
    },
    {
      id: "child",
      parentId: "original",
      kind: "correction",
      softwareName: "补正",
    },
    { id: "independent", kind: "correction", softwareName: "独立补正" },
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
  assert.match(JSON.stringify(tree.toJSON()), /account/);
  assert.match(JSON.stringify(tree.toJSON()), /pass!/);
  const checks = tree.root
    .findAllByType("input")
    .filter((x: any) => x.props.type === "checkbox");
  assert.ok(checks.every((x: any) => x.props.disabled));
  const text = (x: any) =>
    x.children.filter((c: any) => typeof c === "string").join("");
  assert.equal(
    tree.root.findAllByType("button").find((x: any) => text(x) === "返工").props
      .disabled,
    true,
  );
  await act(async () =>
    tree.root
      .findByProps({ className: "tabs" })
      .findAllByType("button")[1]
      .props.onClick(),
  );
  assert.equal(
    tree.root.findAllByType("button").filter((x: any) => text(x) === "撤销补正")
      .length,
    1,
  );
  await act(async () => tree.unmount());
  assert.equal(
    withReworkStatus(
      tasks.map((t) => (t.id === "child" ? { ...t, cancelledAt: "now" } : t)),
    )[0].inRework,
    false,
  );
});
