import { useCallback, useEffect, useState } from "react";
import {
  ClipboardList,
  Images,
  MessagesSquare,
  Users,
  Mail,
  Settings as SettingsIcon,
  History,
  LogOut,
  RefreshCw,
  X,
  ArrowRight,
  Database,
  ShieldCheck,
  Download,
  Inbox,
  Plus,
  ChevronRight,
} from "lucide-react";
import { api, newTaskDraft, reworkTaskDraft, type Item } from "./api";
import { TaskList, TaskForm, TaskDetail } from "./Tasks";
import Intake from "./Intake";
import Assistant from "./Assistant";
import { MailComposer, Templates, Deliveries } from "./Mail";
import { Mailbox } from "./Mailbox";
import { Busy, Empty, Field, InlineCell } from "./components";

const HOME_PAGE = "tasks";

const nav = [
  ["tasks", "任务工作台", ClipboardList],
  ["assistant", "AI 助手", MessagesSquare],
  ["mailbox", "邮箱管理", Inbox],
  ["customers", "客户档案", Users],
  ["templates", "邮件模板", Mail],
  ["deliveries", "交付记录", History],
  ["settings", "设置", SettingsIcon],
] as const;
export default function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [data, setData] = useState<Item | null>(null),
    [page, setPage] = useState<string>(HOME_PAGE),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [detail, setDetail] = useState<Item | null>(null),
    [edit, setEdit] = useState<Item | null>(null),
    [mail, setMail] = useState<Item | null>(null),
    [refreshing, setRefreshing] = useState(false);
  const notify = useCallback((s: string) => setNotice(s), []);
  const refresh = useCallback(async () => {
    const d = await api("/bootstrap");
    setData((current) => ({
      ...d,
      tasks: d.tasks.map((task: Item) => {
        const local = current?.tasks.find((t: Item) => t.id === task.id);
        return local && local.revision > task.revision ? local : task;
      }),
    }));
    setError("");
  }, []);
  useEffect(() => {
    void api("/session")
      .then((d) => setAuth(d.authenticated))
      .catch((e) => {
        setAuth(false);
        setError(e.message);
      });
    const expired = () => {
      setAuth(false);
      setData(null);
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    if (auth) void refresh().catch((e) => setError(e.message));
  }, [auth, refresh]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!auth) return;
    const t = setInterval(() => void refresh().catch(() => {}), 45000);
    return () => clearInterval(t);
  }, [auth, refresh]);
  const taskSaved = useCallback((saved: Item) => {
    setData((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((task: Item) =>
              task.id === saved.id && task.revision <= saved.revision
                ? saved
                : task,
            ),
          }
        : current,
    );
  }, []);
  function correct(t: Item) {
    setDetail(null);
    setEdit(reworkTaskDraft(t));
  }
  const current = (t: Item) =>
    data?.tasks.find((x: Item) => x.id === t.id) || t;
  const closeDetail = useCallback(() => setDetail(null), []),
    closeEdit = useCallback(() => setEdit(null), []),
    closeMail = useCallback(() => setMail(null), []);
  if (auth === null)
    return (
      <div className="startup">
        <Busy label="连接工作台…" />
      </div>
    );
  if (!auth)
    return (
      <Login
        error={error}
        onLogin={() => {
          setAuth(true);
          setError("");
        }}
      />
    );
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <a
          className="product-name"
          href={`#${HOME_PAGE}`}
          onClick={() => setPage(HOME_PAGE)}
        >
          软著订单工作台<span>订单 · 补正 · 交付</span>
        </a>
        <div className="sidebar-section-label">工作空间</div>
        <nav className="app-navigation" aria-label="工作空间导航">
          {nav.map(([id, label, Icon], index) => (
            <button
              className={
                (page === id ? "active " : "") +
                (index === 3 ? "nav-divider" : "")
              }
              key={id}
              aria-current={page === id ? "page" : undefined}
              onClick={() => {
                setPage(id);
                setError("");
              }}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
              {id === "tasks" &&
                !!data?.tasks?.filter((t: Item) => !t.completed && !t.archived)
                  .length && (
                  <small>
                    {
                      data.tasks.filter(
                        (t: Item) => !t.completed && !t.archived,
                      ).length
                    }
                  </small>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="cloud-dot" />
          <div>
            <strong>云端工作空间</strong>
            <p>记录随操作保存</p>
          </div>
        </div>
        <button
          className="sidebar-logout"
          onClick={() =>
            void api("/logout", {}).then(() => {
              setAuth(false);
              setData(null);
            })
          }
        >
          <LogOut size={16} /> 退出登录
        </button>
      </aside>
      <header className="app-header">
        <div className="workspace-breadcrumb">
          <span>我的工作空间</span>
          <ChevronRight size={14} />
          <strong>{nav.find(([id]) => id === page)?.[1] || "截图录入"}</strong>
        </div>
        <div className="header-utils">
          <span className="header-date">
            {new Date().toLocaleDateString("zh-CN", {
              month: "long",
              day: "numeric",
              weekday: "long",
            })}
          </span>
          <button
            className="icon-button"
            aria-label="刷新数据"
            title="刷新数据"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void refresh()
                .catch((e) => setError(e.message))
                .finally(() => setRefreshing(false));
            }}
          >
            <RefreshCw className={refreshing ? "spin" : ""} size={17} />
          </button>
          <button
            className="header-new"
            onClick={() => setEdit(newTaskDraft())}
          >
            <Plus size={16} />
            手动录入
          </button>
          <button
            className="icon-button mobile-logout"
            aria-label="退出登录"
            onClick={() =>
              void api("/logout", {}).then(() => {
                setAuth(false);
                setData(null);
              })
            }
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <main className="app-main">
        {error && (
          <div className="global-error">
            {error}
            <button
              onClick={() => void refresh().catch((e) => setError(e.message))}
            >
              重试连接
            </button>
          </div>
        )}
        {!data ? (
          <div className="startup">
            <Busy label="读取云端数据…" />
          </div>
        ) : page === "tasks" ? (
          <TaskList
            tasks={data.tasks}
            onRefresh={refresh}
            onNew={() => setEdit(newTaskDraft())}
            onTaskSaved={taskSaved}
            onDetail={setDetail}
            onMail={setMail}
            onCorrection={correct}
            notify={notify}
          />
        ) : page === "assistant" ? (
          <Assistant
            data={data}
            onRefresh={refresh}
            notify={notify}
            onTask={setDetail}
            onMail={setMail}
            onNavigate={setPage}
          />
        ) : page === "intake" ? (
          <Intake
            tasks={data.tasks}
            customers={data.customers}
            intakes={data.intakes}
            onSaved={refresh}
            notify={notify}
            onManual={() => setEdit(newTaskDraft())}
          />
        ) : page === "mailbox" ? (
          <Mailbox
            tasks={data.tasks}
            onTask={setDetail}
            onMail={setMail}
            notify={notify}
            onNavigate={setPage}
          />
        ) : page === "customers" ? (
          <Customers data={data} refresh={refresh} onTask={setDetail} />
        ) : page === "templates" ? (
          <Templates
            templates={data.templates}
            onRefresh={refresh}
            notify={notify}
          />
        ) : page === "deliveries" ? (
          <Deliveries
            deliveries={data.deliveries}
            onRefresh={refresh}
            notify={notify}
            tasks={data.tasks}
            onTask={setDetail}
          />
        ) : (
          <Settings
            config={data.settings}
            refresh={refresh}
            notify={notify}
            onPassword={() => {
              setAuth(false);
              setData(null);
            }}
          />
        )}
      </main>
      <footer className="app-footer">
        <span>
          <Database size={12} /> 云端记录 · 及时保存
        </span>
        <span>压缩包仅临时用于发送</span>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <ShieldCheck size={18} />
          <span>{notice}</span>
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="关闭提示"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {detail && data && (
        <TaskDetail
          task={current(detail)}
          tasks={data.tasks}
          onClose={closeDetail}
          onRefresh={refresh}
          onMail={(t) => {
            setDetail(null);
            setMail(t);
          }}
          onEdit={(t) => {
            setDetail(null);
            setEdit(t);
          }}
          onCorrection={correct}
          notify={notify}
        />
      )}
      {edit && data && (
        <TaskForm
          initial={edit}
          customers={data.customers}
          onClose={closeEdit}
          onSaved={refresh}
          notify={notify}
        />
      )}
      {mail && data && (
        <MailComposer
          task={current(mail)}
          templates={data.templates}
          sender={data.settings.smtpUser}
          onClose={closeMail}
          onRefresh={refresh}
          notify={notify}
        />
      )}
    </div>
  );
}
function Login({
  onLogin,
  error: initialError,
}: {
  onLogin: () => void;
  error: string;
}) {
  const [username, setUsername] = useState("admin"),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initialError);
  return (
    <div className="login-page">
      <div className="login-intro">
        <div className="login-brand">软著订单工作台</div>
        <div className="login-scene">
          <img
            src="/desk-scene.svg"
            alt="聊天记录、软著资料与交付信封组成的工作桌面"
          />
        </div>
        <div className="login-caption">
          <h1>
            从一张聊天截图，
            <br />
            到一份交付记录。
          </h1>
          <p>新单有进度，补正有来处，交付有记录。</p>
        </div>
      </div>
      <div className="login-form-wrap">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            void api("/login", { username, password })
              .then(onLogin)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <p className="context-line">你的订单工作空间</p>
          <h2>登录工作台</h2>
          <Field label="账号">
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="密码">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy}>
            {busy ? (
              <Busy label="登录中" />
            ) : (
              <>
                进入工作台
                <ArrowRight size={17} />
              </>
            )}
          </button>
          <p className="login-help">
            初始登录信息保存在项目的私有登录信息文件中。
          </p>
        </form>
      </div>
    </div>
  );
}
function Customers({
  data,
  refresh,
  onTask,
}: {
  data: Item;
  refresh: () => Promise<void>;
  onTask: (t: Item) => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
  const customers = data.customers.filter((c: Item) =>
    [c.name, c.email, c.wechat, c.memberName].join(" ").includes(query),
  );
  async function patch(c: Item, key: string, value: string) {
    await api("/customers/" + c.id, { ...c, [key]: value }, "PATCH");
    await refresh();
  }
  const customer = data.customers.find((c: Item) => c.id === selected),
    tasks = data.tasks.filter((t: Item) => t.customerId === selected);
  return (
    <div className="page customers-page">
      <div className="page-heading">
        <div>
          <p className="context-line">客户资料与历次购买</p>
          <h1>
            客户档案{" "}
            <span className="heading-count">{data.customers.length} 位</span>
          </h1>
        </div>
        <input
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索昵称、邮箱或微信"
        />
      </div>
      <div className="customers-layout">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>客户昵称</th>
                <th>邮箱</th>
                <th>微信 / 其他联系</th>
                <th>软件任务</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c: Item) => (
                <tr
                  key={c.id}
                  className={selected === c.id ? "selected" : ""}
                  onClick={() => setSelected(c.id)}
                >
                  <td>
                    <InlineCell
                      value={c.name}
                      onSave={(v) => patch(c, "name", v)}
                    />
                    <small className="block muted">{c.memberName || "—"}</small>
                  </td>
                  <td>
                    <InlineCell
                      value={c.email}
                      onSave={(v) => patch(c, "email", v)}
                    />
                  </td>
                  <td>
                    <InlineCell
                      value={c.wechat}
                      onSave={(v) => patch(c, "wechat", v)}
                    />
                  </td>
                  <td className="num">
                    {
                      data.tasks.filter((t: Item) => t.customerId === c.id)
                        .length
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!customers.length && (
            <Empty
              title="暂无客户档案"
              description="录入新单或补正时，会同时创建客户档案。"
            />
          )}
        </div>
        <aside className="customer-history">
          {customer ? (
            <>
              <h2>{customer.name}</h2>
              <p>{customer.email || "尚未留邮箱"}</p>
              <div className="customer-notes">
                <span>客户备注 · 双击编辑</span>
                <InlineCell
                  value={customer.notes}
                  onSave={(v) => patch(customer, "notes", v)}
                  multiline
                />
              </div>
              <h3>关联任务</h3>
              {tasks.map((t: Item) => (
                <button
                  className="customer-task"
                  key={t.id}
                  onClick={() => onTask(t)}
                >
                  <small>
                    {t.kind === "new" ? "新单" : "补正"} ·{" "}
                    {t.completed ? "已完成" : "未完成"}
                  </small>
                  <strong>{t.softwareName || "名称待定"}</strong>
                  {t.originalName && <span>原名：{t.originalName}</span>}
                </button>
              ))}
            </>
          ) : (
            <Empty
              title="选择一位客户"
              description="查看对应的软件和补正记录。"
            />
          )}
        </aside>
      </div>
    </div>
  );
}
function Settings({
  config,
  refresh,
  notify,
  onPassword,
}: {
  config: Item;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  onPassword: () => void;
}) {
  const [form, setForm] = useState<Item>({
      ...config,
      aiKey: "",
      smtpPassword: "",
      imapPassword: "",
      imapHost: config.imapHost || "imap.qq.com",
      imapPort: config.imapPort || 993,
      imapUser: config.imapUser || "",
      autoSync: config.autoSync ?? false,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [current, setCurrent] = useState(""),
    [next, setNext] = useState("");
  const set = (k: string, v: any) => setForm((s) => ({ ...s, [k]: v }));
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/settings", form);
      setForm((v) => ({ ...v, aiKey: "", smtpPassword: "", imapPassword: "" }));
      await refresh();
      notify("连接配置已保存");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <p className="context-line">接入与数据管理</p>
          <h1>设置</h1>
        </div>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? <Busy label="保存中" /> : "保存连接配置"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="settings-scroll">
        <section className="settings-section">
          <div>
            <h2>AI 助手</h2>
            <p>识别聊天内容，生成待核对的订单信息。</p>
            <span className="connection-state">
              {config.aiConfigured ? "已配置密钥" : "尚未配置"}
            </span>
          </div>
          <div className="form-grid">
            <Field label="接口地址" wide>
              <input
                value={form.aiBaseUrl}
                onChange={(e) => set("aiBaseUrl", e.target.value)}
              />
            </Field>
            <Field label="模型">
              <input
                value={form.aiModel}
                onChange={(e) => set("aiModel", e.target.value)}
              />
            </Field>
            <Field label="API Key">
              <input
                type="password"
                autoComplete="off"
                value={form.aiKey}
                placeholder="已配置时留空保持原值"
                onChange={(e) => set("aiKey", e.target.value)}
              />
            </Field>
          </div>
        </section>
        <section className="settings-section">
          <div>
            <h2>邮件发送</h2>
            <p>使用授权码连接，发送前核对收件人和附件。</p>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void api("/settings/verify-mail", {})
                  .then((r) => notify(r.message))
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              验证已保存的连接
            </button>
          </div>
          <div className="form-grid">
            <Field label="发件邮箱">
              <input
                value={form.smtpUser}
                onChange={(e) => set("smtpUser", e.target.value)}
              />
            </Field>
            <Field label="邮箱授权码">
              <input
                type="password"
                autoComplete="off"
                value={form.smtpPassword}
                placeholder="留空保持原值"
                onChange={(e) => set("smtpPassword", e.target.value)}
              />
            </Field>
            <Field label="SMTP服务器">
              <input
                value={form.smtpHost}
                onChange={(e) => set("smtpHost", e.target.value)}
              />
            </Field>
            <Field label="端口">
              <input
                type="number"
                value={form.smtpPort}
                onChange={(e) => set("smtpPort", Number(e.target.value))}
              />
            </Field>
            <Field label="整封邮件上限（MiB）">
              <input
                type="number"
                value={form.mailMaxBytes / 1048576}
                onChange={(e) =>
                  set("mailMaxBytes", Number(e.target.value) * 1048576)
                }
              />
            </Field>
          </div>
        </section>
        <section className="settings-section">
          <div>
            <h2>收件同步</h2>
            <p>将邮箱收件和已发邮件同步到工作台，按客户和任务整理。</p>
            <span className="connection-state">
              {config.imapConfigured ? "已配置收件连接" : "尚未配置收件连接"}
            </span>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void api("/mailbox/verify", {})
                  .then((r) => notify(r.message || "收件连接正常"))
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              验证已保存的收件连接
            </button>
          </div>
          <div className="form-grid">
            <Field label="收件账号">
              <input
                value={form.imapUser}
                placeholder="留空沿用发件邮箱"
                onChange={(e) => set("imapUser", e.target.value)}
              />
            </Field>
            <Field label="收件授权码">
              <input
                type="password"
                autoComplete="off"
                value={form.imapPassword}
                placeholder="留空保持；未设置时沿用发信授权码"
                onChange={(e) => set("imapPassword", e.target.value)}
              />
            </Field>
            <Field label="IMAP服务器">
              <input
                value={form.imapHost}
                onChange={(e) => set("imapHost", e.target.value)}
              />
            </Field>
            <Field label="TLS端口">
              <input
                type="number"
                value={form.imapPort}
                onChange={(e) => set("imapPort", Number(e.target.value))}
              />
            </Field>
            <label className="checkbox-field settings-checkbox">
              <input
                type="checkbox"
                checked={!!form.autoSync}
                onChange={(e) => set("autoSync", e.target.checked)}
              />
              开启自动同步
            </label>
            <p className="field-hint">
              以上配置保存后生效。QQ邮箱需开启 IMAP 服务。
            </p>
          </div>
        </section>
        <section className="settings-section">
          <div>
            <h2>数据与备份</h2>
            <p>
              业务资料、原始截图和模板附件保存在云端MySQL，临时发送附件不长期保存。
            </p>
          </div>
          <div className="data-settings">
            <p>
              <Database size={17} /> 腾讯云 MySQL <b>{config.dbName}</b>
            </p>
            <p>
              导出包含客户、任务、模板、交付、修改记录和原始截图；不包含登录凭据及临时压缩包。
            </p>
            <a className="button" href="/api/v1/export" download>
              <Download size={16} />
              下载完整业务备份
            </a>
          </div>
        </section>
        <section className="settings-section">
          <div>
            <h2>登录密码</h2>
            <p>修改后会退出所有登录会话。</p>
          </div>
          <div className="form-grid">
            <Field label="当前密码">
              <input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label="新密码（至少10位）">
              <input
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <button
              disabled={busy || !current || next.length < 10}
              onClick={() => {
                setBusy(true);
                void api("/password", { current, next })
                  .then(onPassword)
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              修改登录密码
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
