import { useState, useEffect, useRef } from "react";
import { Upload, Sparkles, Plus, Trash2, CheckCircle2 } from "lucide-react";
import {
  api,
  emptyTask,
  newTaskDraft,
  supplementTaskDraft,
  type Item,
  dateLabel,
} from "./api";
import { TaskFields } from "./Tasks";
import { ImageViewer, Field, Empty, Busy } from "./components";

export default function Intake({
  customers,
  tasks,
  intakes,
  onSaved,
  notify,
  onManual,
}: {
  customers: Item[];
  tasks: Item[];
  intakes: Item[];
  onSaved: () => Promise<void>;
  notify: (s: string) => void;
  onManual: () => void;
}) {
  const [images, setImages] = useState<Item[]>([]),
    [job, setJob] = useState<Item | null>(null),
    [items, setItems] = useState<Item[]>([]),
    [customer, setCustomer] = useState<Item>({
      customerName: "",
      memberName: "",
      email: "",
      wechat: "",
    }),
    [customerId, setCustomerId] = useState(""),
    [active, setActive] = useState(0),
    [warnings, setWarnings] = useState<string[]>([]),
    [candidates, setCandidates] = useState<Item[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [drag, setDrag] = useState(false),
    [mode, setMode] = useState("create"),
    [targetId, setTargetId] = useState(""),
    [targetRevision, setTargetRevision] = useState(0);
  const [proposal, setProposal] = useState<Item | null>(null);
  const input = useRef<HTMLInputElement>(null),
    applied = useRef(""),
    draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function upload(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      const result = await api("/screenshots", form);
      setImages((prev) =>
        [...prev, ...result].filter(
          (v, i, a) => a.findIndex((x) => x.id === v.id) === i,
        ),
      );
      if (result.some((x: Item) => x.duplicate))
        notify("部分截图已上传过，已复用原图；保存时仍请核对是否重复录单。");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length) {
        e.preventDefault();
        if (job) {
          notify("请先点击新一批，再添加截图。");
          return;
        }
        void upload(files);
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [job?.id]);
  function apply(j: Item) {
    setJob(j);
    if (applied.current !== j.id) setActive(0);
    setImages(j.imageIds.map((id: string) => ({ id })));
    if (applied.current !== j.id && j.draft) {
      setCustomer(j.draft.customer);
      setItems(
        j.draft.mode === "update"
          ? j.draft.items
          : j.draft.items.map((x: Item) => newTaskDraft(x)),
      );
      setCustomerId(j.draft.customerId || "");
      setMode(j.draft.mode || "create");
      setTargetId(j.draft.targetId || "");
      setTargetRevision(j.draft.targetRevision || 0);
      setProposal(
        j.draft.proposal ||
          (j.result
            ? {
                customer: j.result.customer,
                items: j.result.items.map((x: Item) => newTaskDraft(x)),
                customerId: "",
              }
            : null),
      );
      setWarnings(j.result?.warnings || []);
      applied.current = j.id;
    } else if (applied.current !== j.id && j.result) {
      setMode("create");
      setTargetId("");
      setProposal(null);
      setCustomer(j.result.customer);
      setItems(j.result.items.map((x: Item) => newTaskDraft(x)));
      setWarnings(j.result.warnings || []);
      setCustomerId("");
      applied.current = j.id;
    }
    if (j.status === "failed") setError(j.error);
  }
  useEffect(() => {
    if (!job || !["queued", "processing"].includes(job.status)) return;
    const timer = setInterval(() => {
      void api("/intakes/" + job.id)
        .then(apply)
        .catch((e) => setError(e.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!items.length) return;
    const timer = setTimeout(() => {
      void api("/candidates", { ...items[active], ...customer })
        .then(setCandidates)
        .catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [customer, items, active]);
  useEffect(() => {
    if (!job || !items.length || job.status === "saved") return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      void api(
        "/intakes/" + job.id,
        {
          draft: {
            customer,
            items,
            customerId,
            mode,
            targetId,
            targetRevision,
            proposal,
          },
        },
        "PATCH",
      ).catch((e) => setError("草稿保存失败：" + e.message));
    }, 900);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [
    customer,
    items,
    customerId,
    mode,
    targetId,
    targetRevision,
    proposal,
    job?.id,
  ]);
  async function run() {
    setBusy(true);
    setError("");
    try {
      const j = await api("/intakes", { imageIds: images.map((i) => i.id) });
      applied.current = "";
      setItems([]);
      setWarnings([]);
      setJob(j);
      await onSaved();
      notify("已提交识别，可以停留核对，也可以稍后从草稿继续。");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      let result: Item;
      if (mode === "update") {
        if (!targetId) throw new Error("请选择要补充的已有任务");
        await api("/tasks/" + targetId + "/supplement", {
          revision: targetRevision,
          intakeId: job?.id,
          imageIds: images.map((i) => i.id),
          fields: { ...items[0], ...customer },
        });
        result = { tasks: [{}] };
      } else
        result = await api("/tasks", {
          customerId: customerId || undefined,
          intakeId: job?.id,
          imageIds: images.map((i) => i.id),
          items: items.map((i) => ({ ...i, ...customer })),
        });
      setJob((j) => ({
        ...(j || { id: "", imageIds: images.map((i) => i.id) }),
        status: "saved",
      }));
      await onSaved();
      notify(
        mode === "update"
          ? "已有任务已补充，原截图和交付历史均已保留"
          : `已录入 ${result.tasks.length} 项任务`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setMode("create");
    setTargetId("");
    setTargetRevision(0);
    setProposal(null);
    setJob(null);
    setItems([]);
    setImages([]);
    setWarnings([]);
    setCandidates([]);
    setCustomer({ customerName: "", memberName: "", email: "", wechat: "" });
    setCustomerId("");
    setError("");
    setActive(0);
    applied.current = "";
  }
  function changeMode(next: string) {
    if (next === "update") setProposal({ customer, items, customerId });
    else if (proposal) {
      setCustomer(proposal.customer);
      setItems(proposal.items);
      setCustomerId(proposal.customerId || "");
      setProposal(null);
    }
    setMode(next);
    setTargetId("");
    setTargetRevision(0);
    setActive(0);
  }
  function chooseTarget(id: string) {
    setTargetId(id);
    const t = tasks.find((t) => t.id === id);
    if (!t) {
      setTargetRevision(0);
      if (proposal) {
        setItems(proposal.items);
        setCustomer(proposal.customer);
        setCustomerId(proposal.customerId || "");
      }
      return;
    }
    setTargetRevision(t.revision);
    setCustomerId(t.customerId);
    const source = proposal?.items?.[0] || job?.result?.items?.[0] || {},
      contact = proposal?.customer || job?.result?.customer || {};
    setItems([supplementTaskDraft(t, source)]);
    setActive(0);
    setCustomer(
      Object.fromEntries(
        ["customerName", "memberName", "email", "wechat"].map((k) => [
          k,
          contact[k] || t[k] || "",
        ]),
      ),
    );
  }
  const processing = job && ["queued", "processing"].includes(job.status),
    done = job?.status === "saved";
  return (
    <div className="page intake-page">
      <div className="page-heading">
        <div>
          <p className="context-line">一个客户，多张截图，一次核对</p>
          <h1>截图录入</h1>
        </div>
        <div className="button-group">
          <button onClick={onManual}>不用截图，手工录入</button>
          <button onClick={reset}>新一批</button>
        </div>
      </div>
      <div className="intake-toolbar">
        <input
          hidden
          ref={input}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            void upload(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        <button
          disabled={busy || !!processing || !!job}
          onClick={() => input.current?.click()}
        >
          <Upload size={16} />
          添加截图
        </button>
        <span className="muted">支持拖入、粘贴；每张最多12MB</span>
        <select
          aria-label="继续录入草稿"
          value={job?.id || ""}
          onChange={(e) => {
            if (e.target.value) {
              applied.current = "";
              void api("/intakes/" + e.target.value)
                .then(apply)
                .catch((e) => setError(e.message));
            }
          }}
        >
          <option value="">继续之前的录入草稿</option>
          {intakes
            .filter((j) => j.status !== "saved")
            .map((j) => (
              <option key={j.id} value={j.id}>
                {dateLabel(j.createdAt)} · {j.imageIds.length}张 ·{" "}
                {j.status === "failed"
                  ? "识别失败"
                  : j.status === "review"
                    ? "待核对"
                    : "识别中"}
              </option>
            ))}
        </select>
        <button
          className="primary push-right"
          disabled={!images.length || busy || !!processing || !!job}
          onClick={() => void run()}
        >
          {processing ? (
            <Busy label="正在识别" />
          ) : (
            <>
              <Sparkles size={16} />
              识别截图
            </>
          )}
        </button>
      </div>
      {error && (
        <div className="notice error">
          {error}
          {job?.status === "failed" && (
            <button
              onClick={() =>
                void api("/intakes/" + job.id + "/retry", {})
                  .then((j) => {
                    setError("");
                    setJob(j);
                  })
                  .catch((e) => setError(e.message))
              }
            >
              重新识别
            </button>
          )}
        </div>
      )}
      <div className="intake-columns">
        <section
          className={"source-panel " + (drag ? "dragging" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!job) void upload(Array.from(e.dataTransfer.files));
          }}
        >
          <div className="panel-title">
            <h2>原始聊天</h2>
            <span>{images.length} 张截图</span>
            {images.length > 0 && !job && (
              <button onClick={() => setImages([])}>清空本批</button>
            )}
          </div>
          {images.length ? (
            <ImageViewer ids={images.map((i) => i.id)} />
          ) : (
            <div
              className="upload-empty"
              onClick={() => input.current?.click()}
            >
              <Upload size={40} strokeWidth={1.2} />
              <h3>把聊天截图放到这里</h3>
              <p>
                同一客户的名称、邮箱、购买信息
                <br />
                可以分别出现在不同截图里
              </p>
              <button className="primary">选择截图</button>
              <small>也可以直接粘贴图片</small>
            </div>
          )}
        </section>
        <section className="review-panel">
          <div className="panel-title">
            <h2>核对并录入</h2>
            <span>
              {processing
                ? "AI正在整理资料"
                : done
                  ? "已保存到订单"
                  : "保留来源，确认后保存"}
            </span>
          </div>
          {!items.length ? (
            <div className="review-empty">
              {processing ? (
                <>
                  <Busy label="正在读取聊天与订单信息…" />
                  <p>识别结果会出现在这里。缺失和冲突会单独提醒。</p>
                </>
              ) : (
                <Empty
                  title="等待识别结果"
                  description="识别后可以直接修改所有字段，也可以先手工填写。"
                  action={
                    <button onClick={() => setItems([newTaskDraft()])}>
                      先手工填写
                    </button>
                  }
                />
              )}
            </div>
          ) : (
            <>
              <div className="review-scroll">
                {done && (
                  <div className="success-banner">
                    <CheckCircle2 size={18} />
                    这一批已录入，后续可在工作台双击修改。
                  </div>
                )}
                {warnings.length > 0 && (
                  <div className="warnings">
                    <b>需要你留意</b>
                    <ul>
                      {warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="intake-destination">
                  <Field label="录入方式">
                    <select
                      value={mode}
                      disabled={done}
                      onChange={(e) => changeMode(e.target.value)}
                    >
                      <option value="create">建立新单 / 补正任务</option>
                      <option value="update" disabled={items.length !== 1}>
                        补充已有任务资料（单款软件）
                      </option>
                    </select>
                  </Field>
                  {mode === "update" && (
                    <>
                      <Field label="选择要更新的任务">
                        <select
                          value={targetId}
                          disabled={done}
                          onChange={(e) => chooseTarget(e.target.value)}
                        >
                          <option value="">请选择已有任务</option>
                          {tasks
                            .filter((t) => !t.archived)
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.customerName} ·{" "}
                                {t.softwareName || "名称待定"}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <p className="notice">
                        下面是待保存的合并结果，空白识别项已保留原资料。请核对后保存；原截图与交付记录不会被删除。
                      </p>
                    </>
                  )}
                </div>
                <div className="form-grid">
                  <Field label="客户归属" wide>
                    <select
                      disabled={done || mode === "update"}
                      value={customerId}
                      onChange={(e) => {
                        setCustomerId(e.target.value);
                        setItems((v) =>
                          v.map((x) => ({ ...x, parentId: null })),
                        );
                      }}
                    >
                      <option value="">作为新客户录入</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.email || "未留邮箱"}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {[
                    ["customerName", "客户昵称"],
                    ["memberName", "会员名"],
                    ["email", "收件邮箱"],
                    ["wechat", "微信 / 联系方式"],
                  ].map(([k, label]) => (
                    <Field key={k} label={label}>
                      <input
                        disabled={done}
                        value={customer[k] || ""}
                        onChange={(e) =>
                          setCustomer((v) => ({ ...v, [k]: e.target.value }))
                        }
                      />
                    </Field>
                  ))}
                </div>
                <div className="software-tabs">
                  {items.map((it, i) => (
                    <button
                      key={i}
                      className={active === i ? "active" : ""}
                      onClick={() => setActive(i)}
                    >
                      软件 {i + 1}
                    </button>
                  ))}
                  <button
                    disabled={done || mode === "update"}
                    onClick={() => {
                      setItems((v) => [...v, newTaskDraft()]);
                      setActive(items.length);
                    }}
                  >
                    <Plus size={14} />
                    添加软件
                  </button>
                </div>
                <fieldset disabled={done} className="plain-fieldset">
                  <TaskFields
                    contact={false}
                    value={{
                      ...(items[active] || emptyTask),
                      filingAccount: customer.filingAccount || "",
                      filingPassword: customer.filingPassword || "",
                    }}
                    onChange={(v) => {
                      setCustomer((prev) => ({
                        ...prev,
                        filingAccount: v.filingAccount,
                        filingPassword: v.filingPassword,
                      }));
                      setItems((prev) =>
                        prev.map((x, i) => (i === active ? v : x)),
                      );
                    }}
                  />
                </fieldset>
                {(items[active]?.sources || []).length > 0 && (
                  <details className="evidence">
                    <summary>查看字段识别依据</summary>
                    {items[active].sources.map((s: Item, i: number) => (
                      <p key={i}>
                        <b>{s.field}</b> · 图{s.imageIndex}
                        <br />
                        {s.quote}
                      </p>
                    ))}
                  </details>
                )}
                {items[active]?.kind === "correction" && mode === "create" && (
                  <div className="matching">
                    <h3>
                      关联原单 <small>可选</small>
                    </h3>
                    {items[active].parentId ? (
                      <p className="notice">
                        已选择原任务{" "}
                        <button
                          disabled={done}
                          onClick={() =>
                            setItems((v) =>
                              v.map((x, i) =>
                                i === active ? { ...x, parentId: null } : x,
                              ),
                            )
                          }
                        >
                          解除
                        </button>
                      </p>
                    ) : (
                      <p className="muted">没有匹配原单也可以直接保存补正。</p>
                    )}
                    {candidates.map((c) => (
                      <button
                        disabled={done}
                        className="candidate"
                        key={c.task.id}
                        onClick={() => {
                          setCustomerId(c.task.customerId);
                          setItems((v) =>
                            v.map((x, i) =>
                              i === active
                                ? {
                                    ...x,
                                    parentId: c.task.id,
                                    originalName:
                                      x.originalName || c.task.softwareName,
                                  }
                                : x,
                            ),
                          );
                        }}
                      >
                        <strong>{c.task.softwareName || "名称待定"}</strong>
                        <span>
                          {c.task.customerName} · {c.reasons.join("、")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {items[active]?.kind === "new" && candidates.length > 0 && (
                  <div className="notice">
                    找到 {candidates.length}{" "}
                    条可能相关的历史任务，请确认是否重复录单：
                    {candidates.slice(0, 3).map((c) => (
                      <p key={c.task.id}>
                        {c.task.customerName} · {c.task.softwareName}（
                        {c.reasons.join("、")}）
                      </p>
                    ))}
                  </div>
                )}
                {items.length > 1 && (
                  <button
                    className="danger-text"
                    disabled={done || mode === "update"}
                    onClick={() => {
                      setItems((v) => v.filter((_, i) => i !== active));
                      setActive(0);
                    }}
                  >
                    <Trash2 size={14} />
                    删除当前软件
                  </button>
                )}
              </div>
              <footer className="review-footer">
                <span>
                  {done
                    ? "已完成本批录入"
                    : mode === "update"
                      ? "将更新已有任务"
                      : `将建立 ${items.length} 项任务`}
                </span>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    done ||
                    !!processing ||
                    (mode === "update" && !targetId)
                  }
                  onClick={() => void save()}
                >
                  {busy ? (
                    <Busy label="保存中" />
                  ) : done ? (
                    "已录入"
                  ) : (
                    "确认并录入"
                  )}
                </button>
              </footer>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
