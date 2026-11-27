import { Workbook } from "exceljs";
import { shanghaiDate } from "../shared/date";
import { dateLabel, type Item } from "./api";

export async function buildTaskWorkbook(tasks: Item[]) {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet("订单", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "购买日期", width: 15 },
    { header: "订单类型", width: 12 },
    { header: "客户", width: 22 },
    { header: "邮箱", width: 30 },
    { header: "微信", width: 20 },
    { header: "录入名称", width: 35 },
    { header: "制作名称", width: 35 },
    { header: "补正原名", width: 35 },
    { header: "交付状态", width: 14 },
    { header: "完成日期", width: 15 },
    { header: "代提交", width: 12 },
    { header: "归档", width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const task of tasks) {
    const status = task.cancelledAt ? "已撤销" : task.inRework ? "返工" : task.completed ? "已完成" : "未完成";
    sheet.addRow([
      task.purchasedAt ?? "",
      task.kind === "correction" ? "补正" : "新单",
      task.customerName ?? "",
      task.email ?? "",
      task.wechat ?? "",
      task.intakeName ?? task.softwareName ?? "",
      task.softwareName ?? "",
      task.originalName ?? "",
      status,
      task.completedAt ? dateLabel(task.completedAt) : "",
      task.needsSubmission ? "是" : "否",
      task.archived ? "是" : "否",
    ]);
  }
  sheet.autoFilter = { from: "A1", to: "L1" };
  return workbook.xlsx.writeBuffer();
}

export async function downloadTasks(tasks: Item[], label: string) {
  const data = await buildTaskWorkbook(tasks);
  const url = URL.createObjectURL(new Blob([new Uint8Array(data as ArrayBuffer)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `软著订单-${label}-${shanghaiDate()}.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
