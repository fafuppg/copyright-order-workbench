import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { createTransport } from "nodemailer";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import {
  outgoingMimeMessageId,
  outgoingMessageIds,
} from "../server/mailbox.ts";

test("raw SMTP metadata differs unless actual compiled Message-ID is supplied", async () => {
  const received: string[] = [];
  const smtp = new SMTPServer({
    secure: false,
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    logger: false,
    onData(stream, _session, callback) {
      void (async () => {
        try {
          const parsed = await simpleParser(stream);
          received.push(parsed.messageId || "");
          callback();
        } catch (error) {
          callback(error as Error);
        }
      })();
    },
  });
  await new Promise<void>((resolve, reject) => {
    smtp.once("error", reject);
    smtp.listen(0, "127.0.0.1", resolve);
  });
  const address = smtp.server.address() as AddressInfo;
  const transport = createTransport({
    host: "127.0.0.1",
    port: address.port,
    secure: false,
    ignoreTLS: true,
    logger: false,
    debug: false,
  });
  try {
    const messageId = outgoingMimeMessageId("fixed-fixture-delivery");
    const compiled = await createTransport({
      streamTransport: true,
      buffer: true,
      newline: "windows",
    }).sendMail({
      from: "fixture@example.test",
      to: "recipient@example.test",
      subject: "本地模拟",
      text: "模拟邮件，不连接真实邮箱。",
      messageId,
    });
    const envelope = {
      from: "fixture@example.test",
      to: ["recipient@example.test"],
    };
    const oldResult = await transport.sendMail({
      envelope,
      raw: Readable.from([compiled.message]),
    });
    assert.equal(received[0], messageId);
    assert.notEqual(
      oldResult.messageId,
      messageId,
      "the raw wrapper generates a different metadata ID without the explicit option",
    );
    const fixedResult = await transport.sendMail({
      envelope,
      messageId: compiled.messageId,
      raw: Readable.from([compiled.message]),
    });
    assert.equal(received[1], messageId);
    assert.equal(fixedResult.messageId, compiled.messageId);
    assert.deepEqual(
      received,
      [messageId, messageId],
      "passing messageId metadata does not rewrite the raw MIME",
    );
  } finally {
    transport.close();
    await new Promise<void>((resolve) => smtp.close(resolve));
  }
});

test("historical compatibility uses only exact known MIME and stored metadata IDs", () => {
  const delivery = {
    id: "fixture-original-id",
    messageId: "<legacy-generated-wrapper@localhost>",
  };
  const ids = outgoingMessageIds(delivery);
  assert.deepEqual(ids, [
    "<fixture-original-id@copyright-workbench.local>",
    "<legacy-generated-wrapper@localhost>",
  ]);
  assert.ok(!ids.includes("<qq-rewritten-message@example.test>"));
  assert.deepEqual(outgoingMessageIds({ id: delivery.id, messageId: ids[0] }), [
    ids[0],
  ]);
  assert.deepEqual(outgoingMessageIds({ id: delivery.id }), [ids[0]]);
});
