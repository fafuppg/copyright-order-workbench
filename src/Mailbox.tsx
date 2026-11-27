import { useEffect, useRef, useState } from "react";
import {
  Inbox,
  Send,
  Mail,
  MailOpen,
  RefreshCw,
  Search,
  Settings,
  Paperclip,
  ChevronLeft,
  ChevronRight,
  Link2,
  Check,
  X,
  ArrowUpRight,
  FileText,
} from "lucide-react";
import { api, bytes, type Item } from "./api";
import { Busy, MailPreview } from "./components";
import "./mailbox.css";

type Props = {
  tasks: Item[];
  onTask: (task: Item) => void;
  onMail: (task: Item) => void;
  notify: (message: string) => void;
  onNavigate: (page: string) => void;
};
const folders = [
  { id: "inbox", label: "收件箱", icon: Inbox },
  { id: "sent", label: "已发送", icon: Send },
  { id: "all", label: "全部邮件", icon: Mail },
];
function addresses(value: Item[] = [], short = false) {
  return value
    .map((v) =>
      short
        ? v.name || v.address
        : v.name
          ? `${v.name} <${v.address}>`
          : v.address,
    )
    .join("、");
}
function mailDate(value?: string, full = false) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "日期未知";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(full ? { year: "numeric" } : {}),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function isSyncing(status?: string) {
  return ["queued", "syncing", "processing", "running"].includes(status || "");
}
const staleNotice =
  "邮件已更新。关联选择仍保留；点击重新读取会载入最新邮件并退出本次关联编辑。";

export function Mailbox({ tasks, onTask, onMail, notify, onNavigate }: Props) {
  const [status, setStatus] = useState<Item | null>(null);
  const [folder, setFolder] = useState("inbox");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [unread, setUnread] = useState(false);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<Item>({ items: [], total: 0 });
  const [selectedId, setSelectedId] = useState("");
  const [message, setMessage] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [stale, setStale] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkIds, setLinkIds] = useState<string[]>([]);
  const [taskSearch, setTaskSearch] = useState("");
  const selection = useRef("");
  const listView = useRef("");
  const interaction = useRef({ linking, busy });
  const detailSequence = useRef(0);
  const statusSequence = useRef(0);
  const alive = useRef(true);
  const syncing = isSyncing(status?.status);
  selection.current = selectedId;
  interaction.current = { linking, busy };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function loadStatus() {
    const seq = ++statusSequence.current;
    const next = await api("/mailbox/status");
    if (alive.current && seq === statusSequence.current) setStatus(next);
    return next;
  }
  useEffect(() => {
    void loadStatus().catch((e) => setError(e.message));
    const timer = setInterval(
      () => {
        void loadStatus()
          .then(() => setRefresh((v) => v + 1))
          .catch((e) => setError(e.message));
      },
      syncing ? 2500 : 20000,
    );
    return () => clearInterval(timer);
  }, [syncing]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let current = true;
    const view = JSON.stringify([folder, query, page, unread]);
    const background = listView.current === view;
    listView.current = view;
    setLoading(true);
    const params = new URLSearchParams({
      folder,
      q: query,
      page: String(page),
      pageSize: "30",
    });
    if (unread) params.set("unread", "true");
    void api("/mailbox/messages?" + params)
      .then((next) => {
        if (!current) return;
        const lastPage = Math.max(1, Math.ceil(next.total / 30));
        if (page > lastPage) {
          // A shrinking result set changes pages automatically; it is not a
          // request to discard the currently edited message.
          listView.current = JSON.stringify([folder, query, lastPage, unread]);
          setPage(lastPage);
          return;
        }
        setList(next);
        setError("");
        if (
          !next.items.some((m: Item) => m.id === selection.current) &&
          !interaction.current.busy &&
          !(background && selection.current)
        )
          setSelectedId(next.items[0]?.id || "");
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [folder, query, page, unread, refresh]);
  useEffect(() => {
    const seq = ++detailSequence.current;
    setMessage(null);
    setDetailError("");
    setBusy(false);
    setStale(false);
    setLinking(false);
    setTaskSearch("");
    if (!selectedId) {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    void api("/mailbox/messages/" + selectedId)
      .then((next) => {
        if (
          alive.current &&
          selection.current === selectedId &&
          seq === detailSequence.current
        ) {
          setMessage(next);
          setLinkIds(next.taskIds || []);
          void markOpenedMail(next, seq);
        }
      })
      .catch((e) => {
        if (
          alive.current &&
          selection.current === selectedId &&
          seq === detailSequence.current
        )
          setDetailError(e.message);
      })
      .finally(() => {
        if (
          alive.current &&
          selection.current === selectedId &&
          seq === detailSequence.current
        )
          setDetailLoading(false);
      });
  }, [selectedId]);
  useEffect(() => {
    const row = list.items.find((item: Item) => item.id === message?.id);
    if (
      !message ||
      message.id !== selectedId ||
      busy ||
      detailLoading ||
      (row && row.revision <= message.revision)
    )
      return;
    if (row && linking) {
      setStale(true);
      setDetailError((current) => current || staleNotice);
      return;
    }
    let current = true;
    const seq = ++detailSequence.current;
    // When a filter/page no longer contains the edited message, check it by
    // ID so remote changes still trigger conflict protection without dropping
    // the local association draft.
    void api("/mailbox/messages/" + message.id)
      .then((next) => {
        if (
          current &&
          alive.current &&
          selection.current === message.id &&
          seq === detailSequence.current
        ) {
          if (next.revision <= message.revision) return;
          if (linking) {
            setStale(true);
            setDetailError((current) => current || staleNotice);
            return;
          }
          setMessage(next);
          setLinkIds(next.taskIds || []);
          setStale(false);
          setDetailError("");
        }
      })
      .catch((e) => {
        if (
          current &&
          alive.current &&
          selection.current === message.id &&
          seq === detailSequence.current
        )
          setDetailError(e.message);
      });
    return () => {
      current = false;
    };
  }, [
    list.items,
    selectedId,
    message?.id,
    message?.revision,
    busy,
    linking,
    detailLoading,
  ]);
  async function reloadMessage() {
    if (!selectedId) return;
    const id = selectedId;
    const seq = ++detailSequence.current;
    setDetailLoading(true);
    try {
      const next = await api("/mailbox/messages/" + id);
      if (
        alive.current &&
        selection.current === id &&
        seq === detailSequence.current
      ) {
        setMessage(next);
        setLinkIds(next.taskIds || []);
        setDetailError("");
        setStale(false);
        setLinking(false);
      }
    } catch (e: any) {
      if (
        alive.current &&
        selection.current === id &&
        seq === detailSequence.current
      )
        setDetailError(e.message);
    } finally {
      if (
        alive.current &&
        selection.current === id &&
        seq === detailSequence.current
      )
        setDetailLoading(false);
    }
  }
  async function markOpenedMail(initial: Item, sequence: number) {
    if (initial.read || initial.source !== "imap") return;
    const current = () =>
      alive.current &&
      selection.current === initial.id &&
      detailSequence.current === sequence;
    if (!current()) return;
    setBusy(true);
    let next = initial;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!current()) return;
        try {
          await api(
            "/mailbox/messages/" + initial.id + "/read",
            { read: true, revision: next.revision },
            "PATCH",
          );
          const saved = await api("/mailbox/messages/" + initial.id);
          if (current()) {
            setMessage(saved);
            setRefresh((v) => v + 1);
            void loadStatus().catch(() => {});
          }
          return;
        } catch (error: any) {
          if (attempt === 2 || !/同步|更新|重试/.test(error.message))
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, (attempt + 1) * 1500),
          );
          if (!current()) return;
          next = await api("/mailbox/messages/" + initial.id);
          if (next.read) {
            if (current()) {
              setMessage(next);
              setRefresh((v) => v + 1);
            }
            return;
          }
        }
      }
    } catch (error: any) {
      if (current())
        setDetailError(
          "自动同步已读失败：" + error.message + "；可点击标为已读重试。",
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function sync() {
    setBusy(true);
    setError("");
    try {
      await api("/mailbox/sync", {});
      setStatus((old) => ({ ...old, status: "queued" }));
      notify("已开始同步收件箱和已发送邮件");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function changeRead() {
    if (!message || stale) return;
    const id = message.id;
    setBusy(true);
    setDetailError("");
    try {
      await api(
        "/mailbox/messages/" + id + "/read",
        { read: !message.read, revision: message.revision },
        "PATCH",
      );
      const next = await api("/mailbox/messages/" + id);
      if (selection.current === id) setMessage(next);
      setRefresh((v) => v + 1);
      void loadStatus().catch(() => {});
      notify(
        next.read ? "已标为已读，并同步到邮箱" : "已标为未读，并同步到邮箱",
      );
    } catch (e: any) {
      if (selection.current === id) setDetailError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function saveLinks() {
    if (!message || stale) return;
    const id = message.id;
    setBusy(true);
    setDetailError("");
    try {
      await api(
        "/mailbox/messages/" + id + "/link",
        { taskIds: linkIds, revision: message.revision },
        "PATCH",
      );
      const next = await api("/mailbox/messages/" + id);
      if (selection.current === id) {
        setMessage(next);
        setLinkIds(next.taskIds || []);
        setLinking(false);
      }
      setRefresh((v) => v + 1);
      notify("邮件关联已保存，可在任务历史中查看");
    } catch (e: any) {
      if (selection.current === id) setDetailError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const linked = tasks.filter((t) => (message?.taskIds || []).includes(t.id));
  const contacts = new Set(
    [...(message?.from || []), ...(message?.to || [])].map((a: Item) =>
      a.address?.toLowerCase(),
    ),
  );
  const candidates = tasks
    .filter((t) => {
      const haystack = [t.customerName, t.softwareName, t.originalName, t.email]
        .join(" ")
        .toLocaleLowerCase();
      return (
        !taskSearch.trim() ||
        haystack.includes(taskSearch.toLocaleLowerCase().trim())
      );
    })
    .sort(
      (a, b) =>
        Number(linkIds.includes(b.id)) - Number(linkIds.includes(a.id)) ||
        Number(contacts.has(b.email?.toLowerCase())) -
          Number(contacts.has(a.email?.toLowerCase())),
    )
    .slice(0, 40);
  const counts = status?.counts || {};
  const pages = Math.max(1, Math.ceil((list.total || 0) / 30));
  const currentFolder = folders.find((f) => f.id === folder)!;
  return (
    <div className="page mailbox-page">
      <div className="page-heading">
        <div>
          <p className="context-line">客户往来与材料交付，放在一起处理</p>
          <h1>邮箱</h1>
        </div>
        <div className="button-group">
          <button onClick={() => onNavigate("settings")}>
            <Settings size={16} aria-hidden />
            邮箱设置
          </button>
          <button
            className="primary"
            disabled={busy || syncing || !status?.configured}
            onClick={() => void sync()}
          >
            <RefreshCw
              size={16}
              className={syncing ? "spin" : ""}
              aria-hidden
            />
            {syncing
              ? "正在同步"
              : status?.hasMore
                ? "继续同步历史"
                : "同步邮件"}
          </button>
        </div>
      </div>
      {error && (
        <div className="mailbox-alert" role="alert">
          {error}
          <button
            onClick={() => {
              setRefresh((v) => v + 1);
              void loadStatus().catch(() => {});
            }}
          >
            重新连接
          </button>
        </div>
      )}
      {status?.lastError && !syncing && (
        <div className="mailbox-alert" role="alert">
          上次同步未完成：{status.lastError}
          <button onClick={() => void sync()} disabled={busy}>
            重试同步
          </button>
        </div>
      )}
      <div className="mailbox-workspace">
        <aside className="mailbox-folders" aria-label="邮件文件夹">
          <div className="mailbox-account">
            <span className="mailbox-account-badge">
              <Mail size={19} aria-hidden />
            </span>
            <strong>{status?.address || status?.email || "我的邮箱"}</strong>
            <span>
              {status?.configured ? "QQ 邮箱 · 已配置" : "尚未连接邮箱"}
            </span>
          </div>
          <div className="mailbox-folder-list">
            {folders.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={folder === id ? "active" : ""}
                aria-pressed={folder === id}
                onClick={() => {
                  setFolder(id);
                  setUnread(false);
                  setPage(1);
                }}
              >
                <Icon size={17} aria-hidden />
                <span>{label}</span>
                <b>
                  {id === "all"
                    ? (counts.inbox || 0) + (counts.sent || 0)
                    : counts[id] || 0}
                </b>
              </button>
            ))}
          </div>
          <div className="mailbox-sync-note">
            <span className={syncing ? "sync-state busy" : "sync-state"}>
              {syncing
                ? "正在更新收发记录"
                : status?.autoSync
                  ? "自动同步已开启"
                  : "手动同步"}
            </span>
            <p>
              {status?.lastSyncAt
                ? `上次同步 ${mailDate(status.lastSyncAt)}`
                : "连接邮箱后，收发记录会显示在这里。"}
            </p>
            {status?.hasMore && <p>还有较早邮件待同步。</p>}
          </div>
        </aside>
        <section className="mailbox-list-pane" aria-label={currentFolder.label}>
          <div className="mailbox-list-top">
            <div className="mailbox-list-title">
              <h2>{currentFolder.label}</h2>
              <span>{list.total || 0} 封</span>
            </div>
            <label className="mailbox-search">
              <Search size={17} aria-hidden />
              <input
                aria-label="搜索邮件主题、联系人或内容"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索邮件或联系人"
              />
              {search && (
                <button aria-label="清空邮件搜索" onClick={() => setSearch("")}>
                  <X size={14} />
                </button>
              )}
            </label>
            <label className="mailbox-unread">
              <input
                type="checkbox"
                checked={unread}
                onChange={(e) => {
                  setUnread(e.target.checked);
                  setPage(1);
                }}
              />
              只看未读<span>{counts.unread || 0}</span>
            </label>
          </div>
          <div className="mailbox-message-list" aria-busy={loading}>
            {loading && !list.items.length ? (
              <Busy label="读取邮件…" />
            ) : !list.items.length ? (
              <div className="mailbox-list-empty">
                <Inbox size={28} aria-hidden />
                <strong>
                  {query || unread ? "没有符合条件的邮件" : "还没有同步邮件"}
                </strong>
                <p>
                  {query || unread
                    ? "换个关键词，或取消未读筛选。"
                    : status?.configured
                      ? "点击同步邮件，读取邮箱收发记录。"
                      : "在邮箱设置中连接现有 QQ 邮箱。"}
                </p>
                {!query && !unread && (
                  <button
                    onClick={() =>
                      status?.configured ? void sync() : onNavigate("settings")
                    }
                    disabled={busy || syncing}
                  >
                    {status?.configured ? "同步邮件" : "连接邮箱"}
                  </button>
                )}
              </div>
            ) : (
              list.items.map((m: Item) => (
                <button
                  key={m.id}
                  className={
                    "mailbox-message-row " +
                    (selectedId === m.id ? "selected " : "") +
                    (!m.read ? "unread" : "")
                  }
                  aria-current={selectedId === m.id ? "true" : undefined}
                  onClick={() => setSelectedId(m.id)}
                >
                  <span className="mailbox-row-top">
                    <span className="mailbox-sender">
                      {!m.read && (
                        <span className="unread-dot" aria-label="未读" />
                      )}
                      {addresses(m.folder === "sent" ? m.to : m.from, true) ||
                        "未知联系人"}
                    </span>
                    <time>{mailDate(m.date)}</time>
                  </span>
                  <strong>{m.subject || "（无主题）"}</strong>
                  <span className="mailbox-snippet">
                    {m.snippet || "暂无正文摘要"}
                  </span>
                  <span className="mailbox-row-meta">
                    {folder === "all" && (
                      <span>{m.folder === "sent" ? "已发送" : "收件箱"}</span>
                    )}
                    {m.attachments?.length > 0 && (
                      <span>
                        <Paperclip size={13} aria-hidden />
                        {m.attachments.length}
                      </span>
                    )}
                    {m.taskIds?.length > 0 && (
                      <span>
                        <Link2 size={13} aria-hidden />
                        已关联任务
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="mailbox-pagination">
            <span>
              {page} / {pages} 页
            </span>
            <div>
              <button
                aria-label="上一页邮件"
                disabled={page <= 1 || loading}
                onClick={() => setPage((n) => n - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                aria-label="下一页邮件"
                disabled={page >= pages || loading}
                onClick={() => setPage((n) => n + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </section>
        <section
          className="mailbox-reader"
          aria-label="邮件内容"
          aria-busy={detailLoading}
        >
          {detailLoading ? (
            <div className="mailbox-reader-empty">
              <Busy label="读取邮件内容…" />
            </div>
          ) : !message ? (
            <div className="mailbox-reader-empty">
              <MailOpen size={40} aria-hidden />
              <h2>
                {detailError ? "邮件暂时无法读取" : "选一封邮件，查看客户往来"}
              </h2>
              <p>
                {detailError || "收发内容、附件信息和关联任务会在这里展开。"}
              </p>
              {detailError && (
                <button onClick={() => void reloadMessage()}>重试</button>
              )}
            </div>
          ) : (
            <>
              <div className="mailbox-reader-toolbar">
                <span className="mailbox-direction">
                  {message.folder === "sent" ? (
                    <Send size={15} aria-hidden />
                  ) : (
                    <Inbox size={15} aria-hidden />
                  )}
                  {message.folder === "sent" ? "已发送" : "收到的邮件"}
                </span>
                <div className="button-group">
                  {message.source !== "local" && !message.remoteMissing && (
                    <button
                      disabled={busy || stale || syncing}
                      onClick={() => void changeRead()}
                    >
                      {message.read ? (
                        <Mail size={15} aria-hidden />
                      ) : (
                        <MailOpen size={15} aria-hidden />
                      )}
                      {message.read ? "标为未读" : "标为已读"}
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => {
                      setLinkIds(message.taskIds || []);
                      setLinking(!linking);
                      setTaskSearch("");
                    }}
                  >
                    <Link2 size={15} aria-hidden />
                    关联任务
                  </button>
                </div>
              </div>
              {detailError && (
                <div className="mailbox-alert" role="alert">
                  {detailError}
                  <button disabled={busy} onClick={() => void reloadMessage()}>
                    重新读取
                  </button>
                </div>
              )}
              <div className="mailbox-reader-scroll">
                {message.bodyTruncated && (
                  <p className="mailbox-record-note mailbox-truncation">
                    邮件正文较长，当前同步了部分内容。请到 QQ 邮箱查看完整原文。
                  </p>
                )}
                <header className="mailbox-message-header">
                  <h2>{message.subject || "（无主题）"}</h2>
                  <dl>
                    <div>
                      <dt>发件人</dt>
                      <dd>{addresses(message.from) || "未知发件人"}</dd>
                    </div>
                    <div>
                      <dt>收件人</dt>
                      <dd>{addresses(message.to) || "未提供"}</dd>
                    </div>
                    {message.cc?.length > 0 && (
                      <div>
                        <dt>抄送</dt>
                        <dd>{addresses(message.cc)}</dd>
                      </div>
                    )}
                    <div>
                      <dt>时间</dt>
                      <dd>{mailDate(message.date, true)}</dd>
                    </div>
                  </dl>
                </header>
                {message.remoteMissing && (
                  <p className="mailbox-record-note">
                    这封邮件已不在远端文件夹中，仍保留已同步的往来记录。
                  </p>
                )}
                {linked.length > 0 && (
                  <div className="mailbox-linked-tasks">
                    <span>关联任务</span>
                    {linked.map((task) => (
                      <div key={task.id}>
                        <button
                          className="mailbox-task-link"
                          onClick={() => onTask(task)}
                        >
                          <span>{task.softwareName || "名称待定"}</span>
                          <ArrowUpRight size={14} aria-hidden />
                        </button>
                        <button onClick={() => onMail(task)}>
                          <Send size={14} aria-hidden />
                          发送材料
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {linking && (
                  <div className="mailbox-link-editor">
                    <div className="mailbox-link-heading">
                      <strong>把这封邮件放进任务历史</strong>
                      <button
                        className="icon-button"
                        aria-label="取消关联编辑"
                        disabled={busy}
                        onClick={() => setLinking(false)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <input
                      aria-label="查找要关联的任务"
                      placeholder="搜索客户、软件名称或邮箱"
                      value={taskSearch}
                      onChange={(e) => setTaskSearch(e.target.value)}
                    />
                    <div className="mailbox-task-options">
                      {candidates.length ? (
                        candidates.map((task) => (
                          <label key={task.id}>
                            <input
                              type="checkbox"
                              disabled={busy}
                              checked={linkIds.includes(task.id)}
                              onChange={(e) =>
                                setLinkIds((ids) =>
                                  e.target.checked
                                    ? [...ids, task.id]
                                    : ids.filter((id) => id !== task.id),
                                )
                              }
                            />
                            <span>
                              <strong>{task.softwareName || "名称待定"}</strong>
                              <small>
                                {task.customerName || "待补客户"} ·{" "}
                                {task.kind === "correction" ? "补正" : "新单"}
                                {task.completed ? " · 已交付" : ""}
                              </small>
                            </span>
                            {contacts.has(task.email?.toLowerCase()) && (
                              <em>邮箱一致</em>
                            )}
                          </label>
                        ))
                      ) : (
                        <p className="muted">没有符合条件的任务。</p>
                      )}
                    </div>
                    <div className="mailbox-link-footer">
                      <span>已选 {linkIds.length} 项</span>
                      <button
                        className="primary"
                        disabled={busy || stale}
                        onClick={() => void saveLinks()}
                      >
                        <Check size={15} aria-hidden />
                        保存关联
                      </button>
                    </div>
                  </div>
                )}
                {message.attachments?.length > 0 && (
                  <div className="mailbox-attachments">
                    <div className="mailbox-attachment-title">
                      <Paperclip size={15} aria-hidden />
                      <strong>{message.attachments.length} 个附件</strong>
                      <span>原文件保留在邮箱</span>
                    </div>
                    <div>
                      {message.attachments.map((a: Item, index: number) => (
                        <span
                          className="mailbox-file"
                          key={`${a.filename}-${index}`}
                        >
                          <FileText size={17} aria-hidden />
                          <span>
                            <strong>{a.filename || "未命名附件"}</strong>
                            <small>{bytes(a.size || 0)}</small>
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mailbox-message-body">
                  {message.html ? (
                    <MailPreview html={message.html} />
                  ) : (
                    <div className="mailbox-plain-text">
                      {message.text || "这封邮件没有可显示的文字正文。"}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
