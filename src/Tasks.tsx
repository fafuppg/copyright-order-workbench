import { CopyrightLogin } from "./CopyrightLogin";
import { withReworkStatus } from "../shared/rework-status";
import { groupTasks, paginateTaskGroups } from "../shared/task-groups";
import {
  useState,
  useEffect,
  useCallback,
  useId,
  useRef,
  Fragment,
} from "react";
import {
  Search,
  Plus,
  Send,
  ArrowUpRight,
  RotateCcw,
  Link2,
  Archive,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Download,
  Package,
  PackageCheck,
  Stamp,
  ShieldCheck,
} from "lucide-react";
import { api, emptyTask, newTaskDraft, dateLabel, type Item } from "./api";
import {
  Modal,
  Field,
  InlineCell,
  Status,
  Empty,
  Busy,
  ImageViewer,
  MailPreview,
} from "./components";

export function TaskFields({
  value,
  onChange,
  contact = true,
}: {
  value: Item;
  onChange: (v: Item) => void;
  contact?: boolean;
}) {
  const typeGroup = useId();
  const [showPassword, setShowPassword] = useState(false);
  const set = (key: string, v: any) =>
    onChange({
      ...value,
      [key]: v,
      ...(key === "purchasedAt" ? { purchaseDateDefaulted: false } : {}),
    });
  return (
    <div className="form-grid">
      {contact && (
        <>
          <Field label="客户昵称">
            <input
              value={value.customerName || ""}
              onChange={(e) => set("customerName", e.target.value)}
              placeholder="可稍后补充"
            />
          </Field>
          <Field label="会员名 / 备注名">
            <input
              value={value.memberName || ""}
              onChange={(e) => set("memberName", e.target.value)}
            />
          </Field>
          <Field label="收件邮箱">
            <input
              value={value.email || ""}
              onChange={(e) => set("email", e.target.value)}
              placeholder="未提供可留空"
            />
          </Field>
          <Field label="微信 / 其他联系方式">
            <input
              value={value.wechat || ""}
              onChange={(e) => set("wechat", e.target.value)}
            />
          </Field>
        </>
      )}
      <div className="field">
        <span>任务类型（由你选择）</span>
        <div
          className="task-kind-choice"
          role="radiogroup"
          aria-label="任务类型"
        >
          {[
            ["new", "新单"],
            ["correction", "补正"],
          ].map(([kind, label]) => (
            <label key={kind} className={value.kind === kind ? "selected" : ""}>
              <input
                type="radio"
                name={typeGroup}
                value={kind}
                checked={value.kind === kind}
                onChange={() =>
                  onChange({
                    ...value,
                    kind,
                    ...(kind === "new" ? { parentId: null } : {}),
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
        <small className="muted">
          新录入默认新单；补正请手动勾选，AI不判断。
        </small>
      </div>
      <Field label="购买日期">
        <input
          type="date"
          value={value.purchasedAt || ""}
          onChange={(e) => set("purchasedAt", e.target.value)}
        />
        {value.purchaseDateDefaulted && (
          <small className="muted">默认今天（上海时间），可修改</small>
        )}
      </Field>
      {value.kind === "correction" && (
        <Field label="原软件名称" wide>
          <textarea
            rows={2}
            value={value.originalName || ""}
            onChange={(e) => set("originalName", e.target.value)}
            placeholder="找不到原单也可以直接填写"
          />
        </Field>
      )}
      <Field label="录入名称（客户约定）" wide>
        <textarea
          rows={2}
          value={value.intakeName ?? value.softwareName ?? ""}
          onChange={(e) => set("intakeName", e.target.value)}
          placeholder="记录与客户约定的名称"
        />
      </Field>
      <Field label="制作名称（实际交付）" wide>
        <textarea
          rows={2}
          value={value.softwareName || ""}
          onChange={(e) => set("softwareName", e.target.value)}
          placeholder="制作时可修改，发送邮件使用此名称"
        />
      </Field>
      <Field label="成交金额（元）">
        <input
          type="number"
          min="0"
          step="0.01"
          value={value.amount || ""}
          onChange={(e) => set("amount", e.target.value)}
          placeholder="未确认可留空"
        />
      </Field>
      <div className="field checkbox-field">
        <label>
          <input
            type="checkbox"
            checked={!!value.needsSubmission}
            onChange={(e) => set("needsSubmission", e.target.checked)}
          />
          需要帮客户提交
        </label>
      </div>
      <Field label="填报账号">
        <input
          autoComplete="off"
          value={value.filingAccount || ""}
          onChange={(e) => set("filingAccount", e.target.value)}
          placeholder="客户提供的填报账号"
        />
      </Field>
      <Field label="填报密码">
        <div className="credential-input">
          <input
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            value={value.filingPassword || ""}
            onChange={(e) => set("filingPassword", e.target.value)}
          />
          <button
            type="button"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? "隐藏" : "显示"}
          </button>
        </div>
      </Field>
      <Field label="客户要求 / 补正原因 / 备注" wide>
        <textarea
          rows={3}
          value={value.notes || ""}
          onChange={(e) => set("notes", e.target.value)}
        />
      </Field>
    </div>
  );
}
export function TaskForm({
  initial,
  customers,
  onClose,
  onSaved,
  notify,
}: {
  initial: Item;
  customers: Item[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [value, setValue] = useState<Item>(() =>
      initial.id
        ? {
            ...emptyTask,
            ...initial,
            intakeName: initial.intakeName ?? initial.softwareName,
          }
        : newTaskDraft(initial),
    ),
    [customerId, setCustomerId] = useState(initial.customerId || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (initial.id)
        await api(
          "/tasks/" + initial.id,
          { ...value, revision: initial.revision },
          "PATCH",
        );
      else
        await api("/tasks", {
          customerId: customerId || undefined,
          items: [value],
          imageIds: initial.imageIds || [],
        });
      await onSaved();
      notify(initial.id ? "任务已保存" : "任务已录入");
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        initial.id
          ? "编辑任务"
          : value.kind === "correction"
            ? initial.parentId
              ? "再次返工 · 建立补正任务"
              : "新增补正任务"
            : "手工录入新单"
      }
      onClose={onClose}
    >
      <div className="modal-body">
        {!initial.id && (
          <Field label="客户归属">
            <select
              disabled={!!initial.parentId}
              value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                const c = customers.find((c) => c.id === e.target.value);
                if (c)
                  setValue((v) => ({
                    ...v,
                    customerName: c.name,
                    email: c.email,
                    wechat: c.wechat,
                    memberName: c.memberName,
                  }));
              }}
            >
              <option value="">创建新客户</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.email}
                </option>
              ))}
            </select>
          </Field>
        )}
        {initial.parentId && (
          <p className="notice">
            本次返工会建立独立的补正任务并关联上一阶段，原任务会标记为返工并停止操作，历次交付记录都会保留。
          </p>
        )}
        <TaskFields value={value} onChange={setValue} />
        {error && <p className="error">{error}</p>}
      </div>
      <footer className="modal-foot">
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? <Busy label="保存中" /> : "保存任务"}
        </button>
      </footer>
    </Modal>
  );
}
function GroupContacts({
  tasks,
  onRefresh,
}: {
  tasks: Item[];
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="inline-contacts">
      {[
        ["customerName", "客户待补"],
        ["email", "双击补充邮箱"],
        ["wechat", "双击补充微信"],
      ].map(([field, placeholder]) => {
        const buckets = new Map<string, Item[]>();
        for (const task of tasks) {
          const key = String(task[field] || "");
          buckets.set(key, [...(buckets.get(key) || []), task]);
        }
        return [...buckets.entries()].map(([key, members]) => (
          <div
            key={field + key}
            className={"contact-value contact-" + field}
            title={`仅修改本组使用此内容且可操作的 ${members.filter((t) => !t.inRework && !t.cancelledAt).length} 项软件；返工历史不变`}
          >
            <InlineCell
              value={members[0][field]}
              placeholder={placeholder}
              disabled={members.every((t) => t.inRework || t.cancelledAt)}
              onSave={async (value) => {
                await api("/tasks/contact-group", {
                  targets: members
                    .filter((t) => !t.inRework && !t.cancelledAt)
                    .map((t) => ({
                      id: t.id,
                      revision: t.revision,
                    })),
                  field,
                  value,
                });
                await onRefresh();
              }}
            />
          </div>
        ));
      })}
    </div>
  );
}

function CancelCorrectionDialog({
  task,
  onClose,
  onCancelled,
}: {
  task: Item;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/tasks/" + task.id + "/cancel-correction", {
        revision: task.revision,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败，请重试。");
      setBusy(false);
      return;
    }
    onCancelled();
  }

  return (
    <dialog
      ref={dialog}
      className="modal cancel-correction-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={(e) => e.stopPropagation()}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="modal-head">
        <h2 id={titleId}>撤销补正</h2>
      </header>
      <div className="modal-body" id={descriptionId}>
        <strong>{task.softwareName || task.intakeName || "名称待定"}</strong>
        <p>撤销后会恢复原任务，补正资料和交付历史仍可查看。</p>
        {error && <p role="alert">{error}</p>}
      </div>
      <footer className="modal-foot">
        <button autoFocus disabled={busy} onClick={onClose}>取消</button>
        <button className="primary" disabled={busy} onClick={() => void confirm()}>
          {busy ? "正在撤销…" : "确认撤销"}
        </button>
      </footer>
    </dialog>
  );
}

export function TaskList({
  tasks,
  onRefresh,
  onTaskSaved,
  onNew,
  onDetail,
  onMail,
  onCorrection,
  notify,
}: {
  tasks: Item[];
  onRefresh: () => Promise<void>;
  onTaskSaved?: (task: Item) => void;
  onNew: () => void;
  onDetail: (t: Item) => void;
  onMail: (t: Item) => void;
  onCorrection: (t: Item) => void;
  notify: (s: string) => void;
}) {
  const [rowOverrides, setRowOverrides] = useState<Record<string, Item>>({});
  tasks = withReworkStatus(
    tasks.map((task) => {
      const override = rowOverrides[task.id];
      return override && override.revision >= task.revision ? override : task;
    }),
  );
  const [kind, setKind] = useState("new"),
    [state, setState] = useState("active"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(50);
  const [cancelTarget, setCancelTarget] = useState<Item | null>(null);
  const savingIds = useRef(new Set<string>());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  async function copyCopyrightPrompt(task: Item) {
    const name = task.softwareName?.trim() || task.intakeName?.trim() || "软件名称";
    const nameWithVersion = /v1\.0$/i.test(name) ? name : name + "V1.0";
    const correctionNote = task.kind === "correction" ? "\n（名称看看怎么改一下），" : "";
    const prompt = [
      "[$copyright-full-package]我现在想申请软件著作，需要你帮我编写申请相关的材料，个人申请，以下是项目背景，web端，所有信息全部由你自定，其他全部信息由你自定或者留空，完成一份合格能顺利下证的软著材料,内容设计尽量前沿点，避免模板化和重复。软著背景：",
      nameWithVersion + correctionNote,
      "（近期大量出现以下审查意见，注意规避：此申请与若干已登记或申请中的软件文档鉴别材料存在雷同或重复的情况，或者 当前项目的操作手册存在模板化程度较高，缺乏独创性，代表性等问题）",
      "在当前项目空间下创建一个软件名称的文件夹，只用放12项填报信息文档，说明书（或操作手册），再在新创建的文件夹下创建一个code文件夹放入前端文档",
    ].join("\n\n");

    await copyText(prompt, "软著提示词");
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("已复制" + label);
    } catch {
      notify("复制失败，请检查剪贴板权限后重试");
    }
  }
  const visible = tasks
    .filter(
      (t) => !t.cancelledAt || ["all", "archive", "history"].includes(state),
    )
    .filter((t) =>
      state === "archive"
        ? t.archived
        : ["all", "done", "history"].includes(state) || !t.archived,
    )
    .filter(
      (t) =>
        t.kind === kind &&
        (state === "all" ||
          state === "active" ||
          state === "archive" ||
          (state === "history" && (t.completed || t.archived)) ||
          (state === "open" && !t.completed) ||
          (state === "done" && t.completed) ||
          (state === "missing" &&
            (!t.email || !t.softwareName || !t.customerName)) ||
          (state === "submit" && t.needsSubmission)),
    )
    .filter((t) =>
      [
        t.customerName,
        t.memberName,
        t.email,
        t.wechat,
        t.softwareName,
        t.originalName,
        t.intakeName,
        t.notes,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  useEffect(() => setPage(1), [kind, state, query, pageSize]);
  const groups = groupTasks(visible);
  const [exporting, setExporting] = useState(false);
  async function exportTasks() {
    setExporting(true);
    try {
      const { downloadTasks } = await import("./task-export");
      await downloadTasks(groups.flatMap((group) => group.tasks), kind === "new" ? "新单" : "补正");
    } catch {
      notify("Excel 导出失败，请重试");
    } finally {
      setExporting(false);
    }
  }
  const customerTones = new Map<string, number>();
  const customerKey = (t: Item) => t.customerId || t.orderId || t.id;
  for (const group of groups) {
    const key = customerKey(group.tasks[0]);
    if (!customerTones.has(key)) customerTones.set(key, customerTones.size % 4);
  }
  const groupedPages = paginateTaskGroups(groups, pageSize);
  const pages = Math.max(1, groupedPages.length),
    current = Math.min(page, pages),
    pageGroups = groupedPages[current - 1] || [],
    rows = pageGroups.flatMap((group) => group.tasks);
  const dateRowSpans = new Map<string, number>();
  for (const group of pageGroups)
    dateRowSpans.set(
      JSON.stringify([group.completed, group.sortDate]),
      (dateRowSpans.get(JSON.stringify([group.completed, group.sortDate])) || 0) +
        group.tasks.length,
    );
  async function update(t: Item, key: string, v: any) {
    const saved = await api(
      "/tasks/" + t.id,
      { [key]: v, revision: t.revision },
      "PATCH",
    );
    setRowOverrides((current) => ({ ...current, [t.id]: saved }));
    if (onTaskSaved) onTaskSaved(saved);
    else await onRefresh();
  }
  async function toggleRow(
    t: Item,
    field: "completed" | "needsSubmission",
    checked: boolean,
  ) {
    if (savingIds.current.has(t.id)) return;
    savingIds.current.add(t.id);
    setSaving(new Set(savingIds.current));
    setRowOverrides((current) => ({
      ...current,
      [t.id]: {
        ...t,
        [field]: checked,
        ...(field === "completed"
          ? { completedAt: checked ? new Date().toISOString() : null }
          : {}),
      },
    }));
    try {
      const saved =
        field === "completed"
          ? await api("/tasks/" + t.id + (checked ? "/external" : "/reopen"), {
              revision: t.revision,
              ...(checked
                ? {
                    channel: "列表手动确认交付",
                    notes: "用户在任务列表勾选完成",
                  }
                : {}),
            })
          : await api(
              "/tasks/" + t.id,
              { [field]: checked, revision: t.revision },
              "PATCH",
            );
      setRowOverrides((current) => ({ ...current, [t.id]: saved }));
      onTaskSaved?.(saved);
      // Refresh delivery history in the background; the server's returned task
      // already contains the committed revision and can be edited immediately.
      if (field === "completed" || !onTaskSaved)
        void onRefresh().catch(() => {});
      notify(
        field === "completed"
          ? checked
            ? "已完成，移至未完成任务之后"
            : "已恢复为未完成"
          : "代提交标记已保存",
      );
    } catch (error: any) {
      setRowOverrides((current) => ({ ...current, [t.id]: t }));
      void onRefresh().catch(() => {});
      notify("未能保存，已恢复原状态：" + (error.message || "请重试"));
    } finally {
      savingIds.current.delete(t.id);
      setSaving(new Set(savingIds.current));
    }
  }
  const open = tasks.filter(
    (t) => !t.completed && !t.archived && !t.inRework && !t.cancelledAt,
  );
  return (
    <div className="page ledger-page compact-ledger">
      <div className="ledger-toolbar">
        <div className="tabs">
          {[
            ["new", "新单"],
            ["correction", "补正"],
          ].map(([v, label]) => (
            <button
              key={v}
              className={kind === v ? "active" : ""}
              aria-pressed={kind === v}
              onClick={() => setKind(v)}
            >
              {label}{" "}
              <span className="tab-count" title="未完成数量">
                {open.filter((t) => t.kind === v).length}
              </span>
            </button>
          ))}
        </div>
        <div className="filter-group">
          <label className="search">
            <Search size={16} />
            <input
              aria-label="搜索任务"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="客户、邮箱、原名或新名"
            />
          </label>
          <select
            aria-label="任务筛选"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="active">未归档 · 未完成优先</option>
            <option value="open">仅未完成</option>
            <option value="history">历史任务（已完成 / 已归档）</option>
            <option value="done">已完成（含归档）</option>
            <option value="all">全部状态（含归档）</option>
            <option value="missing">待补资料</option>
            <option value="submit">需要代提交</option>
            <option value="archive">已归档</option>
          </select>
          <button
            type="button"
            className="task-export-button"
            disabled={exporting || visible.length === 0}
            onClick={() => void exportTasks()}
            title="导出当前筛选结果的全部页"
          >
            <Download size={16} aria-hidden="true" />
            {exporting ? "导出中…" : "导出 Excel"}
          </button>
        </div>
      </div>
      <div className="table-scroll">
        <table className="task-table merged-task-table">
          <colgroup>
            {[9, 16, 17, 17, 16, 8, 5, 12].map((width, i) => (
              <col key={i} style={{ width: width + "%" }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th>购买日期</th>
              <th>客户 / 联系方式</th>
              <th title="客户约定的录入名称">录入名称</th>
              <th title="实际制作及交付名称">制作名称</th>
              <th>填报账号密码</th>
              <th>交付状态</th>
              <th className="submission-cell">代提交</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {pageGroups.map((group, groupIndex) => (
              <Fragment key={group.key}>
                {group.tasks.map((t, rowIndex) => (
                  <tr
                    key={t.id}
                    className={
                      "software-row row-tone-" +
                      (rowIndex % 2) +
                      " customer-tone-" +
                      customerTones.get(customerKey(t)) +
                      (rowIndex === 0 ? " customer-group-start" : "") +
                      (t.needsSubmission ? " needs-submission" : "") +
                      (t.completed ? " task-completed" : "")
                    }
                  >
                    {rowIndex === 0 &&
                      (groupIndex === 0 ||
                        pageGroups[groupIndex - 1].sortDate !== group.sortDate ||
                        pageGroups[groupIndex - 1].completed !==
                          group.completed) && (
                        <td
                          className="merged-date"
                          rowSpan={dateRowSpans.get(
                            JSON.stringify([group.completed, group.sortDate]),
                          )}
                        >
                          <span>{group.date || "日期待补"}</span>
                        </td>
                      )}
                    {rowIndex === 0 && (
                      <td
                        className="merged-customer"
                        rowSpan={group.tasks.length}
                      >
                        <GroupContacts
                          tasks={group.tasks}
                          onRefresh={onRefresh}
                        />
                        <small>{group.tasks.length} 项软件</small>
                      </td>
                    )}
                    <td className="intake-name-cell">
                      <InlineCell
                        disabled={!!(t.inRework || t.cancelledAt)}
                        value={t.intakeName ?? t.softwareName}
                        onSave={(v) => update(t, "intakeName", v)}
                        multiline
                        placeholder="待补录入名称"
                      />
                      <div className="name-copy-actions">
                        <button
                          type="button"
                          disabled={!(t.intakeName ?? t.softwareName)?.trim()}
                          onClick={() => void copyText(t.intakeName ?? t.softwareName, "录入名称")}
                          title="复制录入名称"
                        >
                          复制名称
                        </button>
                      </div>
                    </td>
                    <td className="software-cell">
                      <InlineCell
                        disabled={!!(t.inRework || t.cancelledAt)}
                        value={t.softwareName}
                        onSave={(v) => update(t, "softwareName", v)}
                        multiline
                        placeholder="名称待定"
                      />
                      {t.kind === "correction" &&
                        t.originalName &&
                        t.originalName !== (t.intakeName ?? t.softwareName) && (
                          <div className="original-name">
                            原名：
                            <InlineCell
                              disabled={!!(t.inRework || t.cancelledAt)}
                              value={t.originalName}
                              onSave={(v) => update(t, "originalName", v)}
                              multiline
                            />
                          </div>
                        )}
                      <div className="name-copy-actions">
                        <button
                          type="button"
                          disabled={!t.softwareName?.trim()}
                          onClick={() => void copyText(t.softwareName, "制作名称")}
                          title="复制制作名称"
                        >
                          复制名称
                        </button>
                        <button
                          type="button"
                          onClick={() => void copyCopyrightPrompt(t)}
                          title="复制该订单的软著材料提示词"
                        >
                          复制提示词
                        </button>
                      </div>
                    </td>
                    <td className="credential-cell">
                      <CopyrightLogin task={t} notify={notify} />
                      <div className="credential-line">
                        <span>账号</span>
                        <InlineCell
                          disabled={!!(t.inRework || t.cancelledAt)}
                          value={t.filingAccount}
                          onSave={(v) => update(t, "filingAccount", v)}
                          placeholder="双击补充"
                        />
                      </div>
                      <div className="credential-line">
                        <span>密码</span>
                        <InlineCell
                          disabled={!!(t.inRework || t.cancelledAt)}
                          value={t.filingPassword}
                          onSave={(v) => update(t, "filingPassword", v)}
                          placeholder="双击补充"
                        />
                      </div>
                    </td>
                    <td>
                      <label className="completion-toggle">
                        <span className="task-status-icon">
                          <input
                            type="checkbox"
                            aria-label={
                              "完成交付：" + (t.softwareName || "名称待定")
                            }
                            checked={!!t.completed}
                            disabled={
                              saving.has(t.id) || !!t.inRework || !!t.cancelledAt
                            }
                            onChange={(e) =>
                              void toggleRow(t, "completed", e.target.checked)
                            }
                          />
                          <Package aria-hidden="true" className="status-off" />
                          <PackageCheck aria-hidden="true" className="status-on" />
                        </span>
                        <span>
                          {saving.has(t.id)
                            ? "保存中"
                            : t.cancelledAt
                              ? "已撤销"
                              : t.inRework
                                ? "返工"
                                : t.completed
                                  ? "已完成"
                                  : "未完成"}
                        </span>
                      </label>
                      {t.completed && (
                        <small className="block muted">
                          {dateLabel(t.completedAt)}
                        </small>
                      )}
                    </td>
                    <td className="submission-cell">
                      <span className="task-status-icon submission-toggle">
                        <input
                          type="checkbox"
                          aria-label={"标记" + t.softwareName + "需要代提交"}
                          checked={!!t.needsSubmission}
                          disabled={
                            saving.has(t.id) || !!t.inRework || !!t.cancelledAt
                          }
                          onChange={(e) =>
                            void toggleRow(t, "needsSubmission", e.target.checked)
                          }
                        />
                        <Stamp aria-hidden="true" className="status-off" />
                        <ShieldCheck aria-hidden="true" className="status-on" />
                      </span>
                    </td>
                    <td>
                      <div className="row-actions task-row-actions">
                        <button
                          disabled={saving.has(t.id)}
                          onClick={() => onDetail(t)}
                          title="查看资料、历次交付与返工历史"
                        >
                          <ArrowUpRight size={16} />
                          详情
                        </button>
                        <button
                          disabled={!!(t.inRework || t.cancelledAt)}
                          onClick={() => onMail(t)}
                          className="task-mail-action"
                          title="准备交付邮件"
                        >
                          <Send size={14} />
                          {t.completed ? "重发" : "发送"}
                        </button>
                        <button
                          disabled={!!(t.inRework || t.cancelledAt)}
                          onClick={() => onCorrection(t)}
                          title="建立关联补正，保留原任务及交付历史"
                        >
                          返工
                        </button>
                        {t.kind === "correction" &&
                          t.parentId &&
                          !t.cancelledAt &&
                          !t.inRework && (
                            <button
                              disabled={saving.has(t.id)}
                              className="task-cancel-action"
                              onClick={() => setCancelTarget(t)}
                            >
                              撤销补正
                            </button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <Empty
            title={query ? "没有找到匹配的任务" : "这里还没有任务"}
            description={
              query
                ? "试试客户邮箱、软件原名或其他关键词。"
                : "上传聊天截图，或直接手工录入第一笔订单。"
            }
            action={<button onClick={onNew}>手工录入</button>}
          />
        )}
      </div>
      {cancelTarget && (
        <CancelCorrectionDialog
          task={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onCancelled={() => {
            setCancelTarget(null);
            notify("补正已撤销，原任务已恢复");
            void onRefresh().catch(() => notify("补正已撤销，请刷新列表"));
          }}
        />
      )}
      <div className="table-footer">
        <span>
          {visible.length
            ? `本页 ${pageGroups.length} 组 · ${rows.length} 项 / 共 ${groups.length} 组 · ${visible.length} 项`
            : "0 项任务"}
        </span>
        <span className="ledger-edit-hint">
          双击资料修改 · 回车保存 · Esc取消
        </span>
        <div>
          <select
            aria-label="每页软件数量"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            {[50, 100, 200].map((size) => (
              <option key={size} value={size}>
                {size} 项 / 页
              </option>
            ))}
          </select>
          <button
            disabled={current === 1}
            onClick={() => setPage((v) => v - 1)}
            aria-label="上一页"
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {current} / {pages}
          </span>
          <button
            disabled={current === pages}
            onClick={() => setPage((v) => v + 1)}
            aria-label="下一页"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
export function TaskDetail({
  task,
  tasks,
  onClose,
  onRefresh,
  onMail,
  onEdit,
  onCorrection,
  notify,
}: {
  task: Item;
  tasks: Item[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onMail: (t: Item) => void;
  onEdit: (t: Item) => void;
  onCorrection: (t: Item) => void;
  notify: (s: string) => void;
}) {
  const [data, setData] = useState<Item | null>(null),
    [history, setHistory] = useState<Item | null>(null),
    [loading, setLoading] = useState(true),
    [tab, setTab] = useState("history"),
    [external, setExternal] = useState(false),
    [channel, setChannel] = useState("闲鱼 / 微信"),
    [note, setNote] = useState(""),
    [sentAt, setSentAt] = useState(""),
    [linkOpen, setLinkOpen] = useState(false),
    [linkQuery, setLinkQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [cancelTarget, setCancelTarget] = useState<Item | null>(null);
  const loadVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError("");
    const current = () => loadVersion.current === version;
    await Promise.all([
      api("/tasks/" + task.id + "/detail")
        .then((detail) => {
          if (current()) setData(detail);
        })
        .catch((e) => {
          if (current()) setError(e.message);
        }),
      api("/tasks/" + task.id + "/history")
        .then((completeHistory) => {
          if (current()) setHistory(completeHistory);
        })
        .catch((e) => {
          if (current()) setError(e.message);
        })
        .finally(() => {
          if (current()) setLoading(false);
        }),
    ]);
  }, [task.id]);
  useEffect(() => {
    setData(null);
    setHistory(null);
    void load();
    return () => {
      loadVersion.current++;
    };
  }, [load, task.revision]);
  const t = {
    ...(data?.task || task),
    inRework: withReworkStatus(tasks).find((x) => x.id === task.id)?.inRework,
  };
  const lineage = tasks
    .filter((x) => x.projectId === t.projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  async function action(url: string, b: any) {
    setBusy(true);
    setError("");
    try {
      await api("/tasks/" + t.id + url, b);
      await onRefresh();
      await load();
      setExternal(false);
      setLinkOpen(false);
      notify("已保存");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="任务档案" onClose={onClose} wide>
      <div className="detail-title">
        <div>
          <span className={"kind " + t.kind}>
            {t.kind === "new" ? "新单" : "补正"}
          </span>
          <h3>{t.softwareName || "名称待定"}</h3>
          <p>录入名称：{t.intakeName ?? t.softwareName ?? "待补充"}</p>
          {(t.filingAccount || t.filingPassword) && (
            <p>
              填报账号：{t.filingAccount || "未填写"} · 密码
              {t.filingPassword ? "已保存，可在编辑资料中查看" : "未填写"}
            </p>
          )}
          <p>
            {t.customerName || "待补客户"} <span>·</span>{" "}
            {t.email || "邮箱待补"} <span>·</span>{" "}
            {t.needsSubmission ? "需要代提交" : "无需代提交"}
          </p>
        </div>
        <Status task={t} />
      </div>
      {t.inRework && (
        <p className="notice">
          已进入返工，请在补正页继续处理；原单保留供查看。
        </p>
      )}
      {t.kind === "correction" &&
        t.parentId &&
        !t.inRework &&
        !t.cancelledAt && (
          <button
            disabled={busy}
            onClick={() => setCancelTarget(t)}
          >
            撤销补正，恢复原任务
          </button>
        )}
      {cancelTarget && (
        <CancelCorrectionDialog
          task={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onCancelled={() => {
            setCancelTarget(null);
            onClose();
            notify("补正已撤销，原任务已恢复");
            void onRefresh().catch(() => notify("补正已撤销，请刷新列表"));
          }}
        />
      )}
      <fieldset
        className="detail-actions"
        disabled={!!(t.inRework || t.cancelledAt)}
      >
        <button onClick={() => onEdit(t)}>编辑资料</button>
        <button
          disabled={!!(t.inRework || t.cancelledAt)}
          onClick={() => onCorrection(t)}
        >
          <Plus size={15} />
          再次返工
        </button>
        {t.kind === "correction" && (
          <button onClick={() => setLinkOpen(!linkOpen)}>
            <Link2 size={15} />
            {t.parentId ? "更改原单关联" : "关联原单"}
          </button>
        )}
        <button onClick={() => setExternal(!external)}>
          <ExternalLink size={15} />
          已在外部发送
        </button>
        {t.completed && (
          <button
            disabled={busy}
            onClick={() => void action("/reopen", { revision: t.revision })}
          >
            <RotateCcw size={15} />
            重新打开
          </button>
        )}
        <button
          onClick={() =>
            void api(
              "/tasks/" + t.id,
              { archived: !t.archived, revision: t.revision },
              "PATCH",
            )
              .then(async () => {
                await onRefresh();
                onClose();
              })
              .catch((e) => setError(e.message))
          }
        >
          <Archive size={15} />
          {t.archived ? "取消归档" : "归档"}
        </button>
        <button className="primary push-right" onClick={() => onMail(t)}>
          <Send size={15} />
          准备邮件
        </button>
      </fieldset>
      {error && <p className="error padded">{error}</p>}
      {external && (
        <div className="inline-panel">
          <Field label="发送渠道">
            <input
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            />
          </Field>
          <Field label="发送时间（留空为现在）">
            <input
              type="datetime-local"
              value={sentAt}
              onChange={(e) => setSentAt(e.target.value)}
            />
          </Field>
          <Field label="交付备注">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="如：已通过微信发送完整压缩包"
            />
          </Field>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void action("/external", {
                channel,
                notes: note,
                sentAt,
                revision: t.revision,
              })
            }
          >
            记录并完成
          </button>
        </div>
      )}
      {linkOpen && (
        <div className="link-panel">
          <input
            value={linkQuery}
            onChange={(e) => setLinkQuery(e.target.value)}
            placeholder="搜索客户、邮箱或原软件名称"
          />
          <div className="link-results">
            {tasks
              .filter(
                (x) =>
                  x.id !== t.id &&
                  [x.customerName, x.email, x.softwareName, x.originalName]
                    .join(" ")
                    .includes(linkQuery),
              )
              .slice(0, 20)
              .map((x) => (
                <button
                  key={x.id}
                  onClick={() => {
                    if (
                      x.customerId !== t.customerId &&
                      !window.confirm(
                        "此原单属于另一客户，关联后会将本补正及后续补正归入该客户。继续吗？",
                      )
                    )
                      return;
                    void action("/link", {
                      parentId: x.id,
                      revision: t.revision,
                    });
                  }}
                >
                  <b>{x.softwareName || "名称待定"}</b>
                  <span>
                    {x.customerName} · {x.email}
                  </span>
                </button>
              ))}
          </div>
          {t.parentId && (
            <button
              onClick={() =>
                void action("/link", { parentId: null, revision: t.revision })
              }
            >
              解除关联
            </button>
          )}
        </div>
      )}
      <div className="tabs detail-tabs">
        {[
          ["history", "完整处理历史"],
          ["overview", "资料与历程"],
          ["sources", "来源截图"],
          ["changes", "修改记录"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className={
          "detail-content " + (tab === "sources" ? "sources-content" : "")
        }
      >
        {tab === "history" ? (
          history ? (
            <TaskHistory
              history={history}
              currentId={t.id}
              onCorrection={onCorrection}
            />
          ) : loading ? (
            <Busy label="正在读取完整历史" />
          ) : (
            <Empty
              title="历史暂时未能加载"
              description="可以重新读取，已保存的任务记录不会受影响。"
              action={<button onClick={() => void load()}>重新读取</button>}
            />
          )
        ) : tab === "sources" ? (
          <ImageViewer ids={t.imageIds || []} />
        ) : tab === "changes" ? (
          <div className="timeline">
            {data?.audits.map((a: Item) => (
              <div key={a.id} className="timeline-item">
                <small>{dateLabel(a.created_at)}</small>
                <h4>{a.action}</h4>
                <p>{changeSummary(a)}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="detail-grid">
            <section>
              <h4>当前资料</h4>
              <dl className="facts">
                <dt>会员名</dt>
                <dd>{t.memberName || "—"}</dd>
                <dt>微信 / 联系方式</dt>
                <dd>{t.wechat || "—"}</dd>
                <dt>购买日期</dt>
                <dd>{t.purchasedAt || "—"}</dd>
                <dt>成交金额</dt>
                <dd>{t.amount ? `¥ ${t.amount}` : "—"}</dd>
                <dt>原软件名称</dt>
                <dd>{t.originalName || "—"}</dd>
                <dt>创建时间</dt>
                <dd>{dateLabel(t.createdAt)}</dd>
              </dl>
              <h4>要求与备注</h4>
              <p className="note-text">{t.notes || "暂无备注"}</p>
              <h4>软件处理历程</h4>
              <div className="lineage">
                {lineage.map((x) => (
                  <div key={x.id} className={x.id === t.id ? "current" : ""}>
                    <small>
                      {x.kind === "new" ? "首次制作" : "补正"} ·{" "}
                      {dateLabel(x.createdAt)}
                    </small>
                    <strong>{x.softwareName || "名称待定"}</strong>
                    <Status task={x} />
                  </div>
                ))}
              </div>
            </section>
            <section>
              <h4>
                交付记录{" "}
                <span className="muted">{data?.deliveries.length || 0} 次</span>
              </h4>
              {!data?.deliveries.length ? (
                <Empty
                  title="尚未交付"
                  description="在系统发送邮件或记录外部发送后，这里会留下记录。"
                />
              ) : (
                <div className="timeline">
                  {data.deliveries.map((d: Item) => (
                    <div className="timeline-item" key={d.id}>
                      <small>{dateLabel(d.sentAt || d.createdAt)}</small>
                      <h4>
                        {d.status === "external"
                          ? "外部发送 · " + d.channel
                          : deliveryStatus(d.status)}
                      </h4>
                      <p>{d.subject}</p>
                      <p className="muted">{d.to}</p>
                      {d.error && <p className="error">{d.error}</p>}
                      {d.notes && <p>{d.notes}</p>}
                      {d.attachments?.map((a: Item) => (
                        <p className="file-line" key={a.id}>
                          {a.name}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </Modal>
  );
}
function historyDate(value?: string) {
  if (!value) return "时间未记录";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function historyValue(value: any, key: string, stages: Item[]) {
  if (key === "imageIds")
    return `${Array.isArray(value) ? value.length : 0} 张截图`;
  if (value === true) return "是";
  if (value === false) return "否";
  if (value === "new") return "新单";
  if (value === "correction") return "补正";
  if (key === "parentId" && value)
    return (
      stages.find((s) => s.task.id === value)?.task.softwareName ||
      "已关联的历史任务"
    );
  if (key === "customerId" && value)
    return (
      stages.find((s) => s.task.customerId === value)?.task.customerName ||
      "其他客户档案"
    );
  if (key === "completionMethod")
    return value === "external"
      ? "外部发送"
      : value === "email"
        ? "系统邮件"
        : "未交付";
  return value === null || value === undefined || value === ""
    ? "未填写"
    : String(value);
}
function TaskHistory({
  history,
  currentId,
  onCorrection,
}: {
  history: Item;
  currentId: string;
  onCorrection: (t: Item) => void;
}) {
  const stages: Item[] = history.stages || [];
  const addresses = (list: Item[] = []) =>
    list
      .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
      .join("、");
  return (
    <div className="task-history">
      <div className="history-summary">
        <strong>{history.summary.stages} 个处理阶段</strong>
        <span>{history.summary.successfulDeliveries} 次成功交付</span>
        <span>{history.summary.changes} 条修改记录</span>
        <span>{history.summary.mailMessages} 封关联邮件</span>
      </div>
      <p className="muted">
        新单、补正和多次返工按关联顺序保留。再次返工会建立新阶段；原来的发送内容和完成状态不变。
      </p>
      {stages.map((stage) => (
        <details
          key={stage.task.id}
          className="history-stage"
          open={stage.task.id === currentId}
        >
          <summary className="history-stage-head">
            <span className="history-stage-label">
              {stage.sequence}. {stage.label}
              {stage.task.id === currentId ? " · 当前查看" : ""}
            </span>
            <strong>{stage.task.softwareName || "名称待定"}</strong>
            <Status task={stage.task} />
            {stage.task.archived && <span className="muted">已归档</span>}
            <small>
              {stage.deliveries.length} 次交付记录 · {stage.audits.length}{" "}
              次记录变更
            </small>
          </summary>
          <div className="task-history-toolbar">
            <span>
              {historyDate(stage.task.createdAt)} 建立
              {stage.parentName ? ` · 上一阶段：${stage.parentName}` : ""}
            </span>
            <button
              disabled={
                !!(
                  stage.task.cancelledAt ||
                  stage.task.inRework ||
                  stages.some(
                    (x) =>
                      x.task.parentId === stage.task.id && !x.task.cancelledAt,
                  )
                )
              }
              onClick={() => onCorrection(stage.task)}
            >
              <RotateCcw size={14} />
              从此阶段再次返工
            </button>
          </div>
          <div className="detail-grid">
            <section>
              <h4>历次交付</h4>
              {!stage.deliveries.length ? (
                <p className="muted">此阶段尚无交付记录。</p>
              ) : (
                <div className="timeline">
                  {stage.deliveries.map((d: Item) => (
                    <div className="timeline-item" key={d.id}>
                      <small>{historyDate(d.sentAt || d.createdAt)}</small>
                      <h4>
                        {d.status === "external"
                          ? `外部发送 · ${d.channel}`
                          : deliveryStatus(d.status)}
                      </h4>
                      <p>
                        <b>{d.subject || "无主题"}</b>
                      </p>
                      {d.softwareName && (
                        <p className="muted">
                          发送时软件名称：{d.softwareName}
                        </p>
                      )}
                      {d.to && <p className="muted">收件人：{d.to}</p>}
                      {d.notes && <p>{d.notes}</p>}
                      {d.error && <p className="error">{d.error}</p>}
                      {d.attachments?.map((a: Item) => (
                        <p className="file-line" key={a.id || a.name}>
                          {a.name}
                        </p>
                      ))}
                      {d.html && (
                        <details>
                          <summary>查看当次发送正文</summary>
                          <MailPreview html={d.html} />
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!!stage.mailMessages?.length && (
                <>
                  <h4>
                    关联邮箱邮件 <small>完整正文可在邮箱页查看</small>
                  </h4>
                  <div className="timeline">
                    {stage.mailMessages.map((m: Item) => (
                      <div className="timeline-item" key={m.id}>
                        <small>
                          {historyDate(m.date || m.createdAt)} ·{" "}
                          {m.folder === "sent" ? "已发送" : "收到邮件"}
                        </small>
                        <h4>{m.subject || "无主题"}</h4>
                        <p className="muted">发件人：{addresses(m.from)}</p>
                        <p className="muted">收件人：{addresses(m.to)}</p>
                        <p>{m.snippet || "无正文摘要"}</p>
                        {m.remoteMissing && (
                          <small className="muted">
                            原邮箱中已移除，历史记录仍保留
                          </small>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
            <section>
              <h4>字段与状态变更</h4>
              {!stage.audits.length ? (
                <p className="muted">暂无变更记录。</p>
              ) : (
                <div className="timeline history-changes">
                  {stage.audits.map((a: Item) => (
                    <div key={a.id} className="timeline-item">
                      <small>{historyDate(a.created_at)}</small>
                      <h4>{a.action}</h4>
                      {a.changes.length ? (
                        <dl>
                          {a.changes.map((change: Item) => (
                            <div key={change.key}>
                              <dt>{change.label}</dt>
                              <dd>
                                <span>
                                  {historyValue(
                                    change.before,
                                    change.key,
                                    stages,
                                  )}
                                </span>{" "}
                                →{" "}
                                <strong>
                                  {historyValue(
                                    change.after,
                                    change.key,
                                    stages,
                                  )}
                                </strong>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p className="muted">记录信息已更新。</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </details>
      ))}
    </div>
  );
}
export function deliveryStatus(s: string) {
  return (
    (
      {
        queued: "等待发送",
        sending: "发送中",
        sent: "发送成功",
        failed: "发送失败",
        uncertain: "结果待核实",
        external: "外部已发送",
      } as Item
    )[s] || s
  );
}
function changeSummary(a: Item) {
  const before =
      typeof a.before_data === "string"
        ? JSON.parse(a.before_data)
        : a.before_data,
    after =
      typeof a.after_data === "string"
        ? JSON.parse(a.after_data)
        : a.after_data;
  if (!before) return "建立任务记录";
  const labels: Item = {
    customerName: "客户",
    email: "邮箱",
    softwareName: "制作名称",
    intakeName: "录入名称",
    originalName: "原名称",
    notes: "备注",
    needsSubmission: "代提交",
    completed: "完成状态",
    parentId: "原单关联",
    purchasedAt: "购买日期",
    amount: "金额",
    wechat: "微信",
    memberName: "会员名",
    archived: "归档",
  };
  return (
    Object.entries(labels)
      .filter(([k]) => before[k] !== after?.[k])
      .map(
        ([k, label]) =>
          `${label}：${String(before[k] ?? "空")} → ${String(after?.[k] ?? "空")}`,
      )
      .join("；") || "更新记录"
  );
}
