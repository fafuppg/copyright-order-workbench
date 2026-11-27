const LOGIN = "https://register.ccopyright.com.cn/login.html";
const CENTER = "https://register.ccopyright.com.cn/account.html";
function workbench(url) {
  try {
    return ["http://127.0.0.1:3210", "http://localhost:3210"].includes(
      new URL(url).origin,
    );
  } catch {
    return false;
  }
}
async function handle(message, sender) {
  if (sender.frameId !== 0) throw new Error("仅支持主页面");
  if (message?.type === "workbench-copyright-open" && workbench(sender.url)) {
    const { account, password } = message;
    if (
      typeof account !== "string" ||
      typeof password !== "string" ||
      !account ||
      !password ||
      account.length > 5000 ||
      password.length > 5000
    )
      throw new Error("请先补充账号和密码");
    // Remove expired entries. Session storage never writes credentials to disk.
    const entries = await chrome.storage.session.get(null);
    for (const [key, entry] of Object.entries(entries))
      if (key.startsWith("login:") && entry.expires < Date.now())
        await chrome.storage.session.remove(key);
    const tab = await chrome.tabs.create({ url: "about:blank", active: true });
    const key = "login:" + tab.id;
    try {
      await chrome.storage.session.set({
        [key]: { account, password, expires: Date.now() + 120000 },
      });
      await chrome.tabs.update(tab.id, {
        url: LOGIN + "?linkBackUrl=" + CENTER,
      });
    } catch (error) {
      await chrome.storage.session.remove(key);
      throw error;
    }
    return { ok: true };
  }
  if (message?.type === "workbench-copyright-take" && sender.tab?.id != null) {
    const url = new URL(sender.url);
    if (
      url.origin !== "https://register.ccopyright.com.cn" ||
      url.pathname !== "/login.html"
    )
      throw new Error("页面不匹配");
    const key = "login:" + sender.tab.id;
    const entry = (await chrome.storage.session.get(key))[key];
    await chrome.storage.session.remove(key);
    if (!entry || entry.expires < Date.now()) return { ok: false };
    return { ok: true, account: entry.account, password: entry.password };
  }
  throw new Error("请求来源不匹配");
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then(sendResponse)
    .catch(() =>
      sendResponse({
        ok: false,
        error: "未能预填，请刷新工作台重试或使用复制按钮。",
      }),
    );
  return true;
});
chrome.tabs.onRemoved.addListener((id) => {
  void chrome.storage.session.remove("login:" + id);
});
