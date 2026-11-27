import test from "node:test";
import assert from "node:assert/strict";
import { protectCredentials } from "../server/credential-storage.ts";
import { parseExtraction } from "../server/ai.ts";
import { reworkTaskDraft } from "../src/api.ts";

test("password fields are encrypted recursively, roundtrip exactly, and reject tampering", () => {
  process.env.SECRET_KEY ||= "test-only-credential-key-at-least-32-characters";
  const original = {
    filingAccount: "account",
    filingPassword: ' A! 密码 &" ',
    payload: { items: [{ filingPassword: "sealed:v1:literal-password" }] },
  };
  const stored = protectCredentials(original);
  assert.ok(!JSON.stringify(stored).includes(original.filingPassword));
  assert.equal(stored.filingAccount, original.filingAccount);
  assert.deepEqual(protectCredentials(stored, true), original);
  assert.equal(original.filingPassword, ' A! 密码 &" ');
  const changed = structuredClone(stored);
  changed.filingPassword = changed.filingPassword.slice(0, -4) + "AAAA";
  assert.throws(() => protectCredentials(changed, true));
});
test("AI intake and rework retain explicit filing credentials without changing password characters", () => {
  const result = parseExtraction(
    JSON.stringify({
      customer: { filingAccount: "user123", filingPassword: " Ab!& " },
      items: [{ softwareName: "软件" }],
    }),
  );
  assert.equal(result.customer.filingPassword, " Ab!& ");
  const draft = reworkTaskDraft({
    id: "task",
    ...result.customer,
    softwareName: "软件",
  });
  assert.equal(draft.filingAccount, "user123");
  assert.equal(draft.filingPassword, " Ab!& ");
});

test("extraction keeps password only in its dedicated field rather than evidence or notes", () => {
  const result = parseExtraction(
    JSON.stringify({
      customer: { filingPassword: "Secret!9" },
      items: [
        {
          softwareName: "软件",
          notes: "密码 Secret!9",
          sources: [{ field: "密码", imageIndex: 1, quote: "Secret!9" }],
        },
      ],
      warnings: ["Secret!9"],
    }),
  );
  assert.equal(result.customer.filingPassword, "Secret!9");
  assert.ok(!JSON.stringify(result.items).includes("Secret!9"));
  assert.ok(!JSON.stringify(result.warnings).includes("Secret!9"));
});
