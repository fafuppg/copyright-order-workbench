import { useState, useEffect, useRef } from "react";
import { Paperclip, Send, Trash2, Plus, Copy, Check } from "lucide-react";
import { api, fill, fillHtml, bytes, dateLabel, type Item } from "./api";
import {
  Modal,
  Field,
  RichEditor,
  MailPreview,
  Busy,
  Empty,
} from "./components";
import { deliveryStatus } from "./Tasks";

export function MailComposer({
  task,
  templates,
  sender,
  onClose,
  onRefresh,
  notify,
}: {
  task: Item;
  templates: Item[];
  sender: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const base =
    templates.find((t) => t.kind === task.kind && t.isDefault) ||
    templates.find((t) => t.kind === task.kind) ||
    templates[0];
  const [to, setTo] = useState(task.email || ""),
    [subject, setSubject] = useState(
      base ? fill(base.subject, task) : task.softwareName + "｜材料交付",
    ),
    [html, setHtml] = useState(
      base ? fillHtml(base.html, task) : "<p>您好，请查收附件材料。</p>",
    ),
    [templateId, setTemplateId] = useState(base?.id || ""),
    [attachments, setAttachments] = useState<Item[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [resend, setResend] = useState(false),
    [delivery, setDelivery] = useState<Item | null>(null),
    [preview, setPreview] = useState(false),
    [draftReady, setDraftReady] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    requestId = useRef(crypto.randomUUID()),
    ambiguous = useRef(false);
  async function load(restore = false) {
    const d = await api("/tasks/" + task.id + "/detail");
    const taskFiles = d.attachments.filter((a: Item) => a.status === "ready");
    const templateFiles: Item[] = [
      ...templates.flatMap((t) => t.attachments || []),
      ...(d.reusableAttachments || []),
    ];
    const wanted = restore
      ? d.mailDraft?.attachmentIds ||
        (templates.find((t) => t.id === templateId)?.attachments || []).map(
          (a: Item) => a.id,
        )
      : attachments.filter((a) => a.persistent).map((a) => a.id);
    const ready = [
      ...taskFiles,
      ...templateFiles.filter(
        (a, i) =>
          wanted.includes(a.id) &&
          templateFiles.findIndex((f) => f.id === a.id) === i,
      ),
    ];
    setAttachments(ready);
    setSelected(
      ready
        .filter(
          (a: Item) =>
            restore ||
            selected.includes(a.id) ||
            !attachments.some((old) => old.id === a.id),
        )
        .map((a: Item) => a.id),
    );
    if (restore && d.mailDraft) {
      setTo(d.mailDraft.to);
      setSubject(d.mailDraft.subject);
      setHtml(d.mailDraft.html);
      setSelected(
        d.mailDraft.attachmentIds.filter((id: string) =>
          ready.some((a: Item) => a.id === id),
        ),
      );
    }
    setDraftReady(true);
  }
  useEffect(() => {
    void load(true).catch((e) => setError(e.message));
  }, [task.id]);
  useEffect(() => {
    if (!draftReady || delivery) return;
    const timer = setTimeout(() => {
      void api(
        "/tasks/" + task.id + "/maildraft",
        { to, subject, html, attachmentIds: selected },
        "PATCH",
      ).catch((e) => setError("邮件草稿保存失败：" + e.message));
    }, 800);
    return () => clearTimeout(timer);
  }, [to, subject, html, selected, draftReady, delivery?.id]);
  useEffect(() => {
    if (!delivery || !["queued", "sending"].includes(delivery.status)) return;
    const timer = setInterval(() => {
      void api("/tasks/" + task.id + "/detail")
        .then(async (d) => {
          const latest = d.deliveries.find((x: Item) => x.id === delivery.id);
          if (latest) {
            setDelivery(latest);
            if (!["queued", "sending"].includes(latest.status)) {
              await onRefresh();
              await load();
              if (latest.status === "sent") notify("邮件已发送，任务已完成");
            }
          }
        })
        .catch((e) => setError(e.message));
    }, 1800);
    return () => clearInterval(timer);
  }, [delivery?.id, delivery?.status]);
  async function upload(files: File[]) {
    setBusy(true);
    setError("");
    try {
      if (selected.length + files.length > 10)
        throw new Error("每封邮件最多选择 10 个附件，请先取消不需要的附件");
      for (const f of files) {
        const form = new FormData();
        form.append("file", f);
        await api("/tasks/" + task.id + "/attachments", form);
      }
      await load();
    } catch (e: any) {
      setError(e.message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    setBusy(true);
    setError("");
    try {
      const d = await api("/tasks/" + task.id + "/send", {
        to,
        subject,
        html,
        attachmentIds: selected,
        requestId: requestId.current,
        revision: task.revision,
        confirmResend: resend,
      });
      setDelivery(d);
      ambiguous.current = false;
    } catch (e: any) {
      setError(e.message);
      ambiguous.current = true;
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (draftReady && !delivery) {
      try {
        await api(
          "/tasks/" + task.id + "/maildraft",
          { to, subject, html, attachmentIds: selected },
          "PATCH",
        );
      } catch (e: any) {
        setError("邮件草稿保存失败，暂未关闭：" + e.message);
        return;
      }
    }
    onClose();
  }
  const inFlight = delivery && ["queued", "sending"].includes(delivery.status),
    sent = delivery?.status === "sent";
  return (
    <Modal
      title="发送材料"
      className="mail-composer-modal"
      onClose={() => void close()}
      wide
    >
      <div className="composer-top">
        <span>
          {task.customerName || "待补客户"} / {task.softwareName || "名称待定"}
        </span>
        <button
          className={preview ? "active" : ""}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "返回编辑" : "查看发送预览"}
        </button>
      </div>
      <div className="composer-body">
        <section className="compose-main">
          <div className="form-grid">
            <Field label="收件人" wide>
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                disabled={busy || !draftReady || !!inFlight || sent}
                placeholder="客户邮箱"
              />
            </Field>
            <Field label="邮件主题" wide>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={busy || !draftReady || !!inFlight || sent}
              />
            </Field>
          </div>
          <div className="body-editor">
            {preview || inFlight || sent ? (
              <MailPreview html={html} />
            ) : (
              <RichEditor value={html} onChange={setHtml} />
            )}
          </div>
        </section>
        <aside className="compose-side">
          <Field label="选择注意事项模板">
            <select
              value={templateId}
              disabled={busy || !draftReady || !!inFlight || sent}
              onChange={(e) => {
                const t = templates.find((t) => t.id === e.target.value);
                if (t) {
                  setTemplateId(t.id);
                  setAttachments((v) => [
                    ...v.filter((a) => !a.persistent),
                    ...(t.attachments || []),
                  ]);
                  setSelected((v) => [
                    ...v.filter((id) =>
                      attachments.some((a) => a.id === id && !a.persistent),
                    ),
                    ...(t.attachments || []).map((a: Item) => a.id),
                  ]);
                  setSubject(fill(t.subject, task));
                  setHtml(fillHtml(t.html, task));
                }
              }}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <h3>交付附件</h3>
          <p className="muted">
            可不带附件发送，也可添加多个文件。临时附件发送后清理，模板附件长期保留。
          </p>
          <input
            hidden
            ref={input}
            type="file"
            multiple
            onChange={(e) => {
              void upload(Array.from(e.target.files || []));
              e.target.value = "";
            }}
          />
          <button
            disabled={busy || !!inFlight || sent}
            onClick={() => input.current?.click()}
          >
            <Paperclip size={16} />
            添加文件（可多选）
          </button>
          <div className="attachment-list">
            {attachments.map((a) => (
              <div key={a.id} className="attachment">
                <input
                  type="checkbox"
                  disabled={busy || !draftReady || !!inFlight || sent}
                  checked={selected.includes(a.id)}
                  onChange={(e) =>
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, a.id]
                        : v.filter((x) => x !== a.id),
                    )
                  }
                />
                <div>
                  <strong>{a.name}</strong>
                  <small>
                    {bytes(a.size)}
                    {a.persistent ? " · 模板附件" : ""}
                  </small>
                </div>
                <button
                  className="icon-button"
                  disabled={busy || !draftReady || !!inFlight || sent}
                  aria-label={"移除" + a.name}
                  onClick={() => {
                    if (a.persistent) {
                      setAttachments((v) => v.filter((f) => f.id !== a.id));
                      setSelected((v) => v.filter((id) => id !== a.id));
                    } else
                      void api("/attachments/" + a.id, undefined, "DELETE")
                        .then(() => load())
                        .catch((e) => setError(e.message));
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          {!attachments.length && <p className="muted">尚未添加附件</p>}
          <p className="attachment-total">
            已选择 {selected.length} 个 ·{" "}
            {bytes(
              attachments
                .filter((a) => selected.includes(a.id))
                .reduce((s, a) => s + a.size, 0),
            )}
          </p>
          <p className="micro-note">
            大小按邮件编码后的总量检查。超限文件请自行发送，再在任务中标记外部交付。
          </p>
          {(task.completed || delivery?.status === "uncertain") && (
            <label className="resend-check">
              <input
                type="checkbox"
                checked={resend}
                onChange={(e) => setResend(e.target.checked)}
              />
              我已核对交付记录，确认需要再次发送
            </label>
          )}
        </aside>
      </div>
      {error && <p className="error padded">{error}</p>}
      {delivery && (
        <div className={"delivery-banner " + (sent ? "success" : "")}>
          <strong>{deliveryStatus(delivery.status)}</strong>
          <span>
            {delivery.error ||
              (sent
                ? "任务已标记为完成，临时附件已清理。"
                : "请等待邮件服务器返回发送结果。")}
          </span>
        </div>
      )}
      <footer className="modal-foot">
        <span className="muted">发件人：{sender}</span>
        <button onClick={() => void close()}>关闭</button>
        <button
          className="primary"
          disabled={
            busy ||
            !!inFlight ||
            sent ||
            !draftReady ||
            (task.completed && !resend)
          }
          onClick={() => {
            if (delivery && !["queued", "sending"].includes(delivery.status)) {
              requestId.current = crypto.randomUUID();
            }
            void send();
          }}
        >
          {busy || inFlight ? (
            <Busy label="处理中" />
          ) : (
            <>
              <Send size={16} />
              {delivery ? "重新发送" : "确认发送"}
            </>
          )}
        </button>
      </footer>
    </Modal>
  );
}
export function Templates({
  templates,
  onRefresh,
  notify,
}: {
  templates: Item[];
  onRefresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [editing, setEditing] = useState<Item>(
      templates[0] || {
        name: "",
        kind: "new",
        subject: "",
        html: "<p></p>",
        isDefault: false,
      },
    ),
    [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dirty, setDirty] = useState(false);
  const set = (k: string, v: any) => {
    setEditing((t) => ({ ...t, [k]: v }));
    setDirty(true);
  };
  function choose(t: Item) {
    if (busy) return;
    if (dirty && !window.confirm("当前模板有未保存的修改，放弃这些修改吗？"))
      return;
    setEditing(t);
    setDirty(false);
    setError("");
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const t = await api("/templates", editing);
      setEditing(t);
      setDirty(false);
      await onRefresh();
      notify("模板已保存");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page templates-page">
      <div className="page-heading">
        <div>
          <p className="context-line">统一注意事项，保留每次发送快照</p>
          <h1>邮件模板</h1>
        </div>
        <button
          onClick={() =>
            choose({
              name: "新模板",
              kind: "all",
              subject: "{{软件名称}}｜材料交付",
              html: "<p>{{客户称呼}}，您好：</p>",
              isDefault: false,
            })
          }
        >
          <Plus size={16} />
          新增模板
        </button>
      </div>
      <div className="template-layout">
        <aside className="template-list">
          {templates.map((t) => (
            <button
              className={editing.id === t.id ? "selected" : ""}
              key={t.id}
              onClick={() => choose(t)}
            >
              <strong>{t.name}</strong>
              <span>
                {t.kind === "new"
                  ? "新单"
                  : t.kind === "correction"
                    ? "补正"
                    : "通用"}
                {t.isDefault ? " · 默认模板" : ""}
              </span>
            </button>
          ))}
          <div className="template-help">
            <b>可用变量</b>
            {["客户称呼", "软件名称", "原名称", "邮箱"].map((v) => (
              <button
                key={v}
                onClick={() => {
                  void navigator.clipboard
                    .writeText("{{" + v + "}}")
                    .then(() => notify("变量已复制"))
                    .catch(() => notify("复制失败，请手工输入 {{" + v + "}}"));
                }}
              >
                <Copy size={12} />
                {"{{" + v + "}}"}
              </button>
            ))}
            <p>发送时会替换为对应任务资料。</p>
          </div>
        </aside>
        <section className="template-workspace">
          <div className="template-fields">
            <Field label="模板名称">
              <input
                value={editing.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </Field>
            <Field label="适用类型">
              <select
                value={editing.kind}
                onChange={(e) => set("kind", e.target.value)}
              >
                <option value="new">新单</option>
                <option value="correction">补正</option>
                <option value="all">通用</option>
              </select>
            </Field>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={editing.isDefault}
                onChange={(e) => set("isDefault", e.target.checked)}
              />
              设为默认
            </label>
            <button onClick={() => setPreview(!preview)}>
              {preview ? "返回编辑" : "预览"}
            </button>
          </div>
          <Field label="邮件主题">
            <input
              value={editing.subject}
              onChange={(e) => set("subject", e.target.value)}
            />
          </Field>
          <Field label="模板自带附件（保存在系统中，单个不超过 10 MB）">
            <input
              type="file"
              multiple
              disabled={busy}
              onChange={async (e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = "";
                setBusy(true);
                setError("");
                try {
                  if ((editing.attachments || []).length + files.length > 10)
                    throw new Error("每个模板最多添加 10 个附件");
                  for (const file of files) {
                    const form = new FormData();
                    form.append("file", file);
                    const added = await api("/template-files", form);
                    setEditing((current) => ({
                      ...current,
                      attachments: [...(current.attachments || []), added],
                    }));
                    setDirty(true);
                  }
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            />
            {(editing.attachments || []).map((a: Item) => (
              <div className="attachment" key={a.id}>
                <a href={"/api/v1/template-files/" + a.id} download>
                  {a.name}
                </a>
                <small>{bytes(a.size)}</small>
                <button
                  disabled={busy}
                  onClick={() =>
                    set(
                      "attachments",
                      editing.attachments.filter((f: Item) => f.id !== a.id),
                    )
                  }
                >
                  移除
                </button>
              </div>
            ))}
          </Field>
          <div className="template-editor">
            {preview ? (
              <MailPreview html={editing.html} />
            ) : (
              <RichEditor
                value={editing.html}
                onChange={(v) => set("html", v)}
              />
            )}
          </div>
          {error && <p className="error">{error}</p>}
          <footer className="template-footer">
            {editing.id && (
              <>
                <button
                  onClick={() =>
                    choose({
                      ...editing,
                      id: undefined,
                      revision: undefined,
                      name: editing.name + " · 副本",
                      isDefault: false,
                    })
                  }
                >
                  <Copy size={14} />
                  复制模板
                </button>
                <button
                  className="danger-text"
                  onClick={() => {
                    if (
                      window.confirm("删除此模板？已发送的邮件记录不会受影响。")
                    )
                      void api("/templates/" + editing.id, undefined, "DELETE")
                        .then(async () => {
                          await onRefresh();
                          setEditing({
                            name: "",
                            kind: "all",
                            subject: "",
                            html: "<p></p>",
                            isDefault: false,
                          });
                          setDirty(false);
                        })
                        .catch((e) => setError(e.message));
                  }}
                >
                  删除
                </button>
              </>
            )}
            <span className="muted push-right">
              {dirty ? "有未保存的修改" : "已保存"}
            </span>
            <button
              className="primary"
              disabled={busy || !editing.name || !editing.subject}
              onClick={() => void save()}
            >
              {busy ? <Busy label="保存中" /> : "保存模板"}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
export function Deliveries({
  deliveries,
  tasks,
  onTask,
  onRefresh,
  notify,
}: {
  deliveries: Item[];
  tasks: Item[];
  onTask: (t: Item) => void;
  onRefresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<Item | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false),
    [deleting, setDeleting] = useState(false),
    [deleteError, setDeleteError] = useState("");
  const list = deliveries.filter((d) =>
    [d.to, d.subject, d.customerName, d.softwareName].join(" ").includes(query),
  );
  return (
    <div className="page delivery-page">
      <div className="page-heading">
        <div>
          <p className="context-line">每一次发送都有记录</p>
          <h1>交付记录</h1>
        </div>
        <input
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索客户、收件人或主题"
        />
      </div>
      {confirmDelete && selected && (
        <Modal
          title="删除交付记录"
          onClose={() => {
            if (!deleting) setConfirmDelete(false);
          }}
        >
          <div className="modal-body">
            <p>
              删除“{selected.subject || selected.softwareName || "这条交付记录"}
              ”？不会删除邮箱里的邮件或改变任务完成状态。
            </p>
            {deleteError && <p className="error">{deleteError}</p>}
          </div>
          <footer className="modal-foot">
            <button disabled={deleting} onClick={() => setConfirmDelete(false)}>
              取消
            </button>
            <button
              className="danger"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                try {
                  await api(
                    "/deliveries/" + selected.id,
                    { revision: selected.revision },
                    "DELETE",
                  );
                  await onRefresh();
                  setSelected(null);
                  setConfirmDelete(false);
                  notify("交付记录已删除");
                } catch (e: any) {
                  setDeleteError(e.message);
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? "删除中" : "确认删除"}
            </button>
          </footer>
        </Modal>
      )}
      <div className="delivery-layout">
        <div className="delivery-list">
          {!list.length ? (
            <Empty
              title="暂无交付记录"
              description="完成第一次发送后，即可在这里查看。"
            />
          ) : (
            list.map((d) => (
              <button
                key={d.id}
                className={selected?.id === d.id ? "selected" : ""}
                onClick={() => setSelected(d)}
              >
                <div>
                  <strong>{d.customerName || "未填写客户"}</strong>
                  <span
                    className={
                      ["failed", "uncertain"].includes(d.status)
                        ? "error"
                        : "muted"
                    }
                  >
                    {deliveryStatus(d.status)}
                  </span>
                </div>
                <h3>{d.subject}</h3>
                <p>{d.to || d.channel}</p>
                <small>{dateLabel(d.sentAt || d.createdAt)}</small>
              </button>
            ))
          )}
        </div>
        <section className="delivery-reading">
          {selected ? (
            <>
              <div className="reading-header">
                <h2>{selected.subject}</h2>
                <p>
                  {selected.to || selected.channel} ·{" "}
                  {dateLabel(selected.sentAt || selected.createdAt)}
                </p>
                <button
                  onClick={() => {
                    const t = tasks.find((t) => t.id === selected.taskId);
                    if (t) onTask(t);
                  }}
                >
                  查看对应任务
                </button>
                <button
                  className="danger"
                  disabled={["queued", "sending"].includes(selected.status)}
                  onClick={() => {
                    setDeleteError("");
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 size={14} /> 删除记录
                </button>
                {selected.error && <p className="error">{selected.error}</p>}
              </div>
              {selected.html ? (
                <MailPreview html={selected.html} />
              ) : (
                <div className="external-note">
                  <h3>外部交付</h3>
                  <p>{selected.notes || "未填写备注"}</p>
                </div>
              )}
              <div className="record-attachments">
                <b>附件记录</b>
                {selected.attachments?.length ? (
                  selected.attachments.map((a: Item) => (
                    <p key={a.id}>
                      <Paperclip size={14} />
                      {a.name}
                      <span>{bytes(a.size)}</span>
                    </p>
                  ))
                ) : (
                  <p className="muted">没有附件记录</p>
                )}
              </div>
            </>
          ) : (
            <Empty
              title="选择一条交付记录"
              description="查看当次发送的正文、附件清单和处理结果。"
            />
          )}
        </section>
      </div>
    </div>
  );
}
