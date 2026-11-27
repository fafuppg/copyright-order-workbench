import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskHistory,
  historyChanges,
  projectTaskIds,
} from "../server/task-history.ts";

const tasks = [
  {
    id: "first",
    kind: "new",
    projectId: "project",
    customerId: "c",
    softwareName: "首次名称",
    parentId: null,
    completed: true,
    archived: true,
    createdAt: "2026-01-01",
  },
  {
    id: "second",
    kind: "correction",
    projectId: "project",
    customerId: "c",
    softwareName: "补正名称",
    parentId: "first",
    completed: true,
    archived: false,
    createdAt: "2026-02-01",
  },
  {
    id: "third",
    kind: "correction",
    projectId: "project",
    customerId: "c",
    softwareName: "再次返工名称",
    parentId: "second",
    completed: false,
    archived: false,
    createdAt: "2026-03-01",
  },
  {
    id: "other",
    kind: "new",
    projectId: "different",
    customerId: "c",
    softwareName: "同客户另一软件",
    parentId: null,
    createdAt: "2026-01-02",
  },
];
const deliveries = [
  {
    id: "d1",
    taskId: "first",
    status: "sent",
    softwareName: "发送时旧名称",
    html: "<p>最早交付</p>",
    sentAt: "2026-01-02",
  },
  {
    id: "d2",
    taskId: "second",
    status: "external",
    notes: "微信发送",
    sentAt: "2026-02-02",
  },
  {
    id: "d3",
    taskId: "second",
    status: "sent",
    html: "<p>第二次发送</p>",
    sentAt: "2026-02-03",
  },
  { id: "outside", taskId: "other", status: "sent", sentAt: "2026-02-04" },
];

test("complete history includes archived originals and every correction stage", () => {
  const result = buildTaskHistory("third", tasks, deliveries, []);
  assert.deepEqual(
    result.stages.map((stage) => stage.task.id),
    ["first", "second", "third"],
  );
  assert.deepEqual(
    result.stages.map((stage) => stage.depth),
    [0, 1, 2],
  );
  assert.equal(result.summary.archived, 1);
  assert.equal(result.summary.completed, 2);
  assert.equal(result.summary.successfulDeliveries, 3);
  assert.equal(result.stages[2].parentName, "补正名称");
});
test("rework history preserves all immutable delivery snapshots and input records", () => {
  const original = structuredClone({ tasks, deliveries });
  const result = buildTaskHistory("first", tasks, deliveries, []);
  assert.equal(result.stages[0].deliveries[0].softwareName, "发送时旧名称");
  assert.equal(result.stages[0].deliveries[0].html, "<p>最早交付</p>");
  assert.deepEqual(
    result.stages[1].deliveries.map((d) => d.id),
    ["d3", "d2"],
  );
  assert.deepEqual({ tasks, deliveries }, original);
});
test("history contains all field changes rather than limiting to the latest 100", () => {
  const audits = Array.from({ length: 125 }, (_, index) => ({
    id: index + 1,
    record_id: "second",
    action: "修改",
    created_at: "2026-02-01",
    before_data: JSON.stringify({ softwareName: `名称${index}` }),
    after_data: { softwareName: `名称${index + 1}` },
  }));
  const result = buildTaskHistory("third", tasks, deliveries, audits);
  assert.equal(result.stages[1].audits.length, 125);
  assert.equal(result.summary.changes, 125);
  assert.equal(result.stages[1].audits[0].changes[0].label, "制作名称");
  assert.equal(result.stages[1].audits[0].changes[0].before, "名称124");
});
test("linked received and sent emails are included without pulling another project", () => {
  const mails = [
    {
      id: "m1",
      taskIds: ["first", "second"],
      folder: "inbox",
      subject: "补正说明",
      date: "2026-02-02",
    },
    {
      id: "m2",
      taskIds: ["third"],
      folder: "sent",
      subject: "资料",
      date: "2026-03-02",
      remoteMissing: true,
    },
    { id: "m3", taskIds: ["other"], folder: "inbox", date: "2026-03-03" },
  ];
  const result = buildTaskHistory("third", tasks, [], [], mails);
  assert.equal(result.summary.mailMessages, 2);
  assert.equal(result.stages[0].mailMessages[0].id, "m1");
  assert.equal(result.stages[1].mailMessages[0].id, "m1");
  assert.equal(result.stages[2].mailMessages[0].remoteMissing, true);
});
test("legacy parent links are followed and unrelated blank project IDs are excluded", () => {
  const legacy = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    { id: "c", parentId: null },
  ];
  assert.deepEqual(new Set(projectTaskIds("b", legacy)), new Set(["a", "b"]));
  assert.throws(() => projectTaskIds("missing", legacy), /任务不存在/);
});
test("malformed cyclic history remains bounded and every record appears once", () => {
  const cyclic = [
    { id: "a", parentId: "b" },
    { id: "b", parentId: "a" },
  ];
  const result = buildTaskHistory("a", cyclic, [], []);
  assert.equal(result.stages.length, 2);
  assert.equal(new Set(result.stages.map((stage) => stage.task.id)).size, 2);
});
test("field history distinguishes empty dates, state changes, and preserved screenshot lists", () => {
  const result = historyChanges({
    before_data: { purchasedAt: "", completed: false, imageIds: ["one"] },
    after_data: {
      purchasedAt: "2026-11-27",
      completed: true,
      imageIds: ["one", "two"],
    },
  });
  assert.deepEqual(
    result.map((change) => change.key),
    ["purchasedAt", "completed", "imageIds"],
  );
  assert.equal(result[0].before, "");
  assert.equal(result[1].before, false);
});
