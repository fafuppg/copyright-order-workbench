import test from "node:test";
import assert from "node:assert/strict";
import { requestAI } from "../server/ai-request.ts";

test("both AI routes explicitly disable thinking and preserve image/text payloads", async () => {
  const original = globalThis.fetch;
  const messages = [
    {
      role: "user",
      content: [{ type: "image", source: { type: "base64", data: "sample" } }],
    },
  ];
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://example.invalid/anthropic/v1/messages");
      const body = JSON.parse(String(options?.body));
      assert.deepEqual(body.thinking, { type: "disabled" });
      assert.deepEqual(body.messages, messages);
      assert.equal(body.model, "deepseek-flash");
      assert.equal(body.max_tokens, 6000);
      assert.ok(options?.signal);
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }] }),
      );
    };
    for (const phase of ["extraction", "assistant"] as const) {
      const result = await requestAI(
        {
          aiBaseUrl: "https://example.invalid/anthropic/",
          aiKey: "test",
          aiModel: "deepseek-flash",
        },
        { max_tokens: 6000, system: "test", messages },
        phase,
      );
      assert.equal(result.body.content[0].text, "ok");
    }
    globalThis.fetch = async () => new Response("unavailable", { status: 502 });
    const failure = await requestAI(
      { aiBaseUrl: "https://example.invalid", aiKey: "test", aiModel: "test" },
      { max_tokens: 6000, system: "", messages: [] },
      "extraction",
    );
    assert.equal(failure.ok, false);
    assert.equal(failure.status, 502);
    assert.equal(failure.body, null);
  } finally {
    globalThis.fetch = original;
  }
});
