/** Business dates always use the user's Shanghai timezone, including in Node. */
export function shanghaiDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

/** Apply only to new-task drafts, never to existing-record edits. */
export function withNewPurchaseDate<T extends Record<string, any>>(
  input: T,
  now: Date = new Date(),
): T & { purchasedAt: string; purchaseDateDefaulted: boolean } {
  const known =
    typeof input.purchasedAt === "string" && !!input.purchasedAt.trim();
  return {
    ...input,
    purchasedAt: known ? input.purchasedAt : shanghaiDate(now),
    purchaseDateDefaulted: known ? input.purchaseDateDefaulted === true : true,
  };
}

export const purchaseDateDefaultNotice =
  "未提供明确购买日期，已默认填写今天（上海时间），这不是从截图中识别出的日期，可直接修改。";
