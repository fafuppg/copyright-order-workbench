/** Screenshot evidence never decides workflow type or original-order links. */
export function manualScreenshotChoices(payload: any, previous?: any) {
  const result = structuredClone(payload);
  delete result.customerId;
  if (previous?.customerId) result.customerId = previous.customerId;
  result.items = (result.items || []).map((item: any) => {
    const matches = (previous?.items || []).filter(
      (old: any) => old.softwareName && old.softwareName === item.softwareName,
    );
    const old =
      matches.length === 1
        ? matches[0]
        : previous?.items?.length === 1 && result.items.length === 1
          ? previous.items[0]
          : null;
    return {
      ...item,
      kind: old?.kind || "new",
      parentId: old?.parentId || null,
      needsSubmission: old?.needsSubmission || false,
    };
  });
  return result;
}
