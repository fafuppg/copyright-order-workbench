import { useEffect, useRef, useState } from "react";
import { Modal } from "./components";
import type { Item } from "./api";

export const COPYRIGHT_URL = "https://register.ccopyright.com.cn/account.html";
export function CopyrightLogin({
  task,
  notify,
}: {
  task: Item;
  notify: (message: string) => void;
}) {
  const [help, setHelp] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [extensionVersion, setExtensionVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{
    id: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ready = () => {
      const dataset =
        typeof document !== "undefined" ? document.documentElement.dataset : {};
      setInstalled(dataset.copyrightAutofill === "1");
      setExtensionVersion(dataset.copyrightAutofillVersion || "旧版");
    };
    const result = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!pending.current || detail?.requestId !== pending.current.id) return;
      clearTimeout(pending.current.timer);
      pending.current = null;
      setBusy(false);
      notify(
        detail.ok
          ? "已打开版权中心，扩展将在密码登录页预填，请核对后自行登录。"
          : "扩展未能打开登录页，请刷新重试，或直接打开并复制账号密码。",
      );
    };
    ready();
    window.addEventListener("copyright-autofill-ready", ready);
    window.addEventListener("copyright-autofill-result", result);
    return () => {
      window.removeEventListener("copyright-autofill-ready", ready);
      window.removeEventListener("copyright-autofill-result", result);
      if (pending.current) clearTimeout(pending.current.timer);
    };
  }, [notify]);
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(label + "已复制");
    } catch {
      notify("复制失败，请选中列表中的" + label + "手动复制。");
    }
  }
  return (
    <div className="copyright-login">
      <a
        href={COPYRIGHT_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          const connected =
            document.documentElement.dataset.copyrightAutofill === "1";
          setInstalled(connected);
          if (!task.filingAccount || !task.filingPassword) {
            notify(
              "这条订单尚未保存完整账号和密码，请先双击补充；本次仅打开官网。",
            );
            return;
          }
          if (!connected) {
            event.preventDefault();
            setHelp(true);
            notify(
              "未检测到扩展连接。安装后请刷新工作台，并确保工作台和扩展在同一个浏览器中。",
            );
            return;
          }
          event.preventDefault();
          if (busy) return;
          const id = crypto.randomUUID();
          setBusy(true);
          pending.current = {
            id,
            timer: setTimeout(() => {
              pending.current = null;
              setBusy(false);
              notify("扩展未响应，请刷新重试，或使用“直接打开登录页”。");
            }, 8000),
          };
          window.dispatchEvent(
            new CustomEvent("copyright-autofill-request", {
              detail: {
                requestId: id,
                account: task.filingAccount,
                password: task.filingPassword,
              },
            }),
          );
        }}
      >
        {busy ? "正在打开…" : "版权中心登录 ↗"}
      </a>
      <details className="copyright-tools">
        <summary aria-label="复制账号密码与预填设置" title="复制与预填设置">
          ⋯
        </summary>
        <div className="copyright-tools-menu">
          {task.filingAccount && (
            <button
              type="button"
              onClick={() => void copy(task.filingAccount, "账号")}
            >
              复制账号
            </button>
          )}
          {task.filingPassword && (
            <button
              type="button"
              onClick={() => void copy(task.filingPassword, "密码")}
            >
              复制密码
            </button>
          )}
          <button type="button" onClick={() => setHelp(true)}>
            {installed ? "预填说明" : "启用自动预填"}
          </button>
        </div>
      </details>
      {help && (
        <Modal title="版权中心自动预填" onClose={() => setHelp(false)}>
          <div className="modal-body">
            <p className={installed ? "notice" : "error"}>
              {installed
                ? `已连接扩展 ${extensionVersion}。请确保当前订单已保存账号和密码。`
                : "扩展未连接：安装或重新加载扩展后，请刷新本工作台；扩展必须安装在正在使用工作台的同一个浏览器中。"}
            </p>
            <p>
              安装一次浏览器扩展后，有账号和密码的订单点击登录入口即可在新标签页预填。验证码、用户类型和登录确认由您处理。
            </p>
            <ol>
              <li>
                <a href="/downloads/copyright-login.zip" download>
                  下载预填扩展 v1.0.1
                </a>
                并解压。
              </li>
              <li>
                Chrome 打开 <code>chrome://extensions</code>；Edge 打开{" "}
                <code>edge://extensions</code>。
              </li>
              <li>
                开启“开发者模式”，选择“加载已解压的扩展程序”，选中解压文件夹。
              </li>
              <li>
                已安装旧版时，请用新版文件替换原扩展文件夹内容，在扩展管理页点击“重新加载”。
              </li>
              <li>刷新工作台，再点击已保存账号密码的订单的“版权中心登录”。</li>
            </ol>
            <p>
              登录页已有内容时不会覆盖；如版权中心已经登录，请先退出当前账号。未安装扩展时，可用复制按钮填写。
            </p>
            <a href={COPYRIGHT_URL} target="_blank" rel="noopener noreferrer">
              直接打开登录页 ↗
            </a>
          </div>
        </Modal>
      )}
    </div>
  );
}
