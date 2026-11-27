import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  createMailboxService,
  mailboxMessageId,
  mailboxAccountId,
  mailboxConfig,
  mailboxError,
  planFolder,
  MAILBOX_BATCH,
  type MailboxStore,
} from "../server/mailbox.ts";
import {
  splitStructure,
  MAX_BODY_BYTES,
  ImapMailboxProvider,
  type MailboxProvider,
  type MailboxConfig,
  type RemoteMessage,
  type MessageRange,
} from "../server/mailbox-provider.ts";
import { publicSettings, cleanMailboxHtml } from "../server/security.ts";

const config: MailboxConfig = {
  host: "imap.qq.com",
  port: 993,
  user: "fixture@example.test",
  password: "fixture-private-code",
  autoSync: true,
};
function fixture(count = 80) {
  let state: any = null;
  const messages = new Map<string, any>();
  const store: MailboxStore = {
    state: async () => structuredClone(state),
    saveState: async (value) => {
      state = { ...state, ...structuredClone(value) };
      return structuredClone(state);
    },
    message: async (id) => structuredClone(messages.get(id) || null),
    upsert: async (value) => {
      const old = messages.get(value.id);
      const next = {
        ...old,
        ...structuredClone(value),
        revision: (old?.revision || 0) + 1,
      };
      messages.set(value.id, next);
      return structuredClone(next);
    },
    scanMessages: async (accountId, path, afterId, limit) =>
      [...messages.values()]
        .filter(
          (x) =>
            x.accountId === accountId &&
            x.remotePath === path &&
            x.id > afterId &&
            !x.duplicateOf,
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((x) => structuredClone(x)),
  };
  let generation = "1";
  let failBodyAt = 0;
  let bodies = 0;
  let reads = 0;
  let connectError: any;
  let autoSync = true;
  const remote = new Map<string, Map<number, RemoteMessage>>();
  for (const path of ["INBOX", "Sent Messages"])
    remote.set(
      path,
      new Map(
        Array.from({ length: count }, (_, i) => [
          i + 1,
          {
            uid: i + 1,
            read: false,
            subject: `邮件${i + 1}`,
            messageId: `<${path}-${i + 1}@example.test>`,
            inReplyTo: "",
            from: [{ name: "客户", address: "client@example.test" }],
            to: [{ name: "", address: config.user }],
            cc: [],
            date: "2026-11-01T00:00:00.000Z",
            size: 100000000,
          },
        ]),
      ),
    );
  const ranges: MessageRange[] = [];
  const provider: MailboxProvider = {
    connect: async () => {
      if (connectError) throw connectError;
    },
    folders: async () => [
      { folder: "inbox", path: "INBOX" },
      { folder: "sent", path: "Sent Messages" },
    ],
    inspect: async (path) => ({
      uidValidity: generation,
      uidNext: Math.max(0, ...remote.get(path)!.keys()) + 1,
      exists: remote.get(path)!.size,
    }),
    list: async (path, range) => {
      ranges.push(range);
      if (range.start > range.end) return [];
      const rows = [...remote.get(path)!.values()].sort(
        (a, b) => a.uid - b.uid,
      );
      return structuredClone(
        range.uid
          ? rows.filter((x) => x.uid >= range.start && x.uid <= range.end)
          : rows.slice(range.start - 1, range.end),
      );
    },
    body: async (_path, msg) => {
      bodies++;
      if (failBodyAt && bodies === failBodyAt)
        throw new Error("temporary socket failure");
      return {
        text: `正文 ${msg.uid}`,
        html: `<p>正文 ${msg.uid}</p><script>unsafe()</script>`,
        attachments: [
          {
            filename: "材料.zip",
            contentType: "application/zip",
            size: 100000000,
            contentId: "",
            part: "2",
          },
        ],
        bodyTruncated: false,
      };
    },
    flags: async (path, uids) =>
      uids.flatMap((uid) => {
        const m = remote.get(path)!.get(uid);
        return m ? [{ uid, read: m.read }] : [];
      }),
    setRead: async (path, uid, validity, read) => {
      reads++;
      if (validity !== generation) throw new Error("UIDVALIDITY_CHANGED");
      const m = remote.get(path)!.get(uid);
      if (!m) throw new Error("MESSAGE_NOT_FOUND");
      m.read = read;
    },
    close: async () => {},
  };
  let now = Date.now();
  const service = createMailboxService({
    store,
    provider: () => provider,
    config: async () => ({ ...config, autoSync }),
    now: () => now,
  });
  return {
    service,
    store,
    messages,
    remote,
    ranges,
    get state() {
      return state;
    },
    get bodies() {
      return bodies;
    },
    get reads() {
      return reads;
    },
    setGeneration: (value: string) => (generation = value),
    failBody: (n: number) => (failBodyAt = n),
    setError: (err: any) => (connectError = err),
    setAuto: (value: boolean) => (autoSync = value),
    advance: () => (now += 6 * 60 * 1000),
  };
}

test("first synchronization is bounded; incremental rounds cover all history without duplicates", async () => {
  const f = fixture(84);
  await f.service.synchronize();
  assert.equal(f.messages.size, MAILBOX_BATCH * 2);
  assert.equal(f.state.hasMore, true);
  assert.equal(f.reads, 0);
  assert.ok(
    [...f.messages.values()].every(
      (x) => !x.html.includes("script") && x.attachments[0].size === 100000000,
    ),
  );
  for (let i = 0; i < 4; i++) await f.service.synchronize();
  assert.equal(f.messages.size, 168);
  assert.equal(f.state.hasMore, false);
  assert.equal(f.bodies, 168);
  assert.equal(f.reads, 0);
  const revisions = [...f.messages.values()].map((x) => x.revision);
  await f.service.synchronize();
  assert.equal(f.bodies, 168);
  assert.deepEqual(
    [...f.messages.values()].map((x) => x.revision),
    revisions,
  );
  assert.ok(f.ranges.filter((r) => r.uid).every((r) => r.end - r.start < 500));
});

test("sync retries after body failure and preserves a link added after partial completion", async () => {
  const f = fixture(40);
  f.failBody(3);
  await f.service.synchronize();
  assert.equal(f.state.status, "error");
  const first = [...f.messages.values()][0];
  first.taskIds = ["linked-task"];
  f.failBody(0);
  await f.service.synchronize();
  assert.equal(f.state.status, "idle");
  assert.deepEqual(f.messages.get(first.id).taskIds, ["linked-task"]);
  for (let i = 0; i < 3; i++) await f.service.synchronize();
  assert.equal(f.messages.size, 80);
});

test("old QQ read flags, deleted messages and UIDVALIDITY changes reconcile without deleting local history", async () => {
  const f = fixture(70);
  for (let i = 0; i < 4; i++) await f.service.synchronize();
  const account = mailboxAccountId(config);
  const firstId = mailboxMessageId(account, "INBOX", "1", 1);
  f.remote.get("INBOX")!.get(1)!.read = true;
  f.remote.get("INBOX")!.delete(2);
  await f.service.synchronize();
  assert.equal(f.messages.get(firstId).read, true);
  assert.equal(
    f.messages.get(mailboxMessageId(account, "INBOX", "1", 2)).remoteMissing,
    true,
  );
  f.setGeneration("2");
  await f.service.synchronize();
  for (let i = 0; i < 3; i++) await f.service.synchronize();
  assert.equal(f.messages.get(firstId).remoteMissing, true);
  assert.ok(f.messages.has(mailboxMessageId(account, "INBOX", "2", 1)));
});

test("only explicit read operation changes remote state, stale revision is rejected", async () => {
  const f = fixture(2);
  await f.service.synchronize();
  const message = [...f.messages.values()][0];
  const updated = await f.service.changeRead(
    message.id,
    true,
    message.revision,
  );
  assert.equal(f.reads, 1);
  assert.equal(updated.read, true);
  await assert.rejects(
    () => f.service.changeRead(message.id, false, message.revision),
    /邮件已更新/,
  );
  assert.equal(f.reads, 1);
});

test("worker recovers an interrupted state and manual sync continues history when auto sync is off", async () => {
  const f = fixture(90);
  await f.store.saveState({ status: "syncing" });
  await f.service.recover();
  assert.equal(f.state.requested, true);
  assert.equal(f.state.status, "idle");
  f.setAuto(false);
  await f.service.queue();
  assert.equal(f.state.manualRun, true);
  assert.equal(f.state.requested, true);
  for (let i = 0; i < 5; i++) {
    await f.service.tick();
    f.advance();
  }
  assert.equal(f.messages.size, 180);
  assert.equal(f.state.hasMore, false);
  assert.equal(f.state.manualRun, false);
  const bodies = f.bodies;
  await f.service.tick();
  assert.equal(f.bodies, bodies);
});

test("IMAP errors are safe and passwords stay out of public settings", () => {
  const c = mailboxConfig({
    smtpUser: config.user,
    smtpPassword: config.password,
  });
  assert.equal(c.host, "imap.qq.com");
  assert.equal(c.port, 993);
  assert.equal(c.password, config.password);
  const visible = publicSettings({
    imapUser: "",
    smtpUser: config.user,
    imapPassword: "",
    smtpPassword: config.password,
    aiKey: "secret",
  });
  assert.equal(visible.imapConfigured, true);
  assert.equal(visible.imapPasswordInherited, true);
  assert.ok(!("imapPassword" in visible));
  assert.ok(!("smtpPassword" in visible));
  assert.ok(!("aiKey" in visible));
  assert.ok(!JSON.stringify(visible).includes(config.password));
  const message = mailboxError({
    message: `AUTHENTICATIONFAILED password=${config.password}`,
    authenticationFailed: true,
  });
  assert.ok(!message.includes(config.password));
  assert.match(message, /授权码/);
});

test("MIME traversal never selects huge attachments or attached text/rfc822 for body download", () => {
  const result = splitStructure({
    type: "multipart/mixed",
    childNodes: [
      {
        type: "multipart/alternative",
        part: "1",
        childNodes: [
          { type: "text/plain", part: "1.1", size: 80 },
          { type: "text/html", part: "1.2", size: 150 },
        ],
      },
      {
        type: "application/zip",
        part: "2",
        size: 100 * 1024 * 1024,
        disposition: "attachment",
        dispositionParameters: { filename: "材料.zip" },
      },
      {
        type: "text/plain",
        part: "3",
        size: 100000,
        disposition: "attachment",
        dispositionParameters: { filename: "源码.txt" },
      },
      {
        type: "message/rfc822",
        part: "4",
        size: 600,
        childNodes: [{ type: "text/plain", part: "4.1", size: 500 }],
      },
    ],
  });
  assert.deepEqual(
    result.textParts.map((x) => x.part),
    ["1.1", "1.2"],
  );
  assert.equal(result.attachments.length, 3);
  assert.equal(result.attachments[0].size, 100 * 1024 * 1024);
  assert.equal(MAX_BODY_BYTES, 128 * 1024);
});

test("UID gap window never expands to an unbounded fetch", () => {
  const plan = planFolder(
    { uidValidity: "same", exists: 1, uidNext: 5000000 },
    {
      folder: "inbox",
      path: "INBOX",
      uidValidity: "same",
      lastUid: 30,
      beforeUid: 4500000,
      exists: 1,
      synced: 1,
      hasMore: true,
    },
  );
  assert.equal(plan.newer!.end - plan.newer!.start + 1, 500);
  assert.equal(plan.older!.end - plan.older!.start + 1, 500);
});

test("provider downloads only bounded inline text parts with readonly mailbox locking", async () => {
  const provider = new ImapMailboxProvider(config);
  const downloads: any[] = [],
    locks: any[] = [];
  (provider as any).client = {
    mailbox: { uidValidity: 1n, uidNext: 2, exists: 1 },
    getMailboxLock: async (_path: string, options: any) => {
      locks.push(options);
      return { release() {} };
    },
    download: async (uid: string, part: string, options: any) => {
      downloads.push({ uid, part, options });
      return {
        meta: { charset: "utf-8" },
        content: Readable.from([Buffer.alloc(MAX_BODY_BYTES + 100, "x")]),
      };
    },
  };
  const body = await provider.body(
    "INBOX",
    {
      uid: 1,
      read: false,
      subject: "",
      messageId: "",
      inReplyTo: "",
      from: [],
      to: [],
      cc: [],
      date: "",
      size: 150000000,
      structure: {
        type: "multipart/mixed",
        childNodes: [
          { part: "1", type: "text/plain", size: MAX_BODY_BYTES + 100 },
          {
            part: "2",
            type: "application/zip",
            size: 150000000,
            disposition: "attachment",
            dispositionParameters: { filename: "材料.zip" },
          },
        ],
      },
    },
    "1",
  );
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].part, "1");
  assert.equal(downloads[0].options.uid, true);
  assert.equal(downloads[0].options.maxBytes, MAX_BODY_BYTES);
  assert.deepEqual(locks, [{ readOnly: true }]);
  assert.equal(body.text.length, MAX_BODY_BYTES);
  assert.equal(body.bodyTruncated, true);
  assert.equal(body.attachments[0].size, 150000000);
  assert.ok(!("content" in body.attachments[0]));
});

test("mailbox HTML keeps tables and colours while removing external resources and executable content", () => {
  const html = cleanMailboxHtml(
    '<table style="width:100%;background-color:#fff"><tr><td style="color:red" onclick="bad()">客户材料</td></tr></table><img src="https://tracker.test/pixel"><script>bad()</script><iframe src="https://bad.test"></iframe><a href="javascript:bad()">链接</a><p style="background-image:url(https://tracker.test)">说明</p>',
  );
  assert.match(html, /<table/);
  assert.match(html, /<td style="color:red"/);
  assert.match(html, /客户材料/);
  assert.ok(!/tracker|script|iframe|onclick|javascript/.test(html));
});
