(async () => {
  function notice(text, error = false) {
    document.getElementById("workbench-autofill-status")?.remove();
    const el = document.createElement("div");
    el.id = "workbench-autofill-status";
    el.textContent = text;
    el.setAttribute("role", "status");
    Object.assign(el.style, {
      position: "fixed",
      top: "12px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      background: error ? "#7c2d12" : "#173d2c",
      color: "#fff",
      padding: "12px 20px",
      borderRadius: "8px",
      fontSize: "14px",
      maxWidth: "80vw",
    });
    (document.body || document.documentElement).append(el);
    setTimeout(() => el.remove(), 20000);
  }
  let credentials;
  try {
    credentials = await chrome.runtime.sendMessage({
      type: "workbench-copyright-take",
    });
  } catch {
    notice(
      "扩展连接已失效，请重新加载扩展并刷新工作台，再点击订单登录入口。",
      true,
    );
    return;
  }
  if (!credentials?.ok) return;
  let observer,
    timer,
    polling,
    finished = false,
    verifying = false;
  const clear = () => {
    finished = true;
    observer?.disconnect();
    clearTimeout(timer);
    clearInterval(polling);
    credentials.account = "";
    credentials.password = "";
  };
  const visible = (input) =>
    input && !input.disabled && input.getClientRects().length;
  function findFields() {
    // Search visible inputs: hidden password/SMS panes must never capture credentials.
    const roots = [
      ...document.querySelectorAll(".login_content, .login_dialog, .login_pwd"),
    ];
    for (const root of roots) {
      const account = [
        ...root.querySelectorAll(
          '.login_input input, input[placeholder*="用户名"], input[placeholder*="账号"]',
        ),
      ].find(visible);
      const password = [
        ...root.querySelectorAll(
          '.hd_input_pwd input, input[type="password"][placeholder*="密码"]',
        ),
      ].find(visible);
      if (account && password) return { account, password };
    }
    return null;
  }
  function fill() {
    if (finished || verifying) return;
    const fields = findFields();
    if (!fields) return;
    const { account, password } = fields;
    if (
      (account.value && account.value !== credentials.account) ||
      (password.value && password.value !== credentials.password)
    ) {
      clear();
      notice(
        "登录框已有另一组账号或密码，未覆盖。请清空登录框，再从工作台重新打开对应订单。",
        true,
      );
      return;
    }
    const expectedAccount = credentials.account,
      expectedPassword = credentials.password;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set;
    verifying = true;
    for (const [input, value] of [
      [account, expectedAccount],
      [password, expectedPassword],
    ]) {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Verify after the site's UI has processed the input events; don't report success just for opening a tab.
    setTimeout(() => {
      if (finished) return;
      const current = findFields();
      const success =
        current?.account.value === expectedAccount &&
        current?.password.value === expectedPassword;
      clear();
      notice(
        success
          ? "账号密码已预填，请核对用户类型，完成验证码并自行点击登录。"
          : "页面未保留填入内容，请返回工作台复制账号密码；没有自动提交登录。",
        !success,
      );
    }, 400);
  }
  observer = new MutationObserver(fill);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  polling = setInterval(fill, 400);
  timer = setTimeout(() => {
    clear();
    notice(
      "未找到可填写的密码登录框。请选择“密码登录”，再从工作台打开；若已登录，请先退出当前账号。",
      true,
    );
  }, 45000);
  window.addEventListener("pagehide", clear, { once: true });
  fill();
})();
