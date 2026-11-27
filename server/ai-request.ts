/** Keep intake and management on the same explicit, non-thinking request policy. */
export async function requestAI(
  cfg: { aiBaseUrl: string; aiKey: string; aiModel: string },
  input: { max_tokens: number; system: string; messages: unknown[] },
  phase: "extraction" | "assistant",
) {
  const started = performance.now();
  let status = 0;
  try {
    const response = await fetch(
      cfg.aiBaseUrl.replace(/\/$/, "") + "/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.aiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          ...input,
          model: cfg.aiModel,
          thinking: { type: "disabled" },
        }),
        signal: AbortSignal.timeout(180000),
      },
    );
    status = response.status;
    // Include body download in duration; headers alone do not mean inference is done.
    const body: any = await response.json().catch(() => null);
    return { ok: response.ok, status, body };
  } finally {
    // No prompts, customer data, image contents, keys, or response bodies in logs.
    console.info(
      JSON.stringify({
        event: "ai_request",
        phase,
        model: cfg.aiModel,
        thinking: "disabled",
        status,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  }
}
