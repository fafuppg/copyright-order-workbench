import test from "node:test";
import assert from "node:assert/strict";
import { shanghaiDate, withNewPurchaseDate } from "../shared/date.ts";
import {
  newTaskDraft,
  reworkTaskDraft,
  supplementTaskDraft,
} from "../src/api.ts";
import { validateNewTask, validateTask } from "../server/business.ts";
import { parseExtraction } from "../server/ai.ts";
import { editablePayload } from "../src/assistant-model.ts";

const beforeMidnight = new Date("2026-11-26T15:59:59.000Z");
const afterMidnight = new Date("2026-11-26T16:00:00.000Z");

test("purchase date follows Shanghai midnight regardless of host timezone", () => {
  assert.equal(shanghaiDate(beforeMidnight), "2026-11-26");
  assert.equal(shanghaiDate(afterMidnight), "2026-11-27");
});
test("new drafts compute their date at each creation and identify the default", () => {
  assert.equal(newTaskDraft({}, beforeMidnight).purchasedAt, "2026-11-26");
  const later = newTaskDraft({}, afterMidnight);
  assert.equal(later.purchasedAt, "2026-11-27");
  assert.equal(later.purchaseDateDefaulted, true);
  assert.equal(validateNewTask({}, afterMidnight).purchasedAt, "2026-11-27");
});
test("explicit purchase dates survive prefill and backend validation", () => {
  const input = { purchasedAt: "2024-02-29", softwareName: "已有日期的软件" };
  assert.equal(
    withNewPurchaseDate(input, afterMidnight).purchasedAt,
    "2024-02-29",
  );
  assert.equal(newTaskDraft(input, afterMidnight).purchaseDateDefaulted, false);
  assert.equal(validateNewTask(input, afterMidnight).purchasedAt, "2024-02-29");
  assert.throws(() => validateNewTask({ purchasedAt: "2025-02-29" }));
});
test("editing an existing task never fills an old blank purchase date", () => {
  assert.equal(
    validateTask({ purchasedAt: "", notes: "补充备注" }).purchasedAt,
    "",
  );
  const payload = editablePayload(
    {
      type: "update_task",
      payload: { taskId: "old", fields: { notes: "补充" } },
    },
    [{ id: "old", purchasedAt: "" }],
  );
  assert.equal(payload.fields.purchasedAt, "");
});
test("screenshot facts remain unknown while new-task review suggests today", () => {
  const extraction = parseExtraction(
    JSON.stringify({
      customer: {},
      items: [{ softwareName: "截图软件", purchasedAt: "" }],
      warnings: [],
    }),
  );
  assert.equal(extraction.items[0].purchasedAt, "");
  const draft = newTaskDraft(extraction.items[0], afterMidnight);
  assert.equal(draft.purchasedAt, "2026-11-27");
  assert.equal(draft.purchaseDateDefaulted, true);
});
test("a suggested date never overwrites an existing date during screenshot supplement", () => {
  const suggested = newTaskDraft({ notes: "新截图" }, afterMidnight);
  for (const purchasedAt of ["", "2024-04-01"]) {
    const result = supplementTaskDraft(
      { purchasedAt, kind: "correction", needsSubmission: true },
      suggested,
    );
    assert.equal(result.purchasedAt, purchasedAt);
    assert.equal(result.kind, "correction");
    assert.equal(result.needsSubmission, true);
    assert.equal(result.notes, "新截图");
  }
  assert.equal(
    supplementTaskDraft(
      { purchasedAt: "", kind: "new" },
      { purchasedAt: "2025-06-01", purchaseDateDefaulted: false },
    ).purchasedAt,
    "2025-06-01",
  );
});
test("new orders and correction stages can both create a fresh linked rework draft", () => {
  for (const kind of ["new", "correction"]) {
    const source = {
      id: "previous",
      kind,
      customerId: "customer",
      softwareName: "旧名称",
      purchasedAt: "2020-01-01",
      completed: true,
      completedAt: "past",
      archived: true,
      email: "buyer@example.test",
    };
    const rework = reworkTaskDraft(source, afterMidnight);
    assert.equal(rework.kind, "correction");
    assert.equal(rework.parentId, source.id);
    assert.equal(rework.customerId, source.customerId);
    assert.equal(rework.originalName, source.softwareName);
    assert.equal(rework.purchasedAt, "2026-11-27");
    assert.equal(rework.id, undefined);
    assert.equal(rework.completed, undefined);
    assert.equal(rework.archived, undefined);
    assert.equal(source.completed, true);
    assert.equal(source.purchasedAt, "2020-01-01");
  }
});
