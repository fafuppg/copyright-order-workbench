import { useEffect, useRef, useState } from "react";
import {
  Send,
  Plus,
  MessagesSquare,
  Paperclip,
  X,
  History,
  MessageSquare,
  ArrowRight,
  Check,
  RotateCcw,
  FileImage,
  Download,
  Settings,
  ChevronDown,
} from "lucide-react";
import { api, dateLabel, emptyTask, newTaskDraft, type Item } from "./api";
import {
  Modal,
  Field,
  Busy,
  ImageViewer,
  RichEditor,
  MailPreview,
} from "./components";
import { TaskFields } from "./Tasks";
import {
  editablePayload,
  confirmationRecovery,
  fieldNames,
  isProposalEditable,
  proposalNames,
  proposalStates,
  proposalVersion,
  readableValue,
  selectNewProposal,
  taskPayload,
} from "./assistant-model";
import "./assistant.css";

type DraftImage = { key: string; file: File; url: string; id?: string };
type Props = {
  data: Item;
  onRefresh: () => Promise<void>;
  notify: (s: string) => void;
  onTask: (t: Item) => void;
  onMail: (t: Item) => void;
  onNavigate: (page: string) => void;
};

export default function Assistant({
  data,
  onRefresh,
  notify,
  onTask,
  onMail,
  onNavigate,
}: Props) {
  const [sessions, setSessions] = useState<Item[]>([]),
    [sessionId, setSessionId] = useState(""),
    [detail, setDetail] = useState<Item | null>(null),
    [text, setText] = useState(""),
    [images, setImages] = useState<DraftImage[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [history, setHistory] = useState(true),
    [batch, setBatch] = useState<Item | null>(null),
    [selected, setSelected] = useState<Item | null>(null),
    [viewImages, setViewImages] = useState<string[] | null>(null),
    [uncertain, setUncertain] = useState(false),
    [loading, setLoading] = useState(true),
    [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    composer = useRef<HTMLTextAreaElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    activeSession = useRef(""),
    conversationDrafts = useRef<
      Record<string, { text: string; images: DraftImage[] }>
    >({}),
    imageRef = useRef<DraftImage[]>([]),
    sending = useRef(false),
    pendingRequest = useRef<Item | null>(null),
    watch = useRef<{ sessionId: string; known: Set<string> } | null>(null),
    activeDetail = useRef<Item | null>(null),
    alive = useRef(true);
  imageRef.current = images;
  activeDetail.current = detail;
  const tasks: Item[] = data.tasks || [],
    customers: Item[] = data.customers || [];
  const processing =
    detail && ["queued", "processing"].includes(detail.session?.status);

  function openProposal(proposal: Item, conversation: Item) {
    const message = conversation.messages.find((m: Item) =>
      proposal.messageId
        ? m.id === proposal.messageId
        : m.proposalIds?.includes(proposal.id),
    );
    const deliveries = (conversation.proposals || []).filter(
      (p: Item) =>
        p.type === "external_delivery" &&
        isProposalEditable(p) &&
        (p.messageId
          ? p.messageId === message?.id
          : message?.proposalIds?.includes(p.id)),
    );
    if (proposal.type === "external_delivery" && message && deliveries.length) {
      setBatch({ ...message, deliveries, sessionId: conversation.session.id });
    } else {
      setSelected(proposal);
    }
  }

  async function loadSessions() {
    const list = await api("/assistant/sessions");
    if (alive.current) setSessions(list);
    return list as Item[];
  }
  async function load(id: string, allowPopup = true) {
    const next = await api("/assistant/sessions/" + id);
    if (!alive.current || activeSession.current !== id) return next;
    setDetail(next);
    if (
      allowPopup &&
      watch.current?.sessionId === id &&
      !["queued", "processing"].includes(next.session?.status)
    ) {
      const proposal = selectNewProposal(
        next.proposals || [],
        watch.current.known,
      );
      watch.current = null;
      if (proposal) openProposal(proposal, next);
      void loadSessions().catch(() => {});
    }
    return next;
  }
  useEffect(() => {
    alive.current = true;
    void loadSessions()
      .then(async (list) => {
        if (list.length && alive.current && !activeSession.current) {
          activeSession.current = list[0].id;
          setSessionId(list[0].id);
          await load(list[0].id, false);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      alive.current = false;
      const urls = new Set(
        [
          ...imageRef.current,
          ...Object.values(conversationDrafts.current).flatMap(
            (draft) => draft.images,
          ),
        ].map((image) => image.url),
      );
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);
  useEffect(() => {
    if (!sessionId) return;
    let polling = false;
    const timer = setInterval(
      () => {
        if (polling) return;
        polling = true;
        void load(sessionId)
          .catch((e) => {
            if (activeSession.current === sessionId) setError(e.message);
          })
          .finally(() => {
            polling = false;
          });
      },
      processing || watch.current ? 1600 : 8000,
    );
    return () => clearInterval(timer);
  }, [sessionId, !!processing]);
  useEffect(() => {
    const node = scroll.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [detail?.messages?.length, processing]);
  function attach(files: File[]) {
    if (busy || uncertain) return;
    const accepted = files.filter((f) =>
      ["image/png", "image/jpeg", "image/webp"].includes(f.type),
    );
    if (accepted.length !== files.length)
      setError("截图支持 PNG、JPG 和 WebP 格式。");
    if (accepted.some((f) => f.size > 12 * 1024 * 1024)) {
      setError("每张截图最多 12 MB，请先缩小超限图片。");
      return;
    }
    if (images.length + accepted.length > 20) {
      setError("每次最多发送 20 张截图。");
      return;
    }
    setImages((prior) => [
      ...prior,
      ...accepted.map((file) => ({
        key: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
      })),
    ]);
    composer.current?.focus();
  }
  async function chooseSession(id: string) {
    if (busy || uncertain) return;
    conversationDrafts.current[activeSession.current] = { text, images };
    const draft = conversationDrafts.current[id] || { text: "", images: [] };
    setText(draft.text);
    setImages(draft.images);
    activeSession.current = id;
    setSessionId(id);
    setDetail(null);
    setError("");
    setSelected(null);
    setBatch(null);
    watch.current = null;
    if (!id) {
      setHistory(false);
      return;
    }
    setLoading(true);
    try {
      await load(id, false);
      setHistory(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function send() {
    if (
      sending.current ||
      processing ||
      (!text.trim() && !images.length && !pendingRequest.current)
    )
      return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      let id = activeSession.current;
      if (!id) {
        const session = await api("/assistant/sessions", {});
        id = session.id;
        delete conversationDrafts.current[""];
        activeSession.current = id;
        setSessionId(id);
        setDetail({ session, messages: [], proposals: [] });
      }
      if (!pendingRequest.current) {
        let uploaded = images;
        for (let i = 0; i < uploaded.length; i++) {
          if (uploaded[i].id) continue;
          const form = new FormData();
          form.append("file", uploaded[i].file);
          const result = await api("/screenshots", form);
          uploaded = uploaded.map((image, index) =>
            index === i ? { ...image, id: result[0].id } : image,
          );
          setImages(uploaded);
        }
        pendingRequest.current = {
          requestId: crypto.randomUUID(),
          text: text.trim(),
          imageIds: uploaded.map((image) => image.id),
        };
      }
      const known = new Set<string>(
        (activeDetail.current?.proposals || []).map(proposalVersion),
      );
      const next = await api(
        "/assistant/sessions/" + id + "/messages",
        pendingRequest.current,
      );
      watch.current = { sessionId: id, known };
      pendingRequest.current = null;
      setUncertain(false);
      setText("");
      conversationDrafts.current[id] = { text: "", images: [] };
      for (const image of imageRef.current) URL.revokeObjectURL(image.url);
      setImages([]);
      if (activeSession.current === id) setDetail(next);
      await load(id);
      void loadSessions().catch(() => {});
    } catch (e: any) {
      setError(e.message);
      setUncertain(!!pendingRequest.current);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function retry(message: Item) {
    setError("");
    try {
      const known = new Set<string>(
        (detail?.proposals || []).map(proposalVersion),
      );
      await api("/assistant/messages/" + message.id + "/retry", {});
      watch.current = { sessionId, known };
      await load(sessionId);
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function proposalUpdated(proposal: Item) {
    setSelected(null);
    await load(sessionId, false);
    try {
      await onRefresh();
    } catch {
      notify("操作已保存，列表刷新失败，可稍后刷新查看。");
    }
    if (proposal.status === "applied") {
      notify(
        proposal.type === "prepare_mail"
          ? "邮件草稿已准备好，请核对附件并发送"
          : "已按确认内容保存",
      );
      if (proposal.type === "prepare_mail") {
        const task = tasks.find((t) => t.id === proposal.payload.taskId);
        if (task) onMail(task);
      }
    }
  }
  const examples = [
    "帮我找出还没发给客户的补正单",
    "检查哪些订单缺少邮箱或软件名称",
    "帮我写一个补正材料交付模板",
  ];
  return (
    <div
      className="page assistant-page"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (!selected) attach(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="page-heading assistant-heading">
        <div>
          <p className="context-line">发截图录入，用对话整理工作</p>
          <h1>AI 助手</h1>
        </div>
        <div className="button-group">
          <button onClick={() => setHistory(!history)} aria-expanded={history}>
            <History size={16} /> 对话记录 <ChevronDown size={14} />
          </button>
          <button
            disabled={busy || uncertain}
            onClick={() => void chooseSession("")}
          >
            <Plus size={16} /> 新对话
          </button>
        </div>
      </div>
      <div className={"assistant-layout " + (history ? "has-history" : "")}>
        {history && (
          <aside className="assistant-history" aria-label="对话记录">
            <div className="assistant-history-title">
              <strong>最近对话</strong>
              <span>{sessions.length}</span>
            </div>
            {sessions.length ? (
              sessions.map((session) => (
                <button
                  key={session.id}
                  disabled={busy || uncertain}
                  className={session.id === sessionId ? "active" : ""}
                  onClick={() => void chooseSession(session.id)}
                >
                  <span>{session.title || "新对话"}</span>
                  <small>{dateLabel(session.updatedAt)}</small>
                </button>
              ))
            ) : (
              <div className="assistant-history-empty">
                每次对话独立保存。
                <br />
                从右侧发送第一条消息。
              </div>
            )}
            <div className="assistant-history-foot">
              <MessagesSquare size={16} />
              <span>
                截图、结果和确认记录
                <br />
                都留在对应对话中
              </span>
            </div>
          </aside>
        )}
        <div className="assistant-workspace">
          <div
            className="assistant-conversation"
            ref={scroll}
            role="log"
            aria-label="AI 对话记录"
            aria-live="polite"
          >
            {loading ? (
              <div className="assistant-loading">
                <Busy label="读取对话…" />
              </div>
            ) : !detail?.messages?.length ? (
              <div className="assistant-welcome">
                <div className="assistant-welcome-mark">
                  <MessagesSquare size={25} strokeWidth={1.6} />
                </div>
                <span className="assistant-eyebrow">你的订单助理</span>
                <h2>发张截图，开始整理订单。</h2>
                <p>
                  把同一客户的聊天截图粘贴到下方，发送后会自动弹出预填好的录入框。也可以直接告诉我想查找或调整什么。
                </p>
                <div className="assistant-suggestions">
                  {examples.map((example) => (
                    <button
                      key={example}
                      onClick={() => {
                        setText(example);
                        composer.current?.focus();
                      }}
                    >
                      <span>{example}</span>
                      <ArrowRight size={16} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              detail.messages.map((message: Item) => (
                <article
                  key={message.id}
                  className={"assistant-message " + message.role}
                >
                  <div className="assistant-message-meta">
                    <strong>
                      {message.role === "user" ? "你" : "AI 助手"}
                    </strong>
                    <span>{dateLabel(message.createdAt)}</span>
                  </div>
                  {message.text && (
                    <div className="assistant-message-text">{message.text}</div>
                  )}
                  {!!message.imageIds?.length && (
                    <div className="assistant-message-images">
                      {message.imageIds.map((id: string, i: number) => (
                        <button
                          key={id}
                          onClick={() => setViewImages(message.imageIds)}
                          aria-label={"查看截图 " + (i + 1)}
                        >
                          <img
                            src={
                              import.meta.env.BASE_URL +
                              "api/v1/screenshots/" +
                              id
                            }
                            alt={"聊天截图 " + (i + 1)}
                          />
                        </button>
                      ))}
                    </div>
                  )}
                  {!!message.references?.length && (
                    <div className="assistant-references">
                      {message.references
                        .filter((r: Item) => r.type === "task")
                        .map((reference: Item) => {
                          const task = tasks.find((t) => t.id === reference.id);
                          return task ? (
                            <button
                              key={reference.id}
                              onClick={() => onTask(task)}
                            >
                              {reference.label ||
                                task.softwareName ||
                                "名称待定"}
                              <ArrowRight size={14} />
                            </button>
                          ) : null;
                        })}
                    </div>
                  )}
                  {(detail.proposals || [])
                    .filter((p: Item) =>
                      p.messageId
                        ? p.messageId === message.id
                        : message.proposalIds?.includes(p.id),
                    )
                    .filter(
                      (p: Item, index: number, list: Item[]) =>
                        p.type !== "external_delivery" ||
                        !isProposalEditable(p) ||
                        list.findIndex(
                          (x) =>
                            x.type === "external_delivery" &&
                            isProposalEditable(x),
                        ) === index,
                    )
                    .map((proposal: Item) => (
                      <ProposalCard
                        key={proposal.id}
                        proposal={proposal}
                        tasks={tasks}
                        deliveryCount={
                          (detail.proposals || []).filter(
                            (p: Item) =>
                              p.type === "external_delivery" &&
                              isProposalEditable(p) &&
                              (p.messageId
                                ? p.messageId === message.id
                                : message.proposalIds?.includes(p.id)),
                          ).length
                        }
                        onOpen={() => openProposal(proposal, detail)}
                      />
                    ))}
                  {message.status === "failed" && (
                    <div className="assistant-message-error">
                      <p>
                        {message.error ||
                          "这次处理没有完成，消息和截图已保留。"}
                      </p>
                      <button
                        disabled={!!processing}
                        onClick={() => void retry(message)}
                      >
                        <RotateCcw size={14} /> 重新处理
                      </button>
                    </div>
                  )}
                </article>
              ))
            )}
            {/* Keep ungrouped proposals visible if a server returns them before their reply. */}
            {(detail?.proposals || [])
              .filter(
                (p: Item) =>
                  !(detail?.messages || []).some((m: Item) =>
                    p.messageId
                      ? p.messageId === m.id
                      : m.proposalIds?.includes(p.id),
                  ),
              )
              .map((p: Item) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  tasks={tasks}
                  onOpen={() => setSelected(p)}
                />
              ))}
            {processing && (
              <div className="assistant-thinking">
                <Busy
                  label={
                    detail?.session.status === "queued"
                      ? "已收到，正在准备处理…"
                      : "正在读取资料并整理结果…"
                  }
                />
                <span>结果准备好后，会自动打开需要你确认的内容。</span>
              </div>
            )}
          </div>
          <div className={"assistant-composer " + (drag ? "dragging" : "")}>
            <div className="assistant-composer-context">
              <span>发送到：{detail?.session?.title || "新对话"}</span>
              <small>未发送内容按对话暂存</small>
            </div>
            {error && (
              <div className="assistant-error" role="alert">
                <span>
                  {error}
                  {uncertain &&
                    " 输入和截图已保留，点击“重试发送”会核对同一条消息，不会重复提交。"}
                </span>
                <button
                  className="icon-button"
                  onClick={() => setError("")}
                  aria-label="关闭错误提示"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {!!images.length && (
              <div className="assistant-upload-strip">
                {images.map((image, i) => (
                  <div key={image.key}>
                    <img src={image.url} alt={"待发送截图 " + (i + 1)} />
                    <span>{i + 1}</span>
                    <button
                      disabled={busy || uncertain}
                      aria-label={"移除截图 " + (i + 1)}
                      onClick={() => {
                        URL.revokeObjectURL(image.url);
                        setImages((prev) =>
                          prev.filter((x) => x.key !== image.key),
                        );
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
                <small>{images.length} 张截图 · 同一客户可一起发送</small>
              </div>
            )}
            <textarea
              ref={composer}
              value={text}
              disabled={busy || uncertain}
              rows={3}
              aria-label="给 AI 助手的消息"
              placeholder="粘贴聊天截图，或告诉我：把小王的补正单找出来，邮箱改成……"
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files).filter((file) =>
                  file.type.startsWith("image/"),
                );
                if (files.length) {
                  e.preventDefault();
                  attach(files);
                }
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="assistant-composer-foot">
              <input
                hidden
                type="file"
                ref={input}
                multiple
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  attach(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />
              <button
                disabled={busy || uncertain}
                onClick={() => input.current?.click()}
              >
                <Paperclip size={16} /> 添加截图
              </button>
              <small>
                {processing
                  ? "当前消息处理中，可以先准备下一条"
                  : "Enter 发送 · Shift + Enter 换行"}
              </small>
              <button
                className="primary"
                disabled={
                  busy ||
                  !!processing ||
                  (!text.trim() && !images.length && !uncertain)
                }
                onClick={() => void send()}
              >
                {busy ? (
                  <Busy label="发送中" />
                ) : (
                  <>
                    <Send size={16} />
                    {uncertain ? "重试发送" : "发送给 AI"}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="assistant-bottom-links">
        <span>修改先核对，确认后保存；邮件在发送前核对附件。</span>
        <button onClick={() => onNavigate("settings")}>
          <Settings size={13} /> 连接设置
        </button>
        <a href={import.meta.env.BASE_URL + "api/v1/export"} download>
          <Download size={13} /> 下载备份
        </a>
      </div>
      {batch && (
        <DeliveryBatchDialog
          key={batch.id}
          batch={batch}
          tasks={tasks}
          onClose={() => setBatch(null)}
          onSaved={async () => {
            await Promise.allSettled([
              load(batch.sessionId, false),
              onRefresh(),
            ]);
          }}
        />
      )}
      {selected && (
        <ProposalDialog
          key={selected.id + ":" + selected.revision}
          proposal={selected}
          data={data}
          onClose={() => setSelected(null)}
          onUpdated={proposalUpdated}
          onTask={onTask}
        />
      )}
      {viewImages && (
        <Modal title="聊天截图" wide onClose={() => setViewImages(null)}>
          <div className="assistant-source-full">
            <ImageViewer ids={viewImages} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function DeliveryBatchDialog({
  batch,
  tasks,
  onClose,
  onSaved,
}: {
  batch: Item;
  tasks: Item[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const proposals: Item[] = batch.deliveries;
  const [checked, setChecked] = useState(
    () => new Set(proposals.map((p) => p.id)),
  );
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const pending = proposals.filter(
    (p) => checked.has(p.id) && !applied.has(p.id),
  );

  async function confirm() {
    if (busy || !pending.length) return;
    setBusy(true);
    for (const proposal of pending) {
      try {
        const result = await api(
          "/assistant/proposals/" + proposal.id + "/confirm",
          {
            revision: proposal.revision,
          },
        );
        if (result.status !== "applied")
          throw new Error(result.error || "交付未保存");
        setApplied((previous) => new Set(previous).add(proposal.id));
      } catch (error) {
        setErrors((previous) => ({
          ...previous,
          [proposal.id]:
            error instanceof Error ? error.message : "保存失败，请重试",
        }));
      }
    }
    await onSaved();
    setBusy(false);
  }

  return (
    <Modal
      title="批量交付确认"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body">
        <p className="notice">
          确认后，勾选的订单会标记为已完成并保存交付记录。
        </p>
        <ul className="delivery-batch-list">
          {proposals.map((proposal) => {
            const task = tasks.find((t) => t.id === proposal.payload.taskId);
            const done = applied.has(proposal.id);
            return (
              <li key={proposal.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked.has(proposal.id)}
                    disabled={busy || done}
                    onChange={(event) => {
                      const selected = event.target.checked;
                      setChecked((previous) => {
                        const next = new Set(previous);
                        if (selected) next.add(proposal.id);
                        else next.delete(proposal.id);
                        return next;
                      });
                    }}
                  />
                  <span>
                    <strong>{task?.softwareName || proposal.title}</strong>
                    <small>
                      {[
                        task?.customerName,
                        task?.kind === "new"
                          ? "新单"
                          : task?.kind === "correction"
                            ? "补正"
                            : "",
                        proposal.payload.channel,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    {proposal.payload.notes && (
                      <small>{proposal.payload.notes}</small>
                    )}
                  </span>
                </label>
                {done ? (
                  <small>已确认</small>
                ) : (
                  errors[proposal.id] && (
                    <p className="error" role="alert">
                      {errors[proposal.id]}
                    </p>
                  )
                )}
              </li>
            );
          })}
        </ul>
        {batch.text && (
          <section>
            <h3>匹配说明</h3>
            <div className="assistant-message-text">{batch.text}</div>
          </section>
        )}
      </div>
      <div className="modal-foot">
        <button disabled={busy} onClick={onClose}>
          {applied.size ? "关闭" : "取消"}
        </button>
        <button
          className="primary"
          disabled={busy || !pending.length}
          onClick={() => void confirm()}
        >
          {busy ? "正在保存…" : `确认交付（${pending.length} 项）`}
        </button>
      </div>
    </Modal>
  );
}

function ProposalCard({
  proposal,
  tasks,
  deliveryCount,
  onOpen,
}: {
  proposal: Item;
  tasks: Item[];
  deliveryCount?: number;
  onOpen: () => void;
}) {
  const task = tasks.find((t) => t.id === proposal.payload?.taskId);
  return (
    <section className={"assistant-proposal-card " + proposal.status}>
      <header>
        <strong>
          {proposal.type === "external_delivery" &&
          isProposalEditable(proposal) &&
          deliveryCount
            ? `交付确认 · ${deliveryCount} 项`
            : proposal.title || proposalNames[proposal.type] || "待核对操作"}
        </strong>
        <span>{proposalStates[proposal.status] || proposal.status}</span>
      </header>
      {proposal.explanation && <p>{proposal.explanation}</p>}
      {proposal.type === "create_tasks" ? (
        <ul>
          {proposal.payload.items.map((item: Item, i: number) => (
            <li key={i}>
              <span>{item.kind === "correction" ? "补正" : "新单"}</span>
              {item.softwareName || "软件名称待补充"}
              <small>
                {item.customerName || "客户待补充"} ·{" "}
                {item.email || "邮箱待补充"}
              </small>
            </li>
          ))}
        </ul>
      ) : task ? (
        <p className="assistant-proposal-target">
          {task.customerName || "客户待补充"} ·{" "}
          {task.softwareName || "名称待定"}
        </p>
      ) : proposal.type === "archive_tasks" ? (
        <p>涉及 {proposal.payload.targets?.length || 0} 项任务</p>
      ) : null}
      {proposal.error && <p className="error">{proposal.error}</p>}
      <button
        className={isProposalEditable(proposal) ? "primary" : ""}
        onClick={onOpen}
      >
        {isProposalEditable(proposal) ? "核对并确认" : "查看详情"}
        <ArrowRight size={14} />
      </button>
    </section>
  );
}

function ProposalDialog({
  proposal,
  data,
  onClose,
  onUpdated,
  onTask,
}: {
  proposal: Item;
  data: Item;
  onClose: () => void;
  onUpdated: (p: Item) => Promise<void>;
  onTask: (t: Item) => void;
}) {
  const tasks: Item[] = data.tasks || [],
    customers: Item[] = data.customers || [];
  const [current, setCurrent] = useState(proposal),
    [payload, setPayload] = useState<Item>(() =>
      editablePayload(proposal, tasks),
    ),
    [active, setActive] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [remoteProposal, setRemoteProposal] = useState<Item | null>(null),
    [preview, setPreview] = useState(false);
  const saving = useRef(false);
  const editable = isProposalEditable(current),
    type = current.type,
    task = tasks.find((t) => t.id === payload.taskId);
  const imageIds: string[] = payload.imageIds || [];
  const set = (key: string, value: any) =>
    setPayload((p) => ({ ...p, [key]: value }));
  const updateItem = (index: number, item: Item) =>
    setPayload((p) => ({
      ...p,
      items: p.items.map((x: Item, i: number) => (i === index ? item : x)),
    }));
  async function confirm() {
    if (saving.current || remoteProposal) return;
    saving.current = true;
    setBusy(true);
    setError("");
    let knownRevision = current.revision;
    try {
      const saved = await api(
        "/assistant/proposals/" + current.id,
        { revision: current.revision, payload },
        "PATCH",
      );
      setCurrent(saved);
      knownRevision = saved.revision;
      const result = await api(
        "/assistant/proposals/" + current.id + "/confirm",
        { revision: saved.revision },
      );
      setCurrent(result);
      if (result.status === "failed") {
        setError(result.error || "操作没有完成，修改内容已保留。");
        return;
      }
      await onUpdated(result);
    } catch (e: any) {
      // A response can be lost after a successful write. Read its actual result
      // before offering another attempt; never create a new proposal to retry.
      try {
        const latest = await api("/assistant/sessions/" + current.sessionId);
        const actual = latest.proposals?.find((p: Item) => p.id === current.id);
        const recovery = confirmationRecovery(actual, knownRevision);
        if (recovery === "applied") {
          setCurrent(actual);
          await onUpdated(actual);
          return;
        }
        if (recovery === "reload") setRemoteProposal(actual);
        if (actual?.status === "failed" || actual?.status === "cancelled")
          setCurrent(actual);
      } catch {
        /* Keep the user's edits until the connection is available. */
      }
      setError(e.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function cancel() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await onUpdated(
        await api("/assistant/proposals/" + current.id + "/cancel", {
          revision: current.revision,
        }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={current.title || proposalNames[type] || "核对操作"}
      className="assistant-review-modal"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {remoteProposal && (
        <div className="notice assistant-conflict" role="alert">
          <div>
            <b>待确认内容已有更新</b>
            <p>
              当前输入仍保留。重新载入会替换本窗口尚未保存的内容，请再次核对后确认。
            </p>
          </div>
          <button
            disabled={busy}
            onClick={() => {
              setCurrent(remoteProposal);
              setPayload(editablePayload(remoteProposal, tasks));
              setActive(0);
              setRemoteProposal(null);
              setError("");
            }}
          >
            重新载入最新内容
          </button>
        </div>
      )}
      <div
        className={"assistant-review " + (imageIds.length ? "with-images" : "")}
      >
        {!!imageIds.length && (
          <aside className="assistant-review-source">
            <div className="assistant-section-title">
              <FileImage size={15} />
              <strong>来源截图</strong>
              <span>{imageIds.length} 张</span>
            </div>
            <ImageViewer ids={imageIds} />
          </aside>
        )}
        <div className="assistant-review-fields">
          {current.explanation && (
            <p className="assistant-review-intro">{current.explanation}</p>
          )}
          {!!current.warnings?.length && (
            <div className="notice">
              <b>需要留意</b>
              <ul>
                {current.warnings.map((warning: string, i: number) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          {!editable && (
            <div className={"assistant-review-state " + current.status}>
              {current.status === "applied" && <Check size={16} />}
              {proposalStates[current.status] || current.status}
            </div>
          )}
          <fieldset disabled={!editable || busy} className="plain-fieldset">
            {type === "create_tasks" && (
              <>
                <section className="assistant-form-section">
                  <div className="form-section-heading">
                    <h3>客户与联系</h3>
                    <p>这些信息用于本次全部软件</p>
                  </div>
                  <Field label="客户归属">
                    <select
                      value={payload.customerId || ""}
                      onChange={(e) =>
                        setPayload((p) => ({
                          ...p,
                          customerId: e.target.value || undefined,
                          items: p.items.map((x: Item) => ({
                            ...x,
                            parentId: null,
                          })),
                        }))
                      }
                    >
                      <option value="">建立新客户档案</option>
                      {customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name} · {customer.email || "未留邮箱"}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="form-grid">
                    {[
                      ["customerName", "客户昵称"],
                      ["memberName", "会员名 / 备注名"],
                      ["email", "收件邮箱"],
                      ["wechat", "微信 / 联系方式"],
                    ].map(([key, label]) => (
                      <Field key={key} label={label}>
                        <input
                          value={payload.items[0]?.[key] || ""}
                          onChange={(e) =>
                            setPayload((p) => ({
                              ...p,
                              items: p.items.map((item: Item) => ({
                                ...item,
                                [key]: e.target.value,
                              })),
                            }))
                          }
                        />
                      </Field>
                    ))}
                  </div>
                </section>
                <section className="assistant-form-section">
                  <div className="form-section-heading">
                    <h3>软件与订单</h3>
                    <p>逐个核对软件信息</p>
                  </div>
                  <div className="assistant-software-tabs">
                    {payload.items.map((item: Item, i: number) => (
                      <button
                        key={i}
                        type="button"
                        className={active === i ? "active" : ""}
                        onClick={() => setActive(i)}
                      >
                        软件 {i + 1}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setPayload((p) => ({
                          ...p,
                          items: [
                            ...p.items,
                            {
                              ...newTaskDraft(),
                              ...Object.fromEntries(
                                [
                                  "customerName",
                                  "memberName",
                                  "email",
                                  "wechat",
                                ].map((k) => [k, p.items[0]?.[k] || ""]),
                              ),
                            },
                          ],
                        }));
                        setActive(payload.items.length);
                      }}
                    >
                      <Plus size={13} /> 添加软件
                    </button>
                  </div>
                  <TaskFields
                    contact={false}
                    value={payload.items[active] || emptyTask}
                    onChange={(item) =>
                      updateItem(
                        active,
                        item.kind !== "correction"
                          ? { ...item, parentId: null }
                          : item,
                      )
                    }
                  />
                  {payload.items[active]?.kind === "correction" && (
                    <Field label="关联原单（找不到可以不选）">
                      <select
                        value={payload.items[active].parentId || ""}
                        onChange={(e) => {
                          const parent = tasks.find(
                            (t) => t.id === e.target.value,
                          );
                          setPayload((p) => ({
                            ...p,
                            customerId: parent?.customerId || p.customerId,
                            items: p.items.map((item: Item, i: number) =>
                              i === active
                                ? {
                                    ...item,
                                    parentId: e.target.value || null,
                                    originalName:
                                      item.originalName ||
                                      parent?.softwareName ||
                                      "",
                                  }
                                : item,
                            ),
                          }));
                        }}
                      >
                        <option value="">暂不关联，独立录入补正</option>
                        {tasks
                          .filter(
                            (t) =>
                              !t.archived &&
                              (!payload.customerId ||
                                t.customerId === payload.customerId),
                          )
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.customerName} · {t.softwareName || "名称待定"}
                            </option>
                          ))}
                      </select>
                    </Field>
                  )}
                  {!!current.candidates?.length && (
                    <details className="assistant-candidates">
                      <summary>
                        找到 {current.candidates.length} 条可能相关的历史任务
                      </summary>
                      {current.candidates.map((candidate: Item) => (
                        <div key={candidate.task.id}>
                          <span>
                            {candidate.task.customerName} ·{" "}
                            {candidate.task.softwareName || "名称待定"}
                          </span>
                          <small>{candidate.reasons?.join("、")}</small>
                          <details className="assistant-candidate-detail">
                            <summary>查看原资料</summary>
                            <p>邮箱：{candidate.task.email || "未填写"}</p>
                            <p>
                              原名称：
                              {candidate.task.originalName ||
                                candidate.task.softwareName ||
                                "未填写"}
                            </p>
                            <p>
                              状态：
                              {candidate.task.completed
                                ? "已发送完成"
                                : "未完成"}
                            </p>
                            {candidate.task.notes && (
                              <p>备注：{candidate.task.notes}</p>
                            )}
                          </details>
                        </div>
                      ))}
                    </details>
                  )}
                  {!!payload.items[active]?.sources?.length && (
                    <details className="assistant-candidates">
                      <summary>查看识别依据</summary>
                      {payload.items[active].sources.map(
                        (source: Item, i: number) => (
                          <p key={i}>
                            {source.field} · 图 {source.imageIndex}：
                            {source.quote}
                          </p>
                        ),
                      )}
                    </details>
                  )}
                  {payload.items.length > 1 && (
                    <button
                      className="danger-text"
                      type="button"
                      onClick={() => {
                        setPayload((p) => ({
                          ...p,
                          items: p.items.filter(
                            (_: Item, i: number) => i !== active,
                          ),
                        }));
                        setActive(0);
                      }}
                    >
                      <X size={14} /> 删除当前软件
                    </button>
                  )}
                </section>
              </>
            )}
            {type === "update_task" && (
              <>
                <TaskIdentity task={task} />
                <TaskFields
                  value={payload.fields}
                  onChange={(value) => set("fields", taskPayload(value))}
                />
              </>
            )}
            {type === "link_task" && (
              <>
                <TaskIdentity task={task} />
                <Field label="关联原单">
                  <select
                    value={payload.parentId || ""}
                    onChange={(e) => set("parentId", e.target.value || null)}
                  >
                    <option value="">解除原单关联</option>
                    {tasks
                      .filter((t) => t.id !== payload.taskId && !t.archived)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.customerName} · {t.softwareName || "名称待定"}
                        </option>
                      ))}
                  </select>
                </Field>
              </>
            )}
            {type === "external_delivery" && (
              <>
                <TaskIdentity task={task} />
                <p className="notice">
                  确认后将记录为已在外部发送，任务会变为已完成。
                </p>
                <Field label="发送方式">
                  <input
                    value={payload.channel || ""}
                    onChange={(e) => set("channel", e.target.value)}
                    placeholder="微信、QQ邮箱、网盘等"
                  />
                </Field>
                <Field label="交付说明">
                  <textarea
                    rows={3}
                    value={payload.notes || ""}
                    onChange={(e) => set("notes", e.target.value)}
                  />
                </Field>
              </>
            )}
            {type === "reopen_task" && (
              <>
                <TaskIdentity task={task} />
                <p className="notice">
                  任务将重新标记为未完成，之前的交付历史仍会保留。
                </p>
              </>
            )}
            {type === "archive_tasks" && (
              <>
                <Field label="整理方式">
                  <select
                    value={String(!!payload.archived)}
                    onChange={(e) => set("archived", e.target.value === "true")}
                  >
                    <option value="true">归档以下任务</option>
                    <option value="false">取消归档，恢复到列表</option>
                  </select>
                </Field>
                <div className="assistant-targets">
                  {payload.targets?.map((target: Item) => {
                    const t = tasks.find((x) => x.id === target.taskId);
                    return (
                      <div key={target.taskId}>
                        <span>{t?.customerName || "客户待补充"}</span>
                        <strong>{t?.softwareName || "名称待定"}</strong>
                        <button
                          type="button"
                          disabled={payload.targets.length <= 1}
                          onClick={() =>
                            set(
                              "targets",
                              payload.targets.filter(
                                (x: Item) => x.taskId !== target.taskId,
                              ),
                            )
                          }
                        >
                          <X size={14} /> 移出本次
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {type === "update_customer" && (
              <div className="form-grid">
                {[
                  ["name", "客户昵称"],
                  ["memberName", "会员名"],
                  ["email", "邮箱"],
                  ["wechat", "微信 / 联系方式"],
                  ["notes", "备注"],
                ].map(([key, label]) => (
                  <Field key={key} label={label} wide={key === "notes"}>
                    {key === "notes" ? (
                      <textarea
                        rows={3}
                        value={payload.fields?.[key] || ""}
                        onChange={(e) =>
                          set("fields", {
                            ...payload.fields,
                            [key]: e.target.value,
                          })
                        }
                      />
                    ) : (
                      <input
                        value={payload.fields?.[key] || ""}
                        onChange={(e) =>
                          set("fields", {
                            ...payload.fields,
                            [key]: e.target.value,
                          })
                        }
                      />
                    )}
                  </Field>
                ))}
              </div>
            )}
            {(type === "save_template" || type === "prepare_mail") && (
              <>
                {type === "save_template" ? (
                  <div className="form-grid">
                    <Field label="模板名称">
                      <input
                        value={payload.name || ""}
                        onChange={(e) => set("name", e.target.value)}
                      />
                    </Field>
                    <Field label="适用类型">
                      <select
                        value={payload.kind || "all"}
                        onChange={(e) => set("kind", e.target.value)}
                      >
                        <option value="all">通用</option>
                        <option value="new">新单</option>
                        <option value="correction">补正</option>
                      </select>
                    </Field>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={!!payload.isDefault}
                        onChange={(e) => set("isDefault", e.target.checked)}
                      />
                      设为默认模板
                    </label>
                  </div>
                ) : (
                  <>
                    <TaskIdentity task={task} />
                    <Field label="收件邮箱">
                      <input
                        value={payload.to || ""}
                        onChange={(e) => set("to", e.target.value)}
                      />
                    </Field>
                    <p className="notice">
                      确认后保存邮件草稿并打开写信窗口，可添加压缩包后发送。
                    </p>
                  </>
                )}
                <Field label="邮件主题">
                  <input
                    value={payload.subject || ""}
                    onChange={(e) => set("subject", e.target.value)}
                  />
                </Field>
                <div className="assistant-section-title">
                  <strong>正文</strong>
                  <button type="button" onClick={() => setPreview(!preview)}>
                    {preview ? "返回编辑" : "预览"}
                  </button>
                </div>
                <div className="assistant-mail-editor">
                  {preview || !editable ? (
                    <MailPreview html={payload.html || ""} />
                  ) : (
                    <RichEditor
                      value={payload.html || ""}
                      onChange={(html) => set("html", html)}
                    />
                  )}
                </div>
              </>
            )}
            {type === "delete_template" && (
              <p className="notice">
                将删除模板“
                {data.templates?.find((t: Item) => t.id === payload.id)?.name ||
                  current.title}
                ”。已有的发送记录不受影响。
              </p>
            )}
          </fieldset>
          {!!current.preview?.length && type !== "create_tasks" && (
            <details
              className="assistant-changes"
              open={["update_task", "update_customer", "reopen_task"].includes(
                type,
              )}
            >
              <summary>AI 建议的修改对照</summary>
              <dl>
                {current.preview.map((change: Item, i: number) => (
                  <div key={i}>
                    <dt>{fieldNames[change.label] || change.label}</dt>
                    <dd>
                      {change.before !== undefined && (
                        <del>{readableValue(change.before)}</del>
                      )}
                      <span>{readableValue(change.after)}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          {error && (
            <p className="error assistant-review-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <footer className="modal-foot assistant-review-footer">
        <span className="muted">
          {editable
            ? type === "create_tasks"
              ? `确认后录入 ${payload.items.length} 项任务`
              : "按上方核对后的内容保存"
            : proposalStates[current.status]}
        </span>
        {editable ? (
          <>
            <button
              disabled={busy || !!remoteProposal}
              onClick={() => void cancel()}
            >
              取消本次操作
            </button>
            <button disabled={busy} onClick={onClose}>
              稍后处理
            </button>
            <button
              className="primary"
              disabled={busy || !!remoteProposal || !proposalNames[type]}
              onClick={() => void confirm()}
            >
              {busy ? (
                <Busy label="保存中" />
              ) : (
                <>
                  <Check size={16} />
                  {type === "create_tasks"
                    ? "确认录入"
                    : type === "prepare_mail"
                      ? "确认并准备发送"
                      : "确认执行"}
                </>
              )}
            </button>
          </>
        ) : (
          <button onClick={onClose}>关闭</button>
        )}
      </footer>
    </Modal>
  );
}
function TaskIdentity({ task }: { task?: Item }) {
  return (
    <div className="assistant-task-identity">
      <span>
        {task?.customerName || "客户未填写"} ·{" "}
        {task?.kind === "correction" ? "补正" : "新单"}
      </span>
      <strong>{task?.softwareName || "软件名称待补充"}</strong>
    </div>
  );
}
