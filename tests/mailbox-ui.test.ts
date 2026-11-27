import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

// The component is exercised in memory; no browser, CSS engine, or database.
const css = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith(".css")
      ? { format: "module", source: "export {};", shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { Mailbox } = await import("../src/Mailbox.tsx");
css.deregister();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const text = (node: any): string =>
  typeof node === "string" ? node : (node.children || []).map(text).join("");
const mail = (id: string) => ({
  id,
  revision: 1,
  subject: `邮件 ${id}`,
  folder: "inbox",
  source: "imap",
  from: [{ name: "客户", address: "client@example.test" }],
  to: [],
  read: false,
  taskIds: [],
  text: `正文 ${id}`,
  date: "2026-11-27T00:00:00.000Z",
});

async function fixture(t: TestContext, persistRead = false) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const messages = new Map<string, any>([
    ["A", mail("A")],
    ["B", mail("B")],
  ]);
  let visible = ["A", "B"];
  const pending = new Map<string, ReturnType<typeof deferred>[]>();
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", (async (
    url: string,
    init?: RequestInit,
  ) => {
    const parsed = new URL(url, "http://fixture.test");
    const method = init?.method || "GET";
    const key = method + " " + parsed.pathname;
    calls.push(key);
    const waiting = pending.get(key)?.shift();
    let value: any;
    if (waiting) value = await waiting.promise;
    else if (parsed.pathname.endsWith("/status"))
      value = {
        status: "idle",
        configured: true,
        autoSync: false,
        counts: { inbox: visible.length, sent: 0, unread: 2 },
      };
    else if (parsed.pathname.endsWith("/messages")) {
      const items = visible
        .map((id) => messages.get(id))
        .filter(
          (m) =>
            (parsed.searchParams.get("folder") === "all" ||
              m.folder === parsed.searchParams.get("folder")) &&
            (!parsed.searchParams.has("unread") || !m.read),
        );
      value = { items, total: items.length, page: 1, pageSize: 30 };
    } else if (method === "PATCH" && parsed.pathname.endsWith("/read")) {
      const id = parsed.pathname.split("/").at(-2)!;
      const old = messages.get(id);
      // Existing tests isolate draft races from read-flag changes; dedicated
      // read tests enable persistence and verify the real revision transition.
      value = persistRead
        ? {
            ...old,
            read: JSON.parse(String(init?.body)).read,
            revision: old.revision + 1,
          }
        : old;
      messages.set(id, value);
    } else if (method === "GET")
      value = messages.get(parsed.pathname.split("/").at(-1)!);
    else throw new Error("Unexpected request " + key);
    if (!value) throw new Error("Missing fixture for " + key);
    const snapshot = structuredClone(value);
    return { ok: true, status: 200, json: async () => snapshot };
  }) as any);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      React.createElement(Mailbox, {
        tasks: [
          {
            id: "task-1",
            softwareName: "软件一",
            email: "client@example.test",
          },
          { id: "task-2", softwareName: "软件二", email: "other@example.test" },
        ],
        onTask() {},
        onMail() {},
        notify() {},
        onNavigate() {},
      }),
    );
  });
  await act(async () => {
    t.mock.timers.tick(300);
  });
  t.after(async () => {
    await act(async () => tree.unmount());
  });
  const button = (label: string) =>
    tree.root.findAllByType("button").find((b) => text(b) === label)!;
  const checkbox = () =>
    tree.root
      .findByProps({ className: "mailbox-task-options" })
      .findAllByType("label")
      .find((l) => text(l).includes("软件一"))!
      .findByType("input");
  return {
    tree,
    messages,
    calls,
    button,
    checkbox,
    visible(ids: string[]) {
      visible = ids;
    },
    delay(key: string) {
      const result = deferred();
      pending.set(key, [...(pending.get(key) || []), result]);
      return result;
    },
    async poll() {
      await act(async () => {
        t.mock.timers.tick(20000);
      });
    },
    async edit() {
      await act(async () => button("关联任务").props.onClick());
      await act(async () =>
        checkbox().props.onChange({ target: { checked: true } }),
      );
    },
    async select(id: string) {
      const target = tree.root
        .findAllByType("button")
        .find(
          (b) =>
            String(b.props.className || "").includes("mailbox-message-row") &&
            text(b).includes(`邮件 ${id}`),
        )!;
      await act(async () => target.props.onClick());
    },
    subject() {
      return text(
        tree.root
          .findByProps({ className: "mailbox-message-header" })
          .findByType("h2"),
      );
    },
    alerts() {
      return tree.root.findAllByProps({ role: "alert" }).map(text).join(" ");
    },
  };
}

test("background pagination changes preserve the association draft and check the off-page message version", async (t) => {
  const f = await fixture(t);
  await f.edit();
  const before = f.calls.filter(
    (c) => c === "GET /api/v1/mailbox/messages/A",
  ).length;
  f.visible(["B"]);
  await f.poll();
  assert.equal(f.subject(), "邮件 A");
  assert.equal(f.checkbox().props.checked, true);
  assert.ok(
    f.calls.filter((c) => c === "GET /api/v1/mailbox/messages/A").length >
      before,
  );
  assert.equal(f.button("保存关联").props.disabled, false);
  f.messages.get("A").revision = 2;
  await f.poll();
  assert.equal(f.subject(), "邮件 A");
  assert.equal(f.checkbox().props.checked, true);
  assert.equal(f.button("保存关联").props.disabled, true);
  assert.match(f.alerts(), /关联选择仍保留/);
});

test("a remote read change can remove an edited message from unread results without discarding its draft", async (t) => {
  const f = await fixture(t);
  await act(async () =>
    f.tree.root
      .findByProps({ className: "mailbox-unread" })
      .findByType("input")
      .props.onChange({ target: { checked: true } }),
  );
  await f.edit();
  Object.assign(f.messages.get("A"), { read: true, revision: 2 });
  await f.poll();
  assert.equal(f.subject(), "邮件 A");
  assert.equal(f.checkbox().props.checked, true);
  assert.equal(f.button("保存关联").props.disabled, true);
  // An explicit folder choice still replaces the current selection normally.
  await act(async () =>
    f.tree.root
      .findByProps({ className: "mailbox-folder-list" })
      .findAllByType("button")[1]
      .props.onClick(),
  );
  assert.equal(
    f.tree.root.findAllByProps({ className: "mailbox-link-editor" }).length,
    0,
  );
  assert.equal(
    f.tree.root.findAllByProps({ className: "mailbox-message-header" }).length,
    0,
  );
});

test("background refresh does not replace a message while its association save is pending", async (t) => {
  const f = await fixture(t);
  await f.edit();
  const saving = f.delay("PATCH /api/v1/mailbox/messages/A/link");
  await act(async () => f.button("保存关联").props.onClick());
  assert.equal(f.checkbox().props.disabled, true);
  f.visible(["B"]);
  await f.poll();
  assert.equal(f.subject(), "邮件 A");
  assert.equal(f.checkbox().props.checked, true);
  await act(async () => saving.reject(new Error("保存暂时失败")));
  assert.equal(f.subject(), "邮件 A");
  assert.equal(f.checkbox().props.checked, true);
  assert.match(f.alerts(), /保存暂时失败/);
});

test("late background detail success or failure cannot change a newly selected message", async (t) => {
  const f = await fixture(t);
  for (const fail of [false, true]) {
    await f.select("A");
    f.messages.get("A").revision++;
    const request = f.delay("GET /api/v1/mailbox/messages/A");
    await f.poll();
    await f.select("B");
    await act(async () => {
      if (fail) request.reject(new Error("旧邮件加载失败"));
      else
        request.resolve({ ...f.messages.get("A"), subject: "过期的 A 内容" });
    });
    assert.equal(f.subject(), "邮件 B");
    assert.equal(f.alerts(), "");
    assert.equal(
      f.tree.root.findByProps({ className: "mailbox-reader" }).props[
        "aria-busy"
      ],
      false,
    );
  }
});

test("explicit detail retry retains the draft on failure and accepts the new version only after success", async (t) => {
  const f = await fixture(t);
  await f.edit();
  f.messages.get("A").revision = 2;
  await f.poll();
  const retry = f.delay("GET /api/v1/mailbox/messages/A");
  await act(async () => f.button("重新读取").props.onClick());
  await act(async () => retry.reject(new Error("重读暂时失败")));
  assert.equal(f.checkbox().props.checked, true);
  assert.equal(f.button("保存关联").props.disabled, true);
  assert.match(f.alerts(), /重读暂时失败/);
  await act(async () => f.button("重新读取").props.onClick());
  assert.equal(f.subject(), "邮件 A");
  assert.equal(
    f.tree.root.findAllByProps({ className: "mailbox-link-editor" }).length,
    0,
  );
  assert.equal(f.alerts(), "");
});

test("opening a message automatically syncs read state but manual unread is retained", async (t) => {
  const f = await fixture(t, true);
  assert.equal(f.messages.get("A").read, true);
  assert.equal(f.messages.get("B").read, false);
  assert.equal(
    f.calls.filter((x) => x === "PATCH /api/v1/mailbox/messages/A/read").length,
    1,
  );
  await act(async () => f.button("标为未读").props.onClick());
  assert.equal(f.messages.get("A").read, false);
  await f.poll();
  assert.equal(f.messages.get("A").read, false);
});
