import {
  CircleCheck,
  ClipboardList,
  FilePlus2,
  Inbox,
  MessagesSquare,
  RotateCcw,
} from "lucide-react";
import type { Item } from "./api";

export default function Overview({
  openTasks,
  completedCount,
  onNavigate,
  onTask,
}: {
  openTasks: Item[];
  completedCount: number;
  onNavigate: (page: string) => void;
  onTask: (task: Item) => void;
}) {
  const metrics = [
    {
      label: "待办新单",
      count: openTasks.filter((task) => task.kind === "new").length,
      icon: FilePlus2,
      tone: "blue",
    },
    {
      label: "待办补正",
      count: openTasks.filter((task) => task.kind === "correction").length,
      icon: RotateCcw,
      tone: "amber",
    },
    {
      label: "已完成任务",
      count: completedCount,
      icon: CircleCheck,
      tone: "green",
    },
  ];
  const recent = [...openTasks]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  return (
    <div className="page overview">
      <section className="overview-hero" aria-labelledby="overview-title">
        <h1 id="overview-title">工作总览</h1>
        <p>查看待办新单与补正，继续处理订单和邮件。</p>
      </section>

      <section className="overview-metrics" aria-label="任务统计">
        {metrics.map(({ label, count, icon: Icon, tone }) => (
          <div className="overview-metric" key={label}>
            <span className={`overview-icon ${tone}`}>
              <Icon size={19} aria-hidden="true" />
            </span>
            <div>
              <p>{label}</p>
              <strong>{count}</strong>
            </div>
          </div>
        ))}
      </section>

      <div className="overview-columns">
        <section className="overview-panel" aria-labelledby="recent-title">
          <header>
            <h2 id="recent-title">最近待办</h2>
            <button onClick={() => onNavigate("tasks")}>查看任务</button>
          </header>
          {recent.length ? (
            <ul className="overview-tasks">
              {recent.map((task) => (
                <li key={task.id}>
                  <button onClick={() => onTask(task)}>
                    <span className="overview-icon blue">
                      <ClipboardList size={18} aria-hidden="true" />
                    </span>
                    <span className="overview-task-name">
                      <strong>
                        {task.softwareName || task.intakeName || "名称待定"}
                      </strong>
                      <small>{task.customerName || "客户待补"}</small>
                    </span>
                    <span
                      className={`overview-kind ${task.kind === "new" ? "blue" : "amber"}`}
                    >
                      {task.kind === "new" ? "新单" : "补正"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="overview-empty">暂无待办任务</div>
          )}
        </section>

        <section
          className="overview-panel overview-shortcuts"
          aria-labelledby="shortcuts-title"
        >
          <header>
            <h2 id="shortcuts-title">快捷入口</h2>
          </header>
          <button onClick={() => onNavigate("assistant")}>
            <span className="overview-icon blue">
              <MessagesSquare size={19} aria-hidden="true" />
            </span>
            <span>
              <strong>AI 助手</strong>
              <small>从截图提取订单信息</small>
            </span>
          </button>
          <button onClick={() => onNavigate("mailbox")}>
            <span className="overview-icon green">
              <Inbox size={19} aria-hidden="true" />
            </span>
            <span>
              <strong>邮箱管理</strong>
              <small>查阅客户往来邮件</small>
            </span>
          </button>
        </section>
      </div>
    </div>
  );
}
