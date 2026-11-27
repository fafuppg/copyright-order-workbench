import test from "node:test";
import assert from "node:assert/strict";
import {
  editablePayload,
  selectNewProposal,
  proposalVersion,
  taskPayload,
} from "../src/assistant-model.ts";

test("partial AI task edits preserve existing contact and software details without writable status fields", () => {
  const task = {
    id: "original",
    customerName: "客户甲",
    email: "old@example.test",
    softwareName: "原软件",
    notes: "旧备注",
    completed: true,
    revision: 7,
    needsSubmission: true,
    kind: "new",
  };
  const proposal = {
    type: "update_task",
    payload: {
      taskId: "original",
      revision: 7,
      fields: { email: "new@example.test" },
    },
  };
  const payload = editablePayload(proposal, [task]);
  assert.equal(payload.fields.customerName, "客户甲");
  assert.equal(payload.fields.softwareName, "原软件");
  assert.equal(payload.fields.email, "new@example.test");
  assert.equal(payload.fields.needsSubmission, true);
  assert.equal(Object.hasOwn(payload.fields, "completed"), false);
  assert.equal(Object.hasOwn(payload.fields, "revision"), false);
  payload.fields.email = "edited@example.test";
  assert.equal(proposal.payload.fields.email, "new@example.test");
  assert.equal(task.email, "old@example.test");
});

test("new screenshot proposal fills editable missing fields without discarding correction link and evidence", () => {
  const proposal = {
    type: "create_tasks",
    payload: {
      imageIds: ["image"],
      items: [
        {
          kind: "correction",
          parentId: "prior",
          softwareName: "新名称",
          sources: [{ field: "名称", quote: "新名称" }],
        },
      ],
    },
  };
  const payload = editablePayload(proposal, []);
  assert.equal(payload.items[0].parentId, "prior");
  assert.equal(payload.items[0].email, "");
  assert.equal(payload.items[0].needsSubmission, false);
  assert.equal(payload.items[0].sources[0].quote, "新名称");
  assert.deepEqual(payload.imageIds, ["image"]);
});

test("automatic review opens new or conversationally revised pending proposals, never old or applied results", () => {
  const prior = { id: "proposal", revision: 2, status: "pending" };
  const known = new Set([proposalVersion(prior)]);
  assert.equal(
    selectNewProposal(
      [prior, { id: "done", revision: 5, status: "applied" }],
      known,
    ),
    undefined,
  );
  const revised = { ...prior, revision: 3 };
  assert.equal(selectNewProposal([revised], known), revised);
  assert.equal(
    selectNewProposal(
      [{ id: "cancelled", revision: 1, status: "cancelled" }],
      known,
    ),
    undefined,
  );
});

test("review form cannot send hidden task ownership or completion keys as editable task fields", () => {
  const value = taskPayload({
    softwareName: "可以修改",
    completed: true,
    customerId: "wrong",
    projectId: "wrong",
    archived: true,
    needsSubmission: true,
  });
  assert.equal(value.softwareName, "可以修改");
  assert.equal(value.needsSubmission, true);
  for (const forbidden of ["completed", "customerId", "projectId", "archived"])
    assert.equal(Object.hasOwn(value, forbidden), false);
});

test("lost PATCH response requires explicit reload before confirming a newer pending revision", async () => {
  const { confirmationRecovery } = await import("../src/assistant-model.ts");
  assert.equal(
    confirmationRecovery({ status: "pending", revision: 5 }, 4),
    "reload",
  );
  // A successful PATCH returned revision 5, then confirmation failed: same revision remains retryable.
  assert.equal(
    confirmationRecovery({ status: "pending", revision: 5 }, 5),
    "retry",
  );
  // A lost confirm response is settled from the actual completed result without applying it again.
  assert.equal(
    confirmationRecovery({ status: "applied", revision: 6 }, 5),
    "applied",
  );
  assert.equal(
    confirmationRecovery({ status: "cancelled", revision: 6 }, 5),
    "cancelled",
  );
});

test("explicit reload uses a detached copy of newest proposal rather than silently keeping outdated input", async () => {
  const actual = {
    type: "create_tasks",
    status: "pending",
    revision: 5,
    payload: {
      items: [{ softwareName: "对话修订后名称", email: "new@example.test" }],
    },
  };
  const oldDraft = { softwareName: "本地旧输入", email: "old@example.test" };
  const reloaded = editablePayload(actual, []);
  assert.equal(reloaded.items[0].softwareName, "对话修订后名称");
  assert.equal(reloaded.items[0].email, "new@example.test");
  assert.equal(oldDraft.softwareName, "本地旧输入");
  reloaded.items[0].email = "manually-rechecked@example.test";
  assert.equal(actual.payload.items[0].email, "new@example.test");
});
