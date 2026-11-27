import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";

test("autofill extension binds one-time credentials to the created tab and trusted sites", async () => {
  const state: Record<string, any> = {};
  let listener: any;
  const updates: any[] = [];
  const context = vm.createContext({
    URL,
    Date,
    chrome: {
      storage: {
        session: {
          get: async (key: string) =>
            key ? { [key]: state[key] } : { ...state },
          set: async (data: any) => Object.assign(state, data),
          remove: async (key: string) => {
            delete state[key];
          },
        },
      },
      tabs: {
        create: async () => ({ id: 42 }),
        update: async (...args: any[]) => updates.push(args),
        onRemoved: { addListener() {} },
      },
      runtime: {
        onMessage: {
          addListener(fn: any) {
            listener = fn;
          },
        },
      },
    },
  });
  vm.runInContext(
    await fs.readFile("extensions/copyright-login/background.js", "utf8"),
    context,
  );
  const call = (message: any, url: string, tab = 42, frameId = 0) =>
    new Promise<any>((resolve) =>
      listener(message, { url, frameId, tab: { id: tab } }, resolve),
    );
  const open = {
    type: "workbench-copyright-open",
    account: "user",
    password: "P@ss!",
  };
  assert.equal((await call(open, "https://evil.test")).ok, false);
  assert.equal((await call(open, "http://127.0.0.1:9000")).ok, false);
  assert.equal((await call(open, "http://127.0.0.1:3210", 1, 1)).ok, false);
  assert.equal((await call(open, "http://127.0.0.1:3210")).ok, true);
  assert.equal(state["login:42"].password, "P@ss!");
  assert.ok(!JSON.stringify(updates).includes("P@ss!"));
  const take = { type: "workbench-copyright-take" };
  assert.equal(
    (await call(take, "https://register.ccopyright.com.cn/login.html", 43)).ok,
    false,
  );
  assert.equal(
    (await call(take, "https://register.ccopyright.com.cn/other.html")).ok,
    false,
  );
  const result = await call(
    take,
    "https://register.ccopyright.com.cn/login.html",
  );
  assert.equal(result.password, "P@ss!");
  assert.equal(state["login:42"], undefined);
  assert.equal(
    (await call(take, "https://register.ccopyright.com.cn/login.html")).ok,
    false,
  );
  await call(open, "http://localhost:3210");
  state["login:42"]!.expires = 0;
  assert.equal(
    (await call(take, "https://register.ccopyright.com.cn/login.html")).ok,
    false,
  );
});

test("autofill fills only the password form, fires input events, and never submits", async () => {
  const makeInput = (value = "") => {
    const x: any = {
      value,
      events: [],
      getClientRects: () => [1],
      dispatchEvent(e: any) {
        this.events.push(e.type);
      },
    };
    return x;
  };
  async function run(existing = "", delayed = false) {
    const account = makeInput(existing),
      password = makeInput();
    let disconnected = false,
      submitted = false;
    const notices: string[] = [];
    let poll: (() => void) | undefined;
    let visible = !delayed;
    function Input() {}
    Object.defineProperty(Input.prototype, "value", {
      set(v) {
        (this as any).value = v;
      },
    });
    const context = vm.createContext({
      chrome: {
        runtime: {
          sendMessage: async () => ({
            ok: true,
            account: "user",
            password: "pass",
          }),
        },
      },
      HTMLInputElement: Input,
      Event: class {
        constructor(public type: string) {}
      },
      MutationObserver: class {
        observe() {}
        disconnect() {
          disconnected = true;
        }
      },
      setTimeout: (fn: () => void, ms: number) => {
        if (ms === 400) queueMicrotask(fn);
        return 1;
      },
      clearTimeout() {},
      setInterval: (fn: () => void) => {
        poll = fn;
        return 2;
      },
      clearInterval() {},
      window: { addEventListener() {} },
      document: {
        documentElement: {},
        getElementById: () => null,
        querySelectorAll: () =>
          visible
            ? [
                {
                  querySelectorAll: (s: string) => [
                    s.includes("login_input") ? account : password,
                  ],
                },
              ]
            : [],
        createElement: () => ({
          style: {},
          setAttribute() {},
          remove() {},
          textContent: "",
        }),
        body: { append: (e: any) => notices.push(e.textContent) },
        submit: () => {
          submitted = true;
        },
      },
    });
    await vm.runInContext(
      await fs.readFile("extensions/copyright-login/fill.js", "utf8"),
      context,
    );
    if (delayed) {
      visible = true;
      poll?.();
    }
    await Promise.resolve();
    return { account, password, disconnected, submitted, notices };
  }
  const empty = await run();
  assert.equal(empty.account.value, "user");
  assert.equal(empty.password.value, "pass");
  assert.deepEqual(empty.account.events, ["input", "change"]);
  assert.equal(empty.submitted, false);
  assert.equal(empty.disconnected, true);
  const matching = await run("user");
  assert.equal(matching.password.value, "pass");
  const later = await run("", true);
  assert.equal(later.password.value, "pass");
  assert.match(later.notices[0], /已预填/);
  const populated = await run("existing");
  assert.equal(populated.account.value, "existing");
  assert.equal(populated.password.value, "");
  assert.match(populated.notices[0], /未覆盖/);
});

test("row login opens a clean new-tab URL and passes credentials only to the extension bridge", async () => {
  const React = await import("react");
  const { create, act } = await import("react-test-renderer");
  const { CopyrightLogin, COPYRIGHT_URL } =
    await import("../src/CopyrightLogin.tsx");
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const oldWindow = (globalThis as any).window,
    oldDocument = (globalThis as any).document;
  const events = new EventTarget();
  (globalThis as any).window = events;
  (globalThis as any).document = {
    documentElement: { dataset: { copyrightAutofill: "1" } },
  };
  let request: any, tree: any;
  const notices: string[] = [];
  events.addEventListener("copyright-autofill-request", (e) => {
    request = (e as CustomEvent).detail;
    events.dispatchEvent(
      new CustomEvent("copyright-autofill-result", {
        detail: { requestId: request.requestId, ok: true },
      }),
    );
  });
  try {
    await act(async () => {
      tree = create(
        React.createElement(CopyrightLogin, {
          task: { filingAccount: "account", filingPassword: "secret" },
          notify: (s) => notices.push(s),
        }),
      );
    });
    const link = tree.root.findByType("a");
    assert.equal(link.props.target, "_blank");
    assert.equal(link.props.href, COPYRIGHT_URL);
    let prevented = false;
    await act(async () =>
      link.props.onClick({
        preventDefault() {
          prevented = true;
        },
      }),
    );
    assert.equal(prevented, true);
    assert.equal(request.password, "secret");
    assert.ok(notices.some((x) => x.includes("已打开版权中心")));
    assert.ok(!link.props.href.includes("secret"));
  } finally {
    if (tree) await act(async () => tree.unmount());
    (globalThis as any).window = oldWindow;
    (globalThis as any).document = oldDocument;
  }
});
