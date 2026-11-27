if (
  ["http://127.0.0.1:3210", "http://localhost:3210"].includes(location.origin)
) {
  document.documentElement.dataset.copyrightAutofill = "1";
  document.documentElement.dataset.copyrightAutofillVersion = "1.0.1";
  window.dispatchEvent(new Event("copyright-autofill-ready"));
  window.addEventListener("copyright-autofill-request", (event) => {
    const data = event.detail;
    if (!data || typeof data.requestId !== "string") return;
    try {
      chrome.runtime.sendMessage(
        {
          type: "workbench-copyright-open",
          account: data.account,
          password: data.password,
        },
        (response) => {
          const failed = chrome.runtime.lastError;
          window.dispatchEvent(
            new CustomEvent("copyright-autofill-result", {
              detail: {
                requestId: data.requestId,
                ok: !failed && !!response?.ok,
              },
            }),
          );
        },
      );
    } catch {
      delete document.documentElement.dataset.copyrightAutofill;
      window.dispatchEvent(new Event("copyright-autofill-ready"));
      window.dispatchEvent(
        new CustomEvent("copyright-autofill-result", {
          detail: { requestId: data.requestId, ok: false },
        }),
      );
    }
  });
}
